/**
 * Mempire — "the market is the meta".
 *
 * Every epoch this workflow reads the daily price change of every fighter in
 * the roster (20 fighters, one per Chainlink Data Feed on Arc mainnet), agrees
 * on it across the DON, turns each change into a bounded strength modifier and
 * writes ONE report to MarketMeta on Arc testnet (CRE chain `arc-testnet`,
 * chain id 5042002):
 *
 *   abi.encode(uint64 epoch, uint16[] coinIds, int16[] bps)
 *
 * Arena matches snapshot MarketMeta.currentEpoch() when a player joins, and
 * both game clients apply modifierBps[epoch][coinId] deterministically, so the
 * whole match is played with the same numbers on both sides.
 *
 * The math, the clock and the encoding live in ./meta.ts (unit tested).
 *
 * Sources (each fetched by every node, then median-aggregated per coin):
 *   - CoinGecko 24h change for every fighter with a CoinGecko id (crypto,
 *     DeFi, PAXG);
 *   - Frankfurter (ECB reference rates, keyless) for the fiat fighters, latest
 *     fixing vs yesterday's, inverted because the feeds are XXX / USD.
 *
 * Arc mainnet is not a CRE chain. There, MarketMeta computes the meta itself
 * from the Chainlink Data Feeds (`MarketMeta.postFromFeeds`), so this workflow
 * refuses `arc-mainnet` at config time.
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
	frankfurterUrl,
	fxBps,
	isFiat,
	utcDate,
	zeroBps,
} from './meta'
import { ROSTER, type RosterCoin } from './roster'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Chains a config may name but CRE cannot write to. Arc mainnet has a chain
 * selector (`arc-mainnet`) yet no CRE capability DON, so a workflow pointed at
 * it would never run; say so up front instead.
 */
export const UNSUPPORTED_CHAINS: Readonly<Record<string, string>> = {
	'arc-mainnet':
		'CRE does not serve Arc mainnet: there MarketMeta computes the meta on chain from Chainlink Data Feeds (postFromFeeds), not from this workflow',
}

export const configSchema = z.object({
	/** 6-field cron (seconds first). Demo: every 10 minutes. */
	schedule: z.string(),
	/** Epoch length in seconds; epoch = floor(unixSeconds / epochSeconds). */
	epochSeconds: z.number().int().positive(),
	/** CRE chain selector name of the target chain: `arc-testnet`. */
	chainSelectorName: z
		.string()
		.refine((name) => !UNSUPPORTED_CHAINS[name], (name) => ({ message: UNSUPPORTED_CHAINS[name] })),
	/** MarketMeta on that chain. The zero address means "compute and log, don't write". */
	marketMetaAddress: z.string(),
	/** Gas limit for the forwarder → MarketMeta.onReport transaction (decimal string). */
	gasLimit: z.string().regex(/^\d+$/),
	/** CoinGecko /simple/price endpoint (keyless). */
	coingeckoBaseUrl: z.string().url(),
	/** Frankfurter API root, e.g. https://api.frankfurter.dev/v1 (keyless; ECB rates). */
	frankfurterBaseUrl: z.string().url(),
	/** Optional on-demand trigger. authorizedKeys are EVM addresses allowed to fire it. */
	httpTrigger: z.object({
		enabled: z.boolean(),
		authorizedKeys: z.array(z.string()),
	}),
})

