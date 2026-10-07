import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, encodeAbiParameters, type Hex, parseAbiParameters } from 'viem'
import {
	BPS_PER_PERCENT,
	buildReport,
	changeToBps,
	coinKey,
	coingeckoBps,
	coingeckoUrl,
	decodeMetaReport,
	encodeMetaReport,
	epochFor,
	hermesUrl,
	MAX_BPS,
	normalizeBps,
	parseHermes,
	pythBps,
	pythChangePercent,
	zeroBps,
} from './meta'
import { ROSTER, type RosterCoin } from './roster'

describe('changeToBps: clamp(round(change% × 40), ±1500)', () => {
	test('the documented anchor: a +20% day is +800 bps', () => {
		expect(BPS_PER_PERCENT).toBe(40)
		expect(changeToBps(20)).toBe(800)
		expect(changeToBps(-20)).toBe(-800)
	})

	test('rounds to the nearest bps', () => {
		expect(changeToBps(0.8115145522087773)).toBe(32) // 32.46
		expect(changeToBps(10.942516161894385)).toBe(438) // 437.70
		expect(changeToBps(-4.896635603589029)).toBe(-196) // -195.87
		expect(changeToBps(0.01)).toBe(0) // 0.4
	})

	test('halves round away from zero, so ±x% are exact opposites', () => {
		expect(changeToBps(0.0625)).toBe(3) // 2.5
		expect(changeToBps(-0.0625)).toBe(-3) // Math.round would give -2
		expect(changeToBps(0.0125)).toBe(1) // 0.5
		expect(changeToBps(-0.0125)).toBe(-1)
		for (const x of [0.0125, 0.0625, 1.2375, 7.7, 33.3]) expect(changeToBps(-x)).toBe(-changeToBps(x))
	})

	test('clamps at ±1500 (reached at ±37.5%)', () => {
		expect(changeToBps(37.5)).toBe(MAX_BPS)
		expect(changeToBps(37.49)).toBe(1500) // 1499.6 → 1500
		expect(changeToBps(37.4)).toBe(1496)
		expect(changeToBps(250)).toBe(1500)
		expect(changeToBps(-99.9)).toBe(-1500)
		expect(changeToBps(1e12)).toBe(1500)
	})

	test('no data is neutral, never -0', () => {
		for (const x of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(changeToBps(x)).toBe(0)
		}
		expect(Object.is(changeToBps(-0.001), 0)).toBe(true)
		expect(Object.is(changeToBps(0), 0)).toBe(true)
	})

	test('normalizeBps re-integerises consensus output', () => {
		expect(normalizeBps(801.5)).toBe(802)
		expect(normalizeBps(-801.5)).toBe(-802)
		expect(normalizeBps(1600)).toBe(1500)
		expect(normalizeBps(Number.NaN)).toBe(0)
	})
})

describe('epochFor: floor(unixSeconds / 600)', () => {
	test('10-minute windows', () => {
		expect(epochFor(0)).toBe(0n)
		expect(epochFor(599_999)).toBe(0n)
		expect(epochFor(600_000)).toBe(1n)
		const t = Date.UTC(2026, 9, 5, 12, 0, 0)
		expect(epochFor(t)).toBe(BigInt(Math.floor(t / 1000 / 600)))
		expect(epochFor(t + 600_000)).toBe(epochFor(t) + 1n)
		expect(epochFor(t + 599_000)).toBe(epochFor(t))
	})

	test('hourly / daily in production', () => {
		expect(epochFor(3_600_000 * 5 + 1, 3600)).toBe(5n)
		expect(epochFor(86_400_000 * 2, 86_400)).toBe(2n)
	})

	test('rejects a bad epoch length', () => {
		expect(() => epochFor(1, 0)).toThrow()
		expect(() => epochFor(1, 1.5)).toThrow()
	})
})

const coin = (coinId: number, ticker: string, kind: RosterCoin['kind'], coingeckoId: string | null): RosterCoin => ({
	coinId,
	ticker,
	kind,
	coingeckoId,
	feedId: `0x${coinId.toString(16).padStart(64, '0')}`,
})

