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
	fiatCurrency,
	frankfurterUrl,
	fxBps,
	fxChangePercent,
	isFiat,
	MAX_BPS,
	normalizeBps,
	parseFrankfurter,
	utcDate,
	zeroBps,
} from './meta'
import { ROSTER, type RosterCoin } from './roster'
import { FX_2026_10_04_SUNDAY, FX_2026_10_06, FX_EXPECTED_BPS_2026_10_07, FX_LATEST_2026_10_07 } from './fixtures'

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
	pair: `${ticker} / USD`,
	coingeckoId,
	feedId: `0x${coinId.toString(16).padStart(64, '0')}`,
})

describe('CoinGecko parsing', () => {
	const coins = [coin(0, 'BTC', 'crypto', 'bitcoin'), coin(9, 'LINK', 'defi', 'chainlink'), coin(12, 'PAXG', 'rwa', 'pax-gold')]

	test('one batched, sorted, de-duplicated URL', () => {
		expect(coingeckoUrl('https://api.coingecko.com/api/v3/simple/price', [...coins, coins[0]])).toBe(
			'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,chainlink,pax-gold&vs_currencies=usd&include_24hr_change=true',
		)
	})

	test('the real roster: 13 CoinGecko ids (crypto, DeFi, PAXG), no fiat', () => {
		const url = coingeckoUrl('https://x/simple/price', ROSTER.filter((c) => !isFiat(c)))
		expect(url).toBe(
			'https://x/simple/price?ids=aave,avalanche-2,binancecoin,bitcoin,bitcoin-cash,chainlink,ethereum,hyperliquid,pax-gold,ripple,solana,tron,uniswap&vs_currencies=usd&include_24hr_change=true',
		)
	})

	test('maps usd_24h_change to bps; a missing coin is 0 and reported', () => {
		const { bps, missing } = coingeckoBps(
			{
				bitcoin: { usd: 85853, usd_24h_change: 0.8115145522087773 },
				chainlink: { usd: 14.2, usd_24h_change: 46 },
				// pax-gold absent
			},
			coins,
		)
		expect(bps).toEqual({ c0: 32, c9: 1500, c12: 0 })
		expect(missing).toEqual(['PAXG'])
	})

	test('garbage body → every coin 0, all missing', () => {
		expect(coingeckoBps('nope', coins)).toEqual({ bps: { c0: 0, c9: 0, c12: 0 }, missing: ['BTC', 'LINK', 'PAXG'] })
		expect(coingeckoBps({ bitcoin: { usd_24h_change: 'x' } }, coins).missing).toContain('BTC')
	})
})

