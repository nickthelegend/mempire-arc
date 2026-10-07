/**
 * Pure logic for the market-meta workflow: no SDK imports, no I/O.
 *
 * Everything that decides what lands on chain lives here so it can be unit
 * tested directly (meta.test.ts) and reasoned about in one place:
 *   - the change → modifier curve (changeToBps)
 *   - the epoch clock (epochFor)
 *   - parsing CoinGecko / Frankfurter (FX) responses into per-coin modifiers
 *   - the exact on-chain report encoding (encodeMetaReport)
 */
import { decodeAbiParameters, encodeAbiParameters, type Hex, parseAbiParameters } from 'viem'
import type { RosterCoin } from './roster'

/** MarketMeta.MAX_BPS — the contract rejects any |bps| above this. */
export const MAX_BPS = 1500

/**
 * Basis points of strength per 1% of 24h price change.
 * A +20% day → +800 bps (8% stronger); the ±1500 cap is reached at ±37.5%.
 */
export const BPS_PER_PERCENT = 40

/** Demo epoch length. Production would use 3600 (hourly) or 86400 (daily). */
export const DEFAULT_EPOCH_SECONDS = 600

/** The exact tuple MarketMeta.onReport decodes: abi.decode(report, (uint64, uint16[], int16[])). */
export const REPORT_PARAMS = parseAbiParameters('uint64 epoch, uint16[] coinIds, int16[] bps')

/** Record key used for a coin in consensus observations (field names must be strings). */
export const coinKey = (coinId: number): string => `c${coinId}`

export type BpsByKey = Record<string, number>

// ---------------------------------------------------------------------------
// The curve
// ---------------------------------------------------------------------------

/** Clamp to [-MAX_BPS, +MAX_BPS]. */
export const clampBps = (bps: number): number => Math.min(MAX_BPS, Math.max(-MAX_BPS, bps))

/**
 * Round to the nearest integer, halves away from zero, so a −x% day and a
 * +x% day give exactly opposite modifiers (Math.round alone would send −2.5
 * to −2 but +2.5 to +3). Never returns −0.
 */
export const roundHalfAwayFromZero = (x: number): number => {
	const r = Math.sign(x) * Math.round(Math.abs(x))
	return r === 0 ? 0 : r
}

/**
 * bps = clamp(round(change24hPercent × 40), −1500, +1500).
 * Missing / non-finite input (no data) is a neutral 0, never a guess.
 */
export const changeToBps = (change24hPercent: number | null | undefined): number => {
	if (typeof change24hPercent !== 'number' || !Number.isFinite(change24hPercent)) return 0
	return clampBps(roundHalfAwayFromZero(change24hPercent * BPS_PER_PERCENT))
}

/**
 * Re-normalise a value that came out of DON consensus. Medians of integers
 * are integers for an odd node count, but the aggregator works in float64 and
 * an even count may average two neighbours, so round and clamp again. The
 * curve is monotonic, so median(bps) == bps(median(change)) either way.
 */