describe('CoinGecko parsing', () => {
	const coins = [coin(0, 'BTC', 'crypto', 'bitcoin'), coin(12, 'BONK', 'meme', 'bonk'), coin(3, 'MON', 'crypto', 'monad')]

	test('one batched, sorted, de-duplicated URL', () => {
		expect(coingeckoUrl('https://api.coingecko.com/api/v3/simple/price', [...coins, coins[0]])).toBe(
			'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,bonk,monad&vs_currencies=usd&include_24hr_change=true',
		)
	})

	test('maps usd_24h_change to bps; a missing coin is 0 and reported', () => {
		const { bps, missing } = coingeckoBps(
			{
				bitcoin: { usd: 85853, usd_24h_change: 0.8115145522087773 },
				bonk: { usd: 4.01e-6, usd_24h_change: 46 },
				// monad absent
			},
			coins,
		)
		expect(bps).toEqual({ c0: 32, c12: 1500, c3: 0 })
		expect(missing).toEqual(['MON'])
	})

	test('garbage body → every coin 0, all missing', () => {
		expect(coingeckoBps('nope', coins)).toEqual({ bps: { c0: 0, c12: 0, c3: 0 }, missing: ['BTC', 'BONK', 'MON'] })
		expect(coingeckoBps({ bitcoin: { usd_24h_change: 'x' } }, coins).missing).toContain('BTC')
	})
})

describe('Pyth Hermes parsing', () => {
	const aapl = coin(24, 'AAPL', 'stock', null)
	const tsla = coin(25, 'TSLA', 'stock', null)
	const now = 1_790_000_000
	const hermes = (rows: Array<[RosterCoin, string, number, number]>) => ({
		binary: { encoding: 'base64', data: ['AAAA'] },
		parsed: rows.map(([c, price, expo, publish_time]) => ({
			id: c.feedId.slice(2), // Hermes returns ids without 0x
			price: { price, conf: '1', expo, publish_time },
			ema_price: { price, conf: '1', expo, publish_time },
		})),
	})

	test('URLs hit /v2/updates/price/latest and /v2/updates/price/<ts>', () => {
		expect(hermesUrl('https://pyth.dourolabs.app/hermes', 'latest', [aapl])).toBe(
			`https://pyth.dourolabs.app/hermes/v2/updates/price/latest?ids[]=${aapl.feedId}&parsed=true&encoding=base64`,
		)
		expect(hermesUrl('https://pyth.dourolabs.app/hermes', now - 86_400, [aapl, tsla])).toContain(
			`/v2/updates/price/${now - 86_400}?ids[]=${aapl.feedId}&ids[]=${tsla.feedId}&`,
		)
	})

	test('parseHermes normalises ids to lowercase 0x', () => {
		const m = parseHermes(hermes([[aapl, '25000000000', -8, now]]))
		expect(m.get(aapl.feedId)).toEqual({ price: 25_000_000_000n, expo: -8, publishTime: now })
		expect(parseHermes({}).size).toBe(0)
		expect(parseHermes(null).size).toBe(0)
	})

	test('change is exact integer math', () => {
		const latest = { price: 22_000_000_000n, expo: -8, publishTime: now }
		const past = { price: 20_000_000_000n, expo: -8, publishTime: now - 86_400 }
		expect(pythChangePercent(latest, past, 3600)).toBe(10)
		expect(pythChangePercent(past, latest, 3600)).toBe(null) // past is after latest
		// differing exponents are reconciled
		expect(pythChangePercent({ ...latest, price: 220_000_000n, expo: -6 }, past, 3600)).toBe(10)
	})

	test('a closed market (window too short) or a bad price is flat', () => {
		const latest = { price: 22_000_000_000n, expo: -8, publishTime: now }
		expect(pythChangePercent(latest, { ...latest, publishTime: now - 60 }, 3600)).toBe(null)
		expect(pythChangePercent(latest, { price: 0n, expo: -8, publishTime: now - 86_400 }, 3600)).toBe(null)
		expect(pythChangePercent(latest, undefined, 3600)).toBe(null)
	})

	test('pythBps end to end', () => {
		const { bps, flat } = pythBps(
			hermes([
				[aapl, '20500000000', -8, now],
				[tsla, '43000000000', -8, now],
			]),
			hermes([
				[aapl, '20000000000', -8, now - 86_400],
				[tsla, '43000000000', -8, now - 30], // closed: no usable window
			]),
			[aapl, tsla],
			3600,
		)
		expect(bps).toEqual({ c24: 100, c25: 0 }) // +2.5% → +100
		expect(flat).toEqual(['TSLA'])
	})

	test('zeroBps covers every coin', () => {
		expect(zeroBps([aapl, tsla])).toEqual({ c24: 0, c25: 0 })
	})
})

