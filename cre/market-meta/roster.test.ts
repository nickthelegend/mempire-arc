import { describe, expect, test } from 'bun:test'
import { fiatCurrency, isFiat } from './meta'
import { type CoinKind, ROSTER, ROSTER_CHAIN_ID } from './roster'

// Fails when shared/roster.json changes without `bun run gen:roster`.
describe('roster.ts is in sync with shared/roster.json', () => {
	test('same coins, ids, kinds, pairs, CoinGecko ids and feed ids', async () => {
		const shared = (await Bun.file(`${import.meta.dir}/../../shared/roster.json`).json()) as {
			chainId: number
			coins: Array<{
				coinId: number
				ticker: string
				kind: CoinKind
				pair: string
				feedId: string
				coingeckoId: string | null
			}>
		}
		expect(ROSTER_CHAIN_ID).toBe(shared.chainId)
		const expected = shared.coins
			.map((c) => ({
				coinId: c.coinId,
				ticker: c.ticker,
				kind: c.kind,
				pair: c.pair,
				coingeckoId: c.coingeckoId,
				feedId: c.feedId.toLowerCase(),
			}))
			.sort((a, b) => a.coinId - b.coinId)
		expect(ROSTER.map((c) => ({ ...c }))).toEqual(expected)
	})

	test('20 fighters, unique uint16 ids, bytes32 feed ids, only crypto/defi/rwa', () => {
		expect(ROSTER.length).toBe(20)
		expect(new Set(ROSTER.map((c) => c.coinId)).size).toBe(ROSTER.length)
		for (const c of ROSTER) {
			expect(c.coinId).toBeGreaterThanOrEqual(0)
			expect(c.coinId).toBeLessThanOrEqual(0xffff)
			expect(['crypto', 'defi', 'rwa']).toContain(c.kind)
			expect(c.feedId).toMatch(/^0x[0-9a-f]{64}$/)
			expect(c.pair).toBe(`${c.ticker} / USD`)
		}
	})

	test('every non-fiat fighter has a CoinGecko id; the 7 fiat fighters are rwa "XXX / USD"', () => {
		const fiat = ROSTER.filter(isFiat)
		expect(fiat.map((c) => c.ticker)).toEqual(['EUR', 'JPY', 'AUD', 'CAD', 'MXN', 'BRL', 'KRW'])
		for (const c of fiat) {
			expect(c.kind).toBe('rwa')
			expect(fiatCurrency(c)).toBe(c.ticker)
		}
		const priced = ROSTER.filter((c) => !isFiat(c))
		expect(priced.length).toBe(13)
		for (const c of priced) expect(c.coingeckoId).toBeTruthy()
		expect(ROSTER.find((c) => c.ticker === 'PAXG')).toMatchObject({ kind: 'rwa', coingeckoId: 'pax-gold' })
		expect(ROSTER.filter((c) => c.kind === 'defi').map((c) => c.ticker)).toEqual(['LINK', 'UNI', 'AAVE'])
	})
})
