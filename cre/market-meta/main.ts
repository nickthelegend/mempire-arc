/**
 * Mempire — "the market is the meta".
 *
 * Every epoch this workflow reads the 24h price change of every fighter in
 * the roster, agrees on it across the DON, turns each change into a bounded
 * strength modifier and writes ONE report to MarketMeta on Monad:
 *
 *   abi.encode(uint64 epoch, uint16[] coinIds, int16[] bps)
 *
 * Arena matches snapshot MarketMeta.currentEpoch() when a player joins, and
 * both game clients apply modifierBps[epoch][coinId] deterministically, so the
 * whole match is played with the same numbers on both sides.
 *
 * The math, the clock and the encoding live in ./meta.ts (unit tested).
 */
import {
	bytesToHex,
	ConsensusAggregationByFields,
	CronCapability,
	EVMClient,
	encodeCallMsg,
	getNetwork,
	HTTPCapability,
	HTTPClient,
	type HTTPSendRequester,
	handler,
	json,
	LATEST_BLOCK_NUMBER,
	median,
	ok,
	prepareReportRequest,
	Runner,
	type Runtime,
	TxStatus,
	type Workflow,
} from '@chainlink/cre-sdk'
import { type Address, decodeFunctionResult, encodeFunctionData, isAddress, parseAbi, zeroAddress } from 'viem'
import { z } from 'zod'
import {
	type BpsByKey,
	buildReport,
	coinKey,
	coingeckoBps,
	coingeckoUrl,
	encodeMetaReport,
	epochFor,
	hermesUrl,
	pythBps,
	zeroBps,
} from './meta'
import { ROSTER, type RosterCoin } from './roster'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const configSchema = z.object({
	/** 6-field cron (seconds first). Demo: every 10 minutes. */
	schedule: z.string(),
	/** Epoch length in seconds; epoch = floor(unixSeconds / epochSeconds). */
	epochSeconds: z.number().int().positive(),
	/** CRE chain selector name of the target chain. */
	chainSelectorName: z.string(),
	/** MarketMeta on that chain. The zero address means "compute and log, don't write". */
	marketMetaAddress: z.string(),
	/** Gas limit for the forwarder → MarketMeta.onReport transaction (decimal string). */
	gasLimit: z.string().regex(/^\d+$/),
	coingeckoBaseUrl: z.string().url(),
	pythHermesUrl: z.string().url(),
	/** A Pyth "24h" pair spanning less than this is treated as flat (closed market). */
	pythMinWindowSeconds: z.number().int().nonnegative(),
	/** Optional on-demand trigger. authorizedKeys are EVM addresses allowed to fire it. */
	httpTrigger: z.object({
		enabled: z.boolean(),
		authorizedKeys: z.array(z.string()),
	}),
})

export type Config = z.infer<typeof configSchema>

/** Secret id declared in ../secrets.yaml. Optional: without it stocks are flat. */
export const PYTH_SECRET_ID = 'PYTH_API_KEY'

/** ReceiverContractExecutionStatus.REVERTED (not re-exported by the SDK root). */
const RECEIVER_REVERTED = 1

const MARKET_META_ABI = parseAbi(['function currentEpoch() view returns (uint64)'])

// ---------------------------------------------------------------------------
// Consensus
// ---------------------------------------------------------------------------

/**
 * One median per coin. Every node fetches the source itself and turns each
 * change into an integer bps; the DON then takes the median of each coin's
 * field independently. Why median-by-field rather than identical consensus
 * on the whole array: CoinGecko and Hermes answers drift between nodes (edge
 * caches, a print landing between two requests), so a byte-identical array
 * would routinely fail to reach quorum, while a per-coin median tolerates up
 * to f faulty or lagging nodes and still lands on an honest value. The curve
 * is monotonic, so median(bps) is the bps of the median change.
 */
const medianPerCoin = (coins: readonly RosterCoin[], extra: string[] = []) =>
	ConsensusAggregationByFields<BpsByKey>(
		Object.fromEntries([...coins.map((c) => [coinKey(c.coinId), median]), ...extra.map((k) => [k, median])]),
	)

// ---------------------------------------------------------------------------
// Node-mode fetchers (run on every node, then aggregated)
// ---------------------------------------------------------------------------