describe('report encoding: abi.encode(uint64, uint16[], int16[])', () => {
	const solidityTypes = parseAbiParameters('uint64, uint16[], int16[]')

	test('round-trips through viem decodeAbiParameters with the exact Solidity types', () => {
		const report = { epoch: 2_983_333n, coinIds: [0, 1, 2, 35], bps: [800, -1200, 0, 1500] }
		const encoded = encodeMetaReport(report)
		const [epoch, coinIds, bps] = decodeAbiParameters(solidityTypes, encoded)
		expect(epoch).toBe(2_983_333n)
		expect([...coinIds]).toEqual([0, 1, 2, 35])
		expect([...bps]).toEqual([800, -1200, 0, 1500])
		expect(decodeMetaReport(encoded)).toEqual(report)
	})

	test('is byte-identical to an independent encode of the same tuple', () => {
		const encoded = encodeMetaReport({ epoch: 7n, coinIds: [0, 5], bps: [800, -1200] })
		expect(encoded).toBe(encodeAbiParameters(solidityTypes, [7n, [0, 5], [800, -1200]]))
	})

	test('golden bytes: what Solidity abi.encode(uint64(1), [0,5], [800,-1200]) produces', () => {
		const word = (hex: string) => hex.padStart(64, '0')
		const neg = (n: number) => (2n ** 256n + BigInt(n)).toString(16) // two's complement, 256-bit
		const expected = `0x${[
			word('1'), // epoch
			word('60'), // offset of coinIds = 3 words
			word('c0'), // offset of bps = 3 + 1 + 2 words
			word('2'),
			word('0'),
			word('5'),
			word('2'),
			word((800).toString(16)),
			neg(-1200),
		].join('')}` as Hex
		expect(encodeMetaReport({ epoch: 1n, coinIds: [0, 5], bps: [800, -1200] })).toBe(expected)
	})

	test('rejects exactly what MarketMeta.onReport would revert on', () => {
		const ok = { epoch: 1n, coinIds: [0], bps: [0] }
		expect(() => encodeMetaReport({ ...ok, bps: [1501] })).toThrow() // OutOfBounds
		expect(() => encodeMetaReport({ ...ok, bps: [-1501] })).toThrow()
		expect(() => encodeMetaReport({ ...ok, bps: [0, 0] })).toThrow() // LengthMismatch
		expect(() => encodeMetaReport({ ...ok, epoch: 0n })).toThrow() // can never beat currentEpoch 0
		expect(() => encodeMetaReport({ ...ok, epoch: 2n ** 64n })).toThrow()
		expect(() => encodeMetaReport({ ...ok, coinIds: [65_536] })).toThrow()
		expect(() => encodeMetaReport({ ...ok, bps: [1.5] })).toThrow()
		expect(() => encodeMetaReport({ ...ok, bps: [MAX_BPS] })).not.toThrow()
	})

	test('buildReport lays out the whole roster in coinId order, filling gaps with 0', () => {
		const r = buildReport(9n, { [coinKey(0)]: 800, [coinKey(35)]: -1600, [coinKey(3)]: 12.5 }, ROSTER)
		expect(r.coinIds).toEqual(ROSTER.map((c) => c.coinId).sort((a, b) => a - b))
		expect(r.coinIds.length).toBe(36)
		expect(r.bps[0]).toBe(800)
		expect(r.bps[3]).toBe(13)
		expect(r.bps[35]).toBe(-1500)
		expect(r.bps.filter((b) => b !== 0).length).toBe(3)
		expect(decodeMetaReport(encodeMetaReport(r))).toEqual(r)
	})
})
