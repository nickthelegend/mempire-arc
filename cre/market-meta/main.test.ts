/**
 * Handler tests against the SDK's capability mocks: the whole cron path
 * (CoinGecko → [Pyth] → consensus → report → MarketMeta) without a DON.
 */
import { describe, expect } from 'bun:test'
import { EvmMock, HttpActionsMock, newTestRuntime, REPORT_METADATA_HEADER_LENGTH, test } from '@chainlink/cre-sdk/test'
import { bytesToHex, encodeFunctionResult, type Hex, parseAbi } from 'viem'
import type { Runtime } from '@chainlink/cre-sdk'
import { type Config, initWorkflow, onCron as onCronTyped, PYTH_SECRET_ID } from './main'
import { decodeMetaReport, epochFor } from './meta'
import { ROSTER } from './roster'

const MONAD_TESTNET = 2183018362218727504n
const MARKET_META = '0x1111111111111111111111111111111111111111'
const NOW = Date.UTC(2026, 9, 5, 12, 3, 0)

const baseConfig: Config = {
	schedule: '0 */10 * * * *',
	epochSeconds: 600,
	chainSelectorName: 'monad-testnet',
	marketMetaAddress: MARKET_META,
	gasLimit: '1500000',
	coingeckoBaseUrl: 'https://api.coingecko.com/api/v3/simple/price',
	pythHermesUrl: 'https://pyth.dourolabs.app/hermes',
	pythMinWindowSeconds: 3600,
	httpTrigger: { enabled: false, authorizedKeys: [] },
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const jsonBody = (v: unknown) => b64(new TextEncoder().encode(JSON.stringify(v)))

// TestRuntime<unknown> implements Runtime<C>; the cast only restores the config type.
const onCron = (runtime: unknown) => onCronTyped(runtime as Runtime<Config>)

/** Every crypto/meme coin moves +(coinId)%; BTC (coinId 0) is flat; MON is missing. */
const coingeckoFixture = () =>
	Object.fromEntries(
		ROSTER.filter((c) => c.kind !== 'stock' && c.ticker !== 'MON').map((c) => [
			c.coingeckoId,
			{ usd: 1, usd_24h_change: c.coinId },
		]),
	)

/** Every stock is +2.5% over a full 24h window. */
const hermesFixture = (past: boolean) => {
	const t = Math.floor(NOW / 1000)
	return {
		binary: { encoding: 'base64', data: [] },
		parsed: ROSTER.filter((c) => c.kind === 'stock').map((c) => ({
			id: c.feedId.slice(2),
			price: { price: past ? '20000000000' : '20500000000', conf: '1', expo: -8, publish_time: past ? t - 86_400 : t },
		})),
	}
}

type Seen = { urls: string[]; auth: string[] }
const mockHttp = (seen: Seen) => {
	const http = HttpActionsMock.testInstance()
	http.sendRequest = (req) => {
		seen.urls.push(req.url)
		const auth = req.headers?.authorization
		if (auth) seen.auth.push(auth)
		if (req.url.startsWith(baseConfig.coingeckoBaseUrl)) return { statusCode: 200, headers: {}, body: jsonBody(coingeckoFixture()) }
		if (req.url.includes('/v2/updates/price/latest')) return { statusCode: 200, headers: {}, body: jsonBody(hermesFixture(false)) }
		if (req.url.includes('/v2/updates/price/')) return { statusCode: 200, headers: {}, body: jsonBody(hermesFixture(true)) }
		return { statusCode: 404, headers: {}, body: '' }
	}
	return http
}

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
	const evm = EvmMock.testInstance(MONAD_TESTNET)
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

const runtimeWith = (config: Config, pythKey?: string) => {
	const secrets = pythKey === undefined ? null : new Map([['main', new Map([[PYTH_SECRET_ID, pythKey]])]]) // 'main' = the SDK's default secret namespace
	const runtime = newTestRuntime(secrets, { timeProvider: () => NOW })
	runtime.config = config
	return runtime
}

describe('market-meta cron handler', () => {
	test('no Pyth key: crypto from CoinGecko, stocks flat, one report written to MarketMeta', () => {
		const seen: Seen = { urls: [], auth: [] }
		const written: Written[] = []
		mockHttp(seen)
		mockEvm(0n, written)
		const runtime = runtimeWith(baseConfig)

		const out = JSON.parse(onCron(runtime))

		expect(out.status).toBe('written')
		expect(seen.urls.length).toBe(1) // one batched CoinGecko call, no Pyth
		expect(seen.urls[0]).toContain('include_24hr_change=true')
		expect(runtime.getLogs().join('\n')).toContain('PYTH_API_KEY not configured: 12 stocks get 0 bps')

		expect(written.length).toBe(1)
		expect(written[0].receiver.toLowerCase()).toBe(MARKET_META)
		expect(written[0].gasLimit).toBe(1_500_000n)

		const report = decodeMetaReport(written[0].payload)
		expect(report.epoch).toBe(epochFor(NOW, 600))
		expect(report.coinIds).toEqual([...Array(36).keys()])
		const byTicker = Object.fromEntries(ROSTER.map((c) => [c.ticker, report.bps[c.coinId]]))
		expect(byTicker.BTC).toBe(0) // +0%
		expect(byTicker.ETH).toBe(40) // +1%
		expect(byTicker.ADA).toBe(440) // +11%
		expect(byTicker.BOME).toBe(920) // +23%
		expect(byTicker.MON).toBe(0) // missing from CoinGecko
		for (const c of ROSTER.filter((c) => c.kind === 'stock')) expect(byTicker[c.ticker]).toBe(0)
	})

	test('with a Pyth key: stocks priced from Hermes latest vs 24h ago, Bearer auth', () => {
		const seen: Seen = { urls: [], auth: [] }
		const written: Written[] = []
		mockHttp(seen)
		mockEvm(0n, written)
		const runtime = runtimeWith(baseConfig, 'test-key')

		expect(JSON.parse(onCron(runtime)).status).toBe('written')

		const pastTs = Math.floor(NOW / 1000) - 86_400
		expect(seen.urls.some((u) => u.startsWith('https://pyth.dourolabs.app/hermes/v2/updates/price/latest?'))).toBe(true)
		expect(seen.urls.some((u) => u.startsWith(`https://pyth.dourolabs.app/hermes/v2/updates/price/${pastTs}?`))).toBe(true)
		expect(seen.auth).toEqual(['Bearer test-key', 'Bearer test-key'])

		const report = decodeMetaReport(written[0].payload)
		for (const c of ROSTER.filter((c) => c.kind === 'stock')) expect(report.bps[c.coinId]).toBe(100) // +2.5%
	})

	test('an empty Pyth key is the same as none', () => {
		const seen: Seen = { urls: [], auth: [] }
		mockHttp(seen)
		mockEvm(0n, [])
		const runtime = runtimeWith(baseConfig, '  ')
		onCron(runtime)
		expect(seen.urls.length).toBe(1)
	})

	test('skips the write when MarketMeta is already at this epoch (no StaleEpoch revert)', () => {
		const written: Written[] = []
		mockHttp({ urls: [], auth: [] })
		mockEvm(epochFor(NOW, 600), written)
		const out = JSON.parse(onCron(runtimeWith(baseConfig)))
		expect(out.status).toBe('skipped-stale')
		expect(written.length).toBe(0)
	})

	test('zero marketMetaAddress: computes and returns the report, writes nothing', () => {
		const written: Written[] = []
		mockHttp({ urls: [], auth: [] })
		mockEvm(0n, written)
		const out = JSON.parse(
			onCron(runtimeWith({ ...baseConfig, marketMetaAddress: '0x0000000000000000000000000000000000000000' })),
		)
		expect(out.status).toBe('dry-run')
		expect(decodeMetaReport(out.report).coinIds.length).toBe(36)
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
		mockHttp({ urls: [], auth: [] })
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