/** Field carrying how many coins the node could not price (also median-aggregated). */
const MISSING_FIELD = 'missing'

const fetchCoingecko = (sendRequester: HTTPSendRequester, url: string, coins: readonly RosterCoin[]): BpsByKey => {
	const response = sendRequester
		.sendRequest({ url, method: 'GET', headers: { accept: 'application/json' } })
		.result()
	if (!ok(response)) throw new Error(`CoinGecko HTTP ${response.statusCode}`)
	const { bps, missing } = coingeckoBps(json(response), coins)
	return { ...bps, [MISSING_FIELD]: missing.length }
}

const fetchPyth = (
	sendRequester: HTTPSendRequester,
	latestUrl: string,
	pastUrl: string,
	apiKey: string,
	coins: readonly RosterCoin[],
	minWindowSeconds: number,
): BpsByKey => {
	const headers = { accept: 'application/json', authorization: `Bearer ${apiKey}` }
	const latest = sendRequester.sendRequest({ url: latestUrl, method: 'GET', headers }).result()
	if (!ok(latest)) throw new Error(`Hermes latest HTTP ${latest.statusCode}`)
	const past = sendRequester.sendRequest({ url: pastUrl, method: 'GET', headers }).result()
	if (!ok(past)) throw new Error(`Hermes 24h-ago HTTP ${past.statusCode}`)
	const { bps, flat } = pythBps(json(latest), json(past), coins, minWindowSeconds)
	return { ...bps, [MISSING_FIELD]: flat.length }
}

// ---------------------------------------------------------------------------
// DON-mode orchestration
// ---------------------------------------------------------------------------

const readPythKey = (runtime: Runtime<Config>): string => {
	try {
		return runtime.getSecret({ id: PYTH_SECRET_ID }).result().value.trim()
	} catch {
		return ''
	}
}

const stockBps = (runtime: Runtime<Config>, http: HTTPClient, stocks: readonly RosterCoin[], nowMs: number): BpsByKey => {
	if (stocks.length === 0) return {}
	const apiKey = readPythKey(runtime)
	if (!apiKey) {
		runtime.log(`${PYTH_SECRET_ID} not configured: ${stocks.length} stocks get 0 bps this epoch`)
		return zeroBps(stocks)
	}
	const { pythHermesUrl, pythMinWindowSeconds } = runtime.config
	// The "24h ago" timestamp is computed once in DON mode (consensus time) so
	// every node asks Hermes the identical question.
	const pastTs = Math.floor(nowMs / 1000) - 86_400
	try {
		const agg = http
			.sendRequest(runtime, fetchPyth, medianPerCoin(stocks, [MISSING_FIELD]))(
				hermesUrl(pythHermesUrl, 'latest', stocks),
				hermesUrl(pythHermesUrl, pastTs, stocks),
				apiKey,
				stocks,
				pythMinWindowSeconds,
			)
			.result()
		const { [MISSING_FIELD]: flat, ...bps } = agg
		if (flat) runtime.log(`Pyth: ${Math.round(flat)} stock(s) flat (no usable 24h window, e.g. market closed)`)
		return bps
	} catch (e) {
		runtime.log(`Pyth unavailable (${(e as Error).message}): stocks get 0 bps this epoch`)
		return zeroBps(stocks)
	}
}

const readCurrentEpoch = (runtime: Runtime<Config>, evm: EVMClient, marketMeta: Address): bigint => {
	const reply = evm
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: marketMeta,
				data: encodeFunctionData({ abi: MARKET_META_ABI, functionName: 'currentEpoch' }),
			}),
			// latest, not finalized: we only use it to avoid a StaleEpoch revert
			blockNumber: LATEST_BLOCK_NUMBER,
		})
		.result()
	return decodeFunctionResult({ abi: MARKET_META_ABI, functionName: 'currentEpoch', data: bytesToHex(reply.data) })
}

const formatTable = (coinIds: number[], bps: number[]): string => {
	const ticker = new Map(ROSTER.map((c) => [c.coinId, c.ticker]))
	return coinIds.map((id, i) => `${ticker.get(id)}${bps[i] > 0 ? '+' : ''}${bps[i]}`).join(' ')
}

