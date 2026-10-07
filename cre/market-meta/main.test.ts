/**
 * Handler tests against the SDK's capability mocks: the whole cron path
 * (CoinGecko + Frankfurter FX → consensus → report → MarketMeta) without a DON
 * and without the network (recorded fixtures only).
 */
import { describe, expect } from 'bun:test'
import { EvmMock, HttpActionsMock, newTestRuntime, REPORT_METADATA_HEADER_LENGTH, test } from '@chainlink/cre-sdk/test'
import { bytesToHex, encodeFunctionResult, type Hex, parseAbi } from 'viem'
import type { Runtime } from '@chainlink/cre-sdk'
import { getNetwork } from '@chainlink/cre-sdk'
import {
	coingeckoBody,
	FX_2026_10_04_SUNDAY,
	FX_2026_10_06,
	FX_EXPECTED_BPS_2026_10_07,
	FX_LATEST_2026_10_07,
} from './fixtures'
import { type Config, configSchema, initWorkflow, onCron as onCronTyped } from './main'
import { decodeMetaReport, epochFor, isFiat } from './meta'
import { ROSTER } from './roster'

/** CRE chain selector of `arc-testnet` (chain id 5042002). */
const ARC_TESTNET = 3034092155422581607n
const MARKET_META = '0x1111111111111111111111111111111111111111'
/** Wednesday 2026-10-07 15:03 UTC: after that day's ECB fixing. */
const NOW = Date.UTC(2026, 9, 7, 15, 3, 0)
/** Sunday 2026-10-04 12:00 UTC: no fixing since Friday. */
const SUNDAY = Date.UTC(2026, 9, 4, 12, 0, 0)
const FX_BASE = 'https://api.frankfurter.dev/v1'
const FX_CODES = 'AUD,BRL,CAD,EUR,JPY,KRW,MXN'

