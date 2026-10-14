import { keccak256, type Hex } from 'viem';
import cardCatalogue from '../data/cards.json';
import roster from '../shared/roster.json';

/*
 * The roster: 20 assets, each a fighter — one for every Chainlink Data Feed on
 * Arc mainnet worth fighting over: majors, DeFi tokens, gold (PAXG) and fiat
 * currencies.
 *
 * Built by `scripts/gen-roster.mjs` from Chainlink's own Arc feed directory.
 * The same file registers the fighters on chain in the same order, so `coinId`
 * here is the coin id the contracts use, and each fighter's price on chain is
 * its Chainlink feed.
 *
 * A coin's identity is `feedId = keccak256(pair)` ("BTC / USD"). `mint` keeps
 * its old name because the whole client keys fighters by it; it holds the
 * feed id. Archetype is `keccak256(feedId) % 6` — byte-for-byte what
 * `MempireCards.archetypeFor` computes, so client and chain cannot disagree
 * about what class a fighter is.
 */

export type AssetKind = 'crypto' | 'defi' | 'rwa';

export const ASSET_KINDS: { id: AssetKind; label: string }[] = [
  { id: 'crypto', label: 'Majors' },
  { id: 'defi', label: 'DeFi' },
  { id: 'rwa', label: 'Gold & FX' },
];

export interface Coin {
  /** The on-chain coin id (index in the roster). */
  coinId: number;
  /** Identity: keccak256 of the Chainlink pair (0x…). Named `mint` for the rest of the client. */
  mint: string;
  feedId: Hex;
  ticker: string;
  name: string;
  hue: number;
  /** Demo holdings, unused on chain: holding an asset is never required. */
  balance: number;
  /** Live Chainlink price, via the relay; 0 until it arrives. */
  priceUsd: number;
  liquidityUsd: number;
  ageHours: number;
  logoUrl?: string;
  cardArt?: string;
  kind: AssetKind;
  decimals: number;
  change24h?: number;
  /** Today's market modifier from MarketMeta, in basis points (±1500). */
  metaBps?: number;
  fdvUsd?: number;
  volume24h?: number;
  pumpFun?: boolean;
  url?: string;
  /** The Chainlink pair, e.g. "BTC / USD". */
  pair: string;
}

interface RosterRow {
  coinId: number;
  ticker: string;
  name: string;
  kind: AssetKind;
  feedId: Hex;
  pair: string;
  hue: number;
  hasArt: boolean;
}

const KIND_BY_TICKER = new Map<string, AssetKind>(
  (cardCatalogue.cards as { ticker: string; kind: string }[])
    .map((c) => [c.ticker.toUpperCase(), c.kind as AssetKind]),
);

/** Tickers always render with the $ the culture uses. */
export const tickerOf = (c: Coin): string => `$${c.ticker.replace(/^\$+/, '')}`;

/*
 * The eligibility gate is on chain: a fighter can be minted only while its
 * Chainlink feed is fresh and positive, read in the mint transaction. Every
 * roster asset has a live feed, so nothing here is ineligible — the functions
 * stay so the screens that ask still get an honest answer.
 */
export const ELIGIBILITY = { minLiquidityUsd: 0, minAgeHours: 0 };
export const isEligible = (_c: Coin): boolean => true;
export const ineligibleReason = (_c: Coin): string | null => null;

export const REGISTRY_META = { cluster: `chain ${roster.chainId}` };

export function archetypeForFeed(feedId: string): number {
  return Number(BigInt(keccak256(feedId as Hex)) % 6n);
}

function build(): Coin[] {
  return (roster.coins as unknown as RosterRow[]).map((c) => ({
    coinId: c.coinId,
    mint: c.feedId.toLowerCase(),
    feedId: c.feedId,
    ticker: c.ticker,
    name: c.name,
    hue: c.hue,
    balance: 0,
    priceUsd: 0,
    liquidityUsd: 0,
    ageHours: 0,
    decimals: 18,
    kind: c.kind ?? KIND_BY_TICKER.get(c.ticker.toUpperCase()),
    pair: c.pair,
    // WebP at ~58 KB rather than the 413 KB PNG; the PNG stays on disk because
    // NFT metadata points at it. Both the card frame and the battle billboard
    // fall back to a procedural badge if a file is missing.
    cardArt: `/art/card_${c.ticker.toLowerCase()}.${['BCH','HYPE','AAVE','PAXG','EUR','JPY','AUD','CAD','MXN','BRL','KRW'].includes(c.ticker) ? 'svg' : 'webp'}`,
  }));
}

export const COINS: Coin[] = build();

const BY_MINT = new Map(COINS.map((c) => [c.mint, c]));
const BY_TICKER = new Map(COINS.map((c) => [c.ticker, c]));

export const coinByMint = (mint: string): Coin | undefined => BY_MINT.get(mint.toLowerCase());
export const coinById = (coinId: number): Coin | undefined => COINS[coinId];
export const coinByTicker = (ticker: string): Coin | undefined =>
  BY_TICKER.get(ticker.replace(/^\$+/, '').toUpperCase());

/**
 * Overlay the relay's live market read onto the roster.
 *
 * Keyed by coin id. Reports whether anything changed so the caller can
 * re-render. Missing numbers stay missing; nothing here invents a price.
 */
export function overlayLivePrices(
  live: { coinId: number; priceUsd?: number; change24h?: number }[],
): boolean {
  let changed = false;
  for (const row of live) {
    const coin = COINS[row.coinId];
    if (!coin) continue;
    if (typeof row.priceUsd === 'number' && row.priceUsd > 0 && row.priceUsd !== coin.priceUsd) {
      coin.priceUsd = row.priceUsd; changed = true;
    }
    if (typeof row.change24h === 'number' && row.change24h !== coin.change24h) {
      coin.change24h = row.change24h; changed = true;
    }
  }
  return changed;
}

/** Overlay MarketMeta's current modifiers (coinId → bps). */
export function overlayMeta(bps: Map<number, number>): boolean {
  let changed = false;
  for (const coin of COINS) {
    const v = bps.get(coin.coinId) ?? 0;
    if (coin.metaBps !== v) { coin.metaBps = v; changed = true; }
  }
  return changed;
}
