/**
 * Pure logic for the market-meta workflow: no SDK imports, no I/O.
 *
 * Everything that decides what lands on chain lives here so it can be unit
 * tested directly (meta.test.ts) and reasoned about in one place:
 *   - the change → modifier curve (changeToBps)
 *   - the epoch clock (epochFor)
 *   - parsing CoinGecko / Pyth Hermes responses into per-coin modifiers
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

/** URL for one batched CoinGecko call covering every crypto/meme coin. */
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

export type PythPrice = { price: bigint; expo: number; publishTime: number }

/** Hermes v2 `parsed[]` → map of feed id (lowercase, 0x-prefixed) to price. */
export const parseHermes = (body: unknown): Map<string, PythPrice> => {
	const out = new Map<string, PythPrice>()
	const parsed = (body as { parsed?: unknown } | null)?.parsed
	if (!Array.isArray(parsed)) return out
	for (const entry of parsed) {
		const id = (entry as { id?: unknown })?.id
		const p = (entry as { price?: { price?: unknown; expo?: unknown; publish_time?: unknown } })?.price
		if (typeof id !== 'string' || !p) continue
		if (typeof p.price !== 'string' && typeof p.price !== 'number') continue
		if (typeof p.expo !== 'number' || typeof p.publish_time !== 'number') continue
		const key = (id.startsWith('0x') ? id : `0x${id}`).toLowerCase()
		out.set(key, { price: BigInt(p.price), expo: p.expo, publishTime: p.publish_time })
	}
	return out
}

/**
 * Percent change from `past` to `latest`, exact in integer math until the
 * final division. Returns null (→ 0 bps) when the pair can't honestly be
 * called a 24h move: non-positive prices, or a window shorter than
 * `minWindowSeconds` (e.g. a closed equity market, where Hermes hands back
 * the same or a later print for "24h ago").
 */
export const pythChangePercent = (
	latest: PythPrice | undefined,
	past: PythPrice | undefined,
	minWindowSeconds: number,
): number | null => {
	if (!latest || !past) return null
	if (latest.publishTime - past.publishTime < minWindowSeconds) return null
	const minExpo = Math.min(latest.expo, past.expo)
	const l = latest.price * 10n ** BigInt(latest.expo - minExpo)
	const p = past.price * 10n ** BigInt(past.expo - minExpo)
	if (l <= 0n || p <= 0n) return null
	// percent with 1e-7 resolution
	return Number(((l - p) * 1_000_000_000n) / p) / 10_000_000
}

/** URL for one batched Hermes call; `when` is 'latest' or a unix timestamp. */
export const hermesUrl = (baseUrl: string, when: 'latest' | number, coins: readonly RosterCoin[]): string => {
	const ids = coins.map((c) => `ids[]=${c.feedId}`).join('&')
	return `${baseUrl}/v2/updates/price/${when}?${ids}&parsed=true&encoding=base64`
}

/** Hermes latest + Hermes 24h-ago → bps per stock; unusable pairs get 0 and are listed in `flat`. */
export const pythBps = (
	latestBody: unknown,
	pastBody: unknown,
	coins: readonly RosterCoin[],
	minWindowSeconds: number,
): { bps: BpsByKey; flat: string[] } => {
	const latest = parseHermes(latestBody)
	const past = parseHermes(pastBody)
	const bps: BpsByKey = {}
	const flat: string[] = []
	for (const c of coins) {
		const pct = pythChangePercent(latest.get(c.feedId), past.get(c.feedId), minWindowSeconds)
		if (pct === null) flat.push(c.ticker)
		bps[coinKey(c.coinId)] = changeToBps(pct)
	}
	return { bps, flat }
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