const baseConfig: Config = {
	schedule: '0 */10 * * * *',
	epochSeconds: 600,
	chainSelectorName: 'arc-testnet',
	marketMetaAddress: MARKET_META,
	gasLimit: '1500000',
	coingeckoBaseUrl: 'https://api.coingecko.com/api/v3/simple/price',
	frankfurterBaseUrl: FX_BASE,
	httpTrigger: { enabled: false, authorizedKeys: [] },
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const jsonBody = (v: unknown) => b64(new TextEncoder().encode(JSON.stringify(v)))
const reply = (statusCode: number, v: unknown = {}) => ({ statusCode, headers: {}, body: jsonBody(v) })

// TestRuntime<unknown> implements Runtime<C>; the cast only restores the config type.
const onCron = (runtime: unknown) => onCronTyped(runtime as Runtime<Config>)

/** Every CoinGecko-priced fighter moves +(coinId)%; BTC (coinId 0) is flat; HYPE is missing. */
const coingeckoFixture = () =>
	coingeckoBody(
		Object.fromEntries(
			ROSTER.filter((c) => !isFiat(c) && c.ticker !== 'HYPE').map((c) => [c.coingeckoId as string, c.coinId]),
		),
	)

type Seen = { urls: string[]; headers: Array<Record<string, string>> }
/** `fx` maps the path after /v1/ ('latest' or a date) to a [status, body] reply. */
const mockHttp = (seen: Seen, fx: Record<string, [number, unknown]> = defaultFx) => {
	const http = HttpActionsMock.testInstance()
	http.sendRequest = (req) => {
		seen.urls.push(req.url)
		seen.headers.push({ ...(req.headers ?? {}) })
		if (req.url.startsWith(baseConfig.coingeckoBaseUrl)) return reply(200, coingeckoFixture())
		if (req.url.startsWith(`${FX_BASE}/`)) {
			const when = req.url.slice(FX_BASE.length + 1).split('?')[0]
			const hit = fx[when]
			return hit ? reply(hit[0], hit[1]) : reply(404, { message: 'not found' })
		}
		return reply(404)
	}
	return http
}
const defaultFx: Record<string, [number, unknown]> = {
	latest: [200, FX_LATEST_2026_10_07],
	'2026-10-06': [200, FX_2026_10_06],
}
const newSeen = (): Seen => ({ urls: [], headers: [] })

const currentEpochReturn = (epoch: bigint) =>
	b64(
		Buffer.from(
			encodeFunctionResult({
				abi: parseAbi(['function currentEpoch() view returns (uint64)']),
				functionName: 'currentEpoch',
				result: epoch,
			}).slice(2),
			'hex',
		),
	)

type Written = { receiver: Hex; payload: Hex; gasLimit: bigint }
const mockEvm = (onchainEpoch: bigint, written: Written[]) => {
	const evm = EvmMock.testInstance(ARC_TESTNET)
	evm.callContract = () => ({ data: currentEpochReturn(onchainEpoch) })
	evm.writeReport = (req) => {
		const raw = req.report?.rawReport ?? new Uint8Array()
		written.push({
			receiver: bytesToHex(req.receiver),
			payload: bytesToHex(raw.slice(REPORT_METADATA_HEADER_LENGTH)),
			gasLimit: req.gasConfig?.gasLimit ?? 0n,
		})
		return { txStatus: 'TX_STATUS_SUCCESS', txHash: b64(new Uint8Array(32).fill(0xab)) }
	}
	return evm
}

const runtimeWith = (config: Config, now = NOW) => {
	const runtime = newTestRuntime(null, { timeProvider: () => now })
	runtime.config = config
	return runtime
}

const byTicker = (bps: number[]) => Object.fromEntries(ROSTER.map((c) => [c.ticker, bps[c.coinId]]))
const fiatTickers = ROSTER.filter(isFiat).map((c) => c.ticker)

describe('market-meta cron handler', () => {
	test('weekday: CoinGecko for crypto/DeFi/PAXG, Frankfurter for fiat, one report to MarketMeta', () => {
		const seen = newSeen()
		const written: Written[] = []
		mockHttp(seen)
		mockEvm(0n, written)
		const runtime = runtimeWith(baseConfig)

		const out = JSON.parse(onCron(runtime))

		expect(out.status).toBe('written')
		// one batched CoinGecko call, then FX latest + FX as of yesterday (UTC); no keys anywhere
		expect(seen.urls.length).toBe(3)
		expect(seen.urls[0]).toContain('include_24hr_change=true')
		expect(seen.urls[0]).toContain('pax-gold')
		expect(seen.urls.slice(1)).toEqual([
			`${FX_BASE}/latest?from=USD&to=${FX_CODES}`,
			`${FX_BASE}/2026-10-06?from=USD&to=${FX_CODES}`,
		])
		for (const h of seen.headers) expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('authorization')

		expect(written.length).toBe(1)
		expect(written[0].receiver.toLowerCase()).toBe(MARKET_META)
		expect(written[0].gasLimit).toBe(1_500_000n)

		const report = decodeMetaReport(written[0].payload)
		expect(report.epoch).toBe(epochFor(NOW, 600))
		expect(report.coinIds).toEqual([...Array(20).keys()])
		const t = byTicker(report.bps)
		expect(t.BTC).toBe(0) // +0%
		expect(t.ETH).toBe(40) // +1%
		expect(t.LINK).toBe(360) // +9%
		expect(t.AAVE).toBe(440) // +11%
		expect(t.PAXG).toBe(480) // +12%
		expect(t.HYPE).toBe(0) // missing from CoinGecko
		for (const ticker of fiatTickers) expect(t[ticker]).toBe(FX_EXPECTED_BPS_2026_10_07[ticker])
		expect(runtime.getLogs().join('\n')).toContain('CoinGecko: 1 coin(s) unpriced')
	})

	test('weekend: Frankfurter answers Friday on both sides, so every fiat fighter is 0 (and logged)', () => {
		const seen = newSeen()
		const written: Written[] = []
		mockHttp(seen, { latest: [200, FX_2026_10_04_SUNDAY], '2026-10-03': [200, FX_2026_10_04_SUNDAY] })
		mockEvm(0n, written)
		const runtime = runtimeWith(baseConfig, SUNDAY)

		expect(JSON.parse(onCron(runtime)).status).toBe('written')
		expect(seen.urls).toContain(`${FX_BASE}/2026-10-03?from=USD&to=${FX_CODES}`)
		const t = byTicker(decodeMetaReport(written[0].payload).bps)
		for (const ticker of fiatTickers) expect(t[ticker]).toBe(0)
		expect(t.ETH).toBe(40) // crypto unaffected
		expect(runtime.getLogs().join('\n')).toContain('weekend/holiday')
	})

	test('FX source down: fiat fighters get 0 bps (logged), the rest of the report still goes out', () => {
		const written: Written[] = []
		mockHttp(newSeen(), { latest: [503, {}], '2026-10-06': [503, {}] })
		mockEvm(0n, written)
		const runtime = runtimeWith(baseConfig)

		expect(JSON.parse(onCron(runtime)).status).toBe('written')
		const t = byTicker(decodeMetaReport(written[0].payload).bps)
		for (const ticker of fiatTickers) expect(t[ticker]).toBe(0)
		expect(t.ETH).toBe(40)
		expect(runtime.getLogs().join('\n')).toContain('FX unavailable (Frankfurter latest HTTP 503): 7 fiat fighters get 0 bps')
	})

	test('FX answers with an unexpected shape: fiat 0, never an invented number', () => {
		const written: Written[] = []
		mockHttp(newSeen(), { latest: [200, { message: 'hello' }], '2026-10-06': [200, FX_2026_10_06] })
		mockEvm(0n, written)
		const runtime = runtimeWith(baseConfig)

		onCron(runtime)
		const t = byTicker(decodeMetaReport(written[0].payload).bps)
		for (const ticker of fiatTickers) expect(t[ticker]).toBe(0)
		expect(runtime.getLogs().join('\n')).toContain('FX unavailable')
	})

	test('skips the write when MarketMeta is already at this epoch (no StaleEpoch revert)', () => {
		const written: Written[] = []
		mockHttp(newSeen())
		mockEvm(epochFor(NOW, 600), written)
		const out = JSON.parse(onCron(runtimeWith(baseConfig)))
		expect(out.status).toBe('skipped-stale')
		expect(written.length).toBe(0)
	})

	test('zero marketMetaAddress: computes and returns the report, writes nothing', () => {
		const written: Written[] = []
		mockHttp(newSeen())
		mockEvm(0n, written)
		const out = JSON.parse(
			onCron(runtimeWith({ ...baseConfig, marketMetaAddress: '0x0000000000000000000000000000000000000000' })),
		)
		expect(out.status).toBe('dry-run')
		expect(decodeMetaReport(out.report).coinIds.length).toBe(20)
		expect(written.length).toBe(0)
	})

	test('CoinGecko down: no report at all (never a report of zeros)', () => {
		const http = HttpActionsMock.testInstance()
		http.sendRequest = () => ({ statusCode: 429, headers: {}, body: '' })
		const written: Written[] = []
		mockEvm(0n, written)
		expect(() => onCron(runtimeWith(baseConfig))).toThrow('CoinGecko HTTP 429')
		expect(written.length).toBe(0)
	})

	test('a reverted onReport is surfaced as a failure', () => {
		mockHttp(newSeen())
		const evm = mockEvm(0n, [])
		evm.writeReport = () => ({
			txStatus: 'TX_STATUS_SUCCESS',
			receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED',
		})
		expect(() => onCron(runtimeWith(baseConfig))).toThrow('MarketMeta.onReport reverted')
	})
})

describe('initWorkflow', () => {
	test('cron only by default; adds the HTTP trigger when enabled', () => {
		expect(initWorkflow(baseConfig)).toHaveLength(1)
		const both = initWorkflow({
			...baseConfig,
			httpTrigger: { enabled: true, authorizedKeys: ['0x2222222222222222222222222222222222222222'] },
		})
		expect(both).toHaveLength(2)
	})
})

describe('Arc targets', () => {
	test('arc-testnet resolves to chain 5042002 and the selector the EVM mock listens on', () => {
		const network = getNetwork({ chainFamily: 'evm', chainSelectorName: 'arc-testnet', isTestnet: true })
		expect(network?.chainId).toBe('5042002')
		expect(network?.chainSelector.selector).toBe(ARC_TESTNET)
	})

	test('both shipped configs target arc-testnet, pass the schema and carry no Pyth settings', async () => {
		for (const file of ['config.staging.json', 'config.production.json']) {
			const raw = await Bun.file(`${import.meta.dir}/${file}`).text()
			const cfg = configSchema.parse(JSON.parse(raw))
			expect(cfg.chainSelectorName).toBe('arc-testnet')
			expect(cfg.frankfurterBaseUrl).toBe(FX_BASE)
			expect(raw.toLowerCase()).not.toContain('pyth')
		}
	})

	test('arc-mainnet is refused: CRE does not serve it, postFromFeeds computes the meta there', () => {
		const r = configSchema.safeParse({ ...baseConfig, chainSelectorName: 'arc-mainnet' })
		expect(r.success).toBe(false)
		expect(r.error?.issues[0]?.message).toContain('postFromFeeds')
	})
})