export const normalizeBps = (x: number): number =>
	Number.isFinite(x) ? clampBps(roundHalfAwayFromZero(x)) : 0

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/** epoch = floor(unixSeconds / epochSeconds). Strictly increases across windows. */
export const epochFor = (unixMillis: number, epochSeconds = DEFAULT_EPOCH_SECONDS): bigint => {
	if (!Number.isInteger(epochSeconds) || epochSeconds <= 0) throw new Error('epochSeconds must be a positive integer')
	return BigInt(Math.floor(unixMillis / 1000 / epochSeconds))
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** URL for one batched CoinGecko call covering every coin that has a CoinGecko id. */
export const coingeckoUrl = (baseUrl: string, coins: readonly RosterCoin[]): string => {
	const ids = [...new Set(coins.map((c) => c.coingeckoId).filter((id): id is string => !!id))].sort()
	return `${baseUrl}?ids=${ids.map(encodeURIComponent).join(',')}&vs_currencies=usd&include_24hr_change=true`
}

/**
 * CoinGecko /simple/price → bps per coin. A coin CoinGecko didn't return (or
 * returned without a 24h change) gets 0 and is listed in `missing`.
 */
export const coingeckoBps = (
	body: unknown,
	coins: readonly RosterCoin[],
): { bps: BpsByKey; missing: string[] } => {
	const table = (body && typeof body === 'object' ? body : {}) as Record<string, { usd_24h_change?: unknown }>
	const bps: BpsByKey = {}
	const missing: string[] = []
	for (const c of coins) {
		const change = c.coingeckoId ? table[c.coingeckoId]?.usd_24h_change : undefined
		if (typeof change !== 'number' || !Number.isFinite(change)) missing.push(c.ticker)
		bps[coinKey(c.coinId)] = changeToBps(change as number | undefined)
	}
	return { bps, missing }
}

// ---------------------------------------------------------------------------
// FX (fiat fighters) — Frankfurter, keyless, ECB reference rates
// ---------------------------------------------------------------------------

/**
 * A fiat fighter is one priced from FX rates rather than CoinGecko: the roster
 * marks it with a null coingeckoId and an "XXX / USD" pair.
 */
export const isFiat = (c: RosterCoin): boolean => c.coingeckoId === null

/** "EUR / USD" → "EUR". Throws on anything that isn't a fiat-vs-USD pair. */
export const fiatCurrency = (c: RosterCoin): string => {
	const m = /^([A-Z]{3}) \/ USD$/.exec(c.pair)
	if (!m) throw new Error(`${c.ticker}: pair ${JSON.stringify(c.pair)} is not "XXX / USD"`)
	return m[1]
}

/** YYYY-MM-DD of a unix-millis instant, in UTC. */
export const utcDate = (unixMillis: number): string => new Date(unixMillis).toISOString().slice(0, 10)

/**
 * One batched Frankfurter call, rates quoted as USD → XXX.
 * `when` is 'latest' or a YYYY-MM-DD date; for a weekend/holiday date
 * Frankfurter answers with the last business day's fixing at or before it.
 */
export const frankfurterUrl = (baseUrl: string, when: 'latest' | string, coins: readonly RosterCoin[]): string => {
	const codes = [...new Set(coins.map(fiatCurrency))].sort()
	return `${baseUrl.replace(/\/+$/, '')}/${when}?from=USD&to=${codes.join(',')}`
}

export type FxFixing = { date: string; rates: Map<string, number> }

/**
 * Frankfurter body `{ amount: 1, base: "USD", date: "YYYY-MM-DD", rates: { EUR: 0.89, … } }`
 * → the fixing's date and its USD → XXX rates. null if the body isn't that shape.
 */
export const parseFrankfurter = (body: unknown): FxFixing | null => {
	if (!body || typeof body !== 'object') return null
	const { base, date, rates, amount } = body as { base?: unknown; date?: unknown; rates?: unknown; amount?: unknown }
	if (base !== 'USD' || (amount !== undefined && amount !== 1)) return null
	if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
	if (!rates || typeof rates !== 'object') return null
	const out = new Map<string, number>()
	for (const [code, rate] of Object.entries(rates as Record<string, unknown>)) {
		if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) out.set(code, rate)
	}
	return { date, rates: out }
}

/**
 * The fighter's move. Frankfurter quotes USD → XXX (units of XXX per dollar)
 * but the fighter tracks the Chainlink XXX / USD feed (dollars per unit of
 * XXX), its reciprocal. So the fighter's change is
 *   (1/latest − 1/past) / (1/past) = past / latest − 1.
 * A stronger dollar (USD → EUR up) is a weaker EUR fighter. null (→ 0 bps)
 * when either rate is missing or non-positive.
 */