export type Config = z.infer<typeof configSchema>

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
 * on the whole array: CoinGecko and FX answers drift between nodes (edge
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

/** Field set to 1 when both FX fixings are the same (weekend / holiday / not yet published). */
const SAME_FIXING_FIELD = 'sameFixing'

const fetchFx = (
	sendRequester: HTTPSendRequester,
	latestUrl: string,
	pastUrl: string,
	coins: readonly RosterCoin[],
): BpsByKey => {
	const headers = { accept: 'application/json' }
	const latest = sendRequester.sendRequest({ url: latestUrl, method: 'GET', headers }).result()
	if (!ok(latest)) throw new Error(`Frankfurter latest HTTP ${latest.statusCode}`)
	const past = sendRequester.sendRequest({ url: pastUrl, method: 'GET', headers }).result()
	if (!ok(past)) throw new Error(`Frankfurter previous-day HTTP ${past.statusCode}`)
	const { bps, missing, sameFixing } = fxBps(json(latest), json(past), coins)
	return { ...bps, [MISSING_FIELD]: missing.length, [SAME_FIXING_FIELD]: sameFixing ? 1 : 0 }
}

// ---------------------------------------------------------------------------
// DON-mode orchestration
// ---------------------------------------------------------------------------

/**
 * Fiat fighters: Frankfurter latest vs the fixing in force on yesterday's UTC
 * date. Never fatal: if the source fails, every fiat fighter is 0 this epoch
 * (and the log says so) — never an invented number.
 */
const fiatBps = (runtime: Runtime<Config>, http: HTTPClient, fiat: readonly RosterCoin[], nowMs: number): BpsByKey => {
	if (fiat.length === 0) return {}
	const base = runtime.config.frankfurterBaseUrl
	// Dates come from DON consensus time, so every node asks the identical question.
	const pastDate = utcDate(nowMs - 86_400_000)
	try {
		const agg = http
			.sendRequest(runtime, fetchFx, medianPerCoin(fiat, [MISSING_FIELD, SAME_FIXING_FIELD]))(
				frankfurterUrl(base, 'latest', fiat),
				frankfurterUrl(base, pastDate, fiat),
				fiat,
			)
			.result()
		const { [MISSING_FIELD]: missing, [SAME_FIXING_FIELD]: same, ...bps } = agg
		if (same >= 0.5) {
			runtime.log(
				`FX: latest ECB fixing is the one already in force on ${pastDate} (weekend/holiday/today's not yet published): ${fiat.length} fiat fighters at 0 bps`,
			)
		} else if (missing) {
			runtime.log(`FX: ${Math.round(missing)} fiat fighter(s) unpriced, written as 0 bps`)
		}
		return bps
	} catch (e) {
		runtime.log(`FX unavailable (${(e as Error).message}): ${fiat.length} fiat fighters get 0 bps this epoch`)
		return zeroBps(fiat)
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
	const cgCoins = ROSTER.filter((c) => !isFiat(c))
	const fiat = ROSTER.filter(isFiat)

	// 1. Crypto, DeFi, PAXG: one batched CoinGecko call per node, median per coin.
	//    No fallback: if the DON can't agree on crypto prices, no report is
	//    better than a report of zeros (matches keep the previous epoch).
	const cg = http
		.sendRequest(runtime, fetchCoingecko, medianPerCoin(cgCoins, [MISSING_FIELD]))(
			coingeckoUrl(cfg.coingeckoBaseUrl, cgCoins),
			cgCoins,
		)
		.result()
	const { [MISSING_FIELD]: cgMissing, ...cryptoBps } = cg
	if (cgMissing) runtime.log(`CoinGecko: ${Math.round(cgMissing)} coin(s) unpriced, written as 0 bps`)

	// 2. Fiat: Frankfurter FX, latest vs yesterday; 0 bps if unavailable.
	const fxModifiers = fiatBps(runtime, http, fiat, nowMs)

	// 3. One report, every coin, roster order.
	const report = buildReport(epoch, { ...cryptoBps, ...fxModifiers }, ROSTER)
	const encoded = encodeMetaReport(report)
	runtime.log(`modifiers: ${formatTable(report.coinIds, report.bps)}`)

	const summary = (status: string, extra: Record<string, string> = {}) =>
		JSON.stringify({ status, epoch: epoch.toString(), coins: report.coinIds.length, ...extra })

	// 4. Write — unless MarketMeta isn't deployed/configured yet.
	if (!isAddress(cfg.marketMetaAddress) || cfg.marketMetaAddress === zeroAddress) {
		runtime.log('marketMetaAddress not set: report computed but not written (set it from shared/deployments/5042002.json)')
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