export const runMarketMeta = (runtime: Runtime<Config>, source: string): string => {
	const cfg = runtime.config
	const nowMs = runtime.now().getTime()
	const epoch = epochFor(nowMs, cfg.epochSeconds)
	runtime.log(`market-meta (${source}) epoch ${epoch} (${cfg.epochSeconds}s epochs)`)

	const http = new HTTPClient()
	const cryptoCoins = ROSTER.filter((c) => c.kind !== 'stock')
	const stocks = ROSTER.filter((c) => c.kind === 'stock')

	// 1. Crypto + meme: one batched CoinGecko call per node, median per coin.
	//    No fallback: if the DON can't agree on crypto prices, no report is
	//    better than a report of zeros (matches keep the previous epoch).
	const cg = http
		.sendRequest(runtime, fetchCoingecko, medianPerCoin(cryptoCoins, [MISSING_FIELD]))(
			coingeckoUrl(cfg.coingeckoBaseUrl, cryptoCoins),
			cryptoCoins,
		)
		.result()
	const { [MISSING_FIELD]: cgMissing, ...cryptoBps } = cg
	if (cgMissing) runtime.log(`CoinGecko: ${Math.round(cgMissing)} coin(s) unpriced, written as 0 bps`)

	// 2. Stocks: Pyth Hermes if a key is configured, otherwise flat.
	const equityBps = stockBps(runtime, http, stocks, nowMs)

	// 3. One report, every coin, roster order.
	const report = buildReport(epoch, { ...cryptoBps, ...equityBps }, ROSTER)
	const encoded = encodeMetaReport(report)
	runtime.log(`modifiers: ${formatTable(report.coinIds, report.bps)}`)

	const summary = (status: string, extra: Record<string, string> = {}) =>
		JSON.stringify({ status, epoch: epoch.toString(), coins: report.coinIds.length, ...extra })

	// 4. Write — unless MarketMeta isn't deployed/configured yet.
	if (!isAddress(cfg.marketMetaAddress) || cfg.marketMetaAddress === zeroAddress) {
		runtime.log('marketMetaAddress not set: report computed but not written (set it from shared/deployments/10143.json)')
		return summary('dry-run', { report: encoded })
	}
	const marketMeta = cfg.marketMetaAddress as Address

	const network = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.chainSelectorName, isTestnet: true })
	if (!network) throw new Error(`unknown chain selector name ${cfg.chainSelectorName}`)
	const evm = new EVMClient(network.chainSelector.selector)

	const current = readCurrentEpoch(runtime, evm, marketMeta)
	if (epoch <= current) {
		runtime.log(`MarketMeta already at epoch ${current}; skipping write (would revert StaleEpoch)`)
		return summary('skipped-stale', { onchainEpoch: current.toString() })
	}

	const signed = runtime.report(prepareReportRequest(encoded)).result()
	const reply = evm
		.writeReport(runtime, {
			receiver: marketMeta,
			report: signed,
			gasConfig: { gasLimit: cfg.gasLimit },
		})
		.result()

	const txHash = reply.txHash ? bytesToHex(reply.txHash) : ''
	if (reply.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`writeReport failed: ${reply.errorMessage || TxStatus[reply.txStatus]} ${txHash}`)
	}
	// The forwarder transaction can succeed while onReport itself reverted.
	if (reply.receiverContractExecutionStatus === RECEIVER_REVERTED) {
		throw new Error(`MarketMeta.onReport reverted (tx ${txHash}) — check forwarder address and epoch`)
	}
	runtime.log(`MetaPosted epoch ${epoch} → ${marketMeta} tx ${txHash}`)
	return summary('written', { txHash })
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const onCron = (runtime: Runtime<Config>): string => runMarketMeta(runtime, 'cron')
export const onHttp = (runtime: Runtime<Config>): string => runMarketMeta(runtime, 'http')

export const initWorkflow = (config: Config): Workflow<Config> => {
	const cron = handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)
	if (!config.httpTrigger.enabled) return [cron]
	return [
		cron,
		handler(
			new HTTPCapability().trigger({
				authorizedKeys: config.httpTrigger.authorizedKeys.map((publicKey) => ({
					type: 'KEY_TYPE_ECDSA_EVM' as const,
					publicKey,
				})),
			}),
			onHttp,
		),
	]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}