export const fxChangePercent = (latestUsdToX: number | undefined, pastUsdToX: number | undefined): number | null => {
	if (typeof latestUsdToX !== 'number' || typeof pastUsdToX !== 'number') return null
	if (!(latestUsdToX > 0) || !(pastUsdToX > 0) || !Number.isFinite(latestUsdToX) || !Number.isFinite(pastUsdToX)) {
		return null
	}
	return (pastUsdToX / latestUsdToX - 1) * 100
}

/**
 * Frankfurter latest + Frankfurter as of yesterday (UTC) → bps per fiat fighter.
 *
 * - Same fixing on both sides (weekend, ECB holiday, or today's fixing not yet
 *   published): every fiat fighter is 0 and `sameFixing` is set.
 * - A "latest" older than the past fixing (stale cache) is treated the same way.
 * - A currency missing from either side is 0 and listed in `missing`.
 * - An unparseable body throws: the caller turns that into 0 bps for all fiat.
 */
export const fxBps = (
	latestBody: unknown,
	pastBody: unknown,
	coins: readonly RosterCoin[],
): { bps: BpsByKey; missing: string[]; sameFixing: boolean } => {
	const latest = parseFrankfurter(latestBody)
	const past = parseFrankfurter(pastBody)
	if (!latest || !past) throw new Error('Frankfurter: unexpected response shape')
	if (latest.date <= past.date) return { bps: zeroBps(coins), missing: [], sameFixing: true }
	const bps: BpsByKey = {}
	const missing: string[] = []
	for (const c of coins) {
		const code = fiatCurrency(c)
		const pct = fxChangePercent(latest.rates.get(code), past.rates.get(code))
		if (pct === null) missing.push(c.ticker)
		bps[coinKey(c.coinId)] = changeToBps(pct)
	}
	return { bps, missing, sameFixing: false }
}

/** Every coin at 0 bps — the neutral answer when a source is unavailable. */
export const zeroBps = (coins: readonly RosterCoin[]): BpsByKey =>
	Object.fromEntries(coins.map((c) => [coinKey(c.coinId), 0]))

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type MetaReport = { epoch: bigint; coinIds: number[]; bps: number[] }

/**
 * Lay the merged per-coin modifiers out in roster (coinId) order. Every coin
 * is present — a flat coin is written as an explicit 0 — so a reader of
 * `modifierBps[epoch]` never has to guess whether a 0 means "unchanged" or
 * "not reported".
 */
export const buildReport = (epoch: bigint, bpsByKey: BpsByKey, roster: readonly RosterCoin[]): MetaReport => {
	const sorted = [...roster].sort((a, b) => a.coinId - b.coinId)
	return {
		epoch,
		coinIds: sorted.map((c) => c.coinId),
		bps: sorted.map((c) => normalizeBps(bpsByKey[coinKey(c.coinId)] ?? 0)),
	}
}

/**
 * abi.encode(uint64 epoch, uint16[] coinIds, int16[] bps) — byte-for-byte
 * what MarketMeta.onReport decodes. Validates everything the contract would
 * revert on, so a bad report fails here instead of costing gas.
 */
export const encodeMetaReport = ({ epoch, coinIds, bps }: MetaReport): Hex => {
	if (epoch <= 0n || epoch >= 2n ** 64n) throw new Error(`epoch ${epoch} out of uint64 range`)
	if (coinIds.length !== bps.length) throw new Error('coinIds/bps length mismatch')
	for (const id of coinIds) {
		if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new Error(`coinId ${id} out of uint16 range`)
	}
	for (const b of bps) {
		if (!Number.isInteger(b) || b < -MAX_BPS || b > MAX_BPS) throw new Error(`bps ${b} out of bounds`)
	}
	return encodeAbiParameters(REPORT_PARAMS, [epoch, coinIds, bps])
}

/** Inverse of encodeMetaReport (used by tests and for logging). */
export const decodeMetaReport = (data: Hex): MetaReport => {
	const [epoch, coinIds, bps] = decodeAbiParameters(REPORT_PARAMS, data)
	return { epoch, coinIds: [...coinIds], bps: [...bps] }
}