describe('FX (Frankfurter) for the fiat fighters', () => {
	const fiat = ROSTER.filter(isFiat)
	const eur = coin(13, 'EUR', 'rwa', null)
	const jpy = coin(14, 'JPY', 'rwa', null)
	const BASE = 'https://api.frankfurter.dev/v1'

	test('fiatCurrency reads the pair; anything but "XXX / USD" is refused', () => {
		expect(fiatCurrency(eur)).toBe('EUR')
		expect(() => fiatCurrency({ ...eur, pair: 'USD / EUR' })).toThrow()
		expect(() => fiatCurrency({ ...eur, pair: 'PAXG / USD' })).toThrow()
	})

	test('one batched URL per day, sorted codes, trailing slash tolerated', () => {
		expect(frankfurterUrl(BASE, 'latest', fiat)).toBe(`${BASE}/latest?from=USD&to=AUD,BRL,CAD,EUR,JPY,KRW,MXN`)
		expect(frankfurterUrl(`${BASE}/`, '2026-10-06', [jpy, eur, eur])).toBe(`${BASE}/2026-10-06?from=USD&to=EUR,JPY`)
	})

	test('utcDate is the UTC calendar day', () => {
		expect(utcDate(Date.UTC(2026, 9, 7, 0, 0, 0))).toBe('2026-10-07')
		expect(utcDate(Date.UTC(2026, 9, 7, 23, 59, 59))).toBe('2026-10-07')
		expect(utcDate(Date.UTC(2026, 9, 7, 12) - 86_400_000)).toBe('2026-10-06')
	})

	test('parseFrankfurter accepts the real response shape and rejects anything else', () => {
		const f = parseFrankfurter(FX_LATEST_2026_10_07)
		expect(f?.date).toBe('2026-10-07')
		expect(f?.rates.get('EUR')).toBe(0.89469)
		expect(f?.rates.size).toBe(7)
		expect(parseFrankfurter({ message: 'not found' })).toBeNull() // Frankfurter's 404 body
		expect(parseFrankfurter({ ...FX_LATEST_2026_10_07, base: 'EUR' })).toBeNull()
		expect(parseFrankfurter({ ...FX_LATEST_2026_10_07, amount: 100 })).toBeNull()
		expect(parseFrankfurter({ ...FX_LATEST_2026_10_07, date: 'yesterday' })).toBeNull()
		expect(parseFrankfurter(null)).toBeNull()
		// non-positive / non-numeric rates are dropped, not trusted
		expect(parseFrankfurter({ ...FX_LATEST_2026_10_07, rates: { EUR: 0, JPY: '158', AUD: 1.4 } })?.rates).toEqual(
			new Map([['AUD', 1.4]]),
		)
	})

	test('the fighter is XXX / USD: its move is the inverse of USD → XXX', () => {
		// USD → EUR 0.88739 → 0.89469: the dollar bought more euros, so EUR / USD fell.
		const pct = fxChangePercent(0.89469, 0.88739) as number
		const reciprocal = ((1 / 0.89469 - 1 / 0.88739) / (1 / 0.88739)) * 100
		expect(pct).toBeCloseTo(reciprocal, 12)
		expect(pct).toBeLessThan(0)
		expect(changeToBps(pct)).toBe(-33)
		// a 20% cheaper dollar is a +25% fiat fighter (1 / 0.8 = 1.25) → +1000 bps
		expect(changeToBps(fxChangePercent(0.8, 1))).toBe(1000)
		expect(fxChangePercent(undefined, 1)).toBeNull()
		expect(fxChangePercent(1, 0)).toBeNull()
		expect(fxChangePercent(Number.NaN, 1)).toBeNull()
	})

	test('fxBps on the recorded 2026-10-07 vs 2026-10-06 fixings', () => {
		const { bps, missing, sameFixing } = fxBps(FX_LATEST_2026_10_07, FX_2026_10_06, fiat)
		expect(sameFixing).toBe(false)
		expect(missing).toEqual([])
		expect(Object.fromEntries(fiat.map((c) => [c.ticker, bps[coinKey(c.coinId)]]))).toEqual(FX_EXPECTED_BPS_2026_10_07)
	})

	test('weekend / holiday: the same fixing on both sides is 0 bps for every fiat fighter', () => {
		// Monday morning before the ECB fixing: latest is still Friday's, and
		// /v1/<Sunday> also answers with Friday's.
		const r = fxBps(FX_2026_10_04_SUNDAY, FX_2026_10_04_SUNDAY, fiat)
		expect(r.sameFixing).toBe(true)
		expect(r.bps).toEqual(zeroBps(fiat))
		// a "latest" older than the past fixing (stale cache) is not trusted either
		expect(fxBps(FX_2026_10_04_SUNDAY, FX_2026_10_06, fiat).bps).toEqual(zeroBps(fiat))
	})

	test('a currency missing from either day is 0 and reported', () => {
		const { EUR: _drop, ...rest } = FX_2026_10_06.rates
		const r = fxBps(FX_LATEST_2026_10_07, { ...FX_2026_10_06, rates: rest }, [eur, jpy])
		expect(r.bps).toEqual({ c13: 0, c14: -4 })
		expect(r.missing).toEqual(['EUR'])
	})

	test('an unrecognisable body throws (the workflow then writes 0 for all fiat)', () => {
		expect(() => fxBps({ message: 'not found' }, FX_2026_10_06, fiat)).toThrow('Frankfurter')
		expect(() => fxBps(FX_LATEST_2026_10_07, 'garbage', fiat)).toThrow('Frankfurter')
	})

	test('zeroBps covers every coin', () => {
		expect(zeroBps([eur, jpy])).toEqual({ c13: 0, c14: 0 })
	})
})

describe('report encoding: abi.encode(uint64, uint16[], int16[])', () => {
	const solidityTypes = parseAbiParameters('uint64, uint16[], int16[]')

	test('round-trips through viem decodeAbiParameters with the exact Solidity types', () => {
		const report = { epoch: 2_983_333n, coinIds: [0, 1, 2, 19], bps: [800, -1200, 0, 1500] }
		const encoded = encodeMetaReport(report)
		const [epoch, coinIds, bps] = decodeAbiParameters(solidityTypes, encoded)
		expect(epoch).toBe(2_983_333n)
		expect([...coinIds]).toEqual([0, 1, 2, 19])
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
		const r = buildReport(9n, { [coinKey(0)]: 800, [coinKey(19)]: -1600, [coinKey(3)]: 12.5 }, ROSTER)
		expect(r.coinIds).toEqual(ROSTER.map((c) => c.coinId).sort((a, b) => a - b))
		expect(r.coinIds.length).toBe(20)
		expect(r.bps[0]).toBe(800)
		expect(r.bps[3]).toBe(13)
		expect(r.bps[19]).toBe(-1500)
		expect(r.bps.filter((b) => b !== 0).length).toBe(3)
		expect(decodeMetaReport(encodeMetaReport(r))).toEqual(r)
	})
})
