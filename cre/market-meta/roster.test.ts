import { describe, expect, test } from 'bun:test'
import { type CoinKind, ROSTER, ROSTER_CHAIN_ID } from './roster'

// Fails when shared/roster.json changes without `bun run gen:roster`.
describe('roster.ts is in sync with shared/roster.json', () => {
	test('same coins, ids, kinds, CoinGecko ids and Pyth feeds', async () => {
		const shared = (await Bun.file(`${import.meta.dir}/../../shared/roster.json`).json()) as {
			chainId: number
			coins: Array<{ coinId: number; ticker: string; kind: CoinKind; feedId: string; coingeckoId?: string }>
		}
		expect(ROSTER_CHAIN_ID).toBe(shared.chainId)
		const expected = shared.coins
			.map((c) => ({
				coinId: c.coinId,
				ticker: c.ticker,
				kind: c.kind,
				coingeckoId: c.kind === 'stock' ? null : (c.coingeckoId ?? null),
				feedId: c.feedId.toLowerCase(),
			}))
			.sort((a, b) => a.coinId - b.coinId)
		expect(ROSTER.map((c) => ({ ...c }))).toEqual(expected)
	})

	test('36 fighters, unique uint16 ids, every non-stock has a CoinGecko id', () => {
		expect(ROSTER.length).toBe(36)
		expect(new Set(ROSTER.map((c) => c.coinId)).size).toBe(ROSTER.length)
		for (const c of ROSTER) {
			expect(c.coinId).toBeGreaterThanOrEqual(0)
			expect(c.coinId).toBeLessThanOrEqual(0xffff)
			if (c.kind !== 'stock') expect(c.coingeckoId).toBeTruthy()
		}
	})
})
