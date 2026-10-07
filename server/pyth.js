/**
 * The Pyth price proxy.
 *
 * Minting a card posts a fresh Pyth update in the same transaction —
 * `MempireCards.mint` takes the signed update bytes and records the price the
 * card was minted at, and an asset with no live price cannot be minted at all.
 * Those bytes come from Hermes, and Hermes has required an API key since
 * 2026-08-26. A key in the browser bundle is a key anyone can lift and spend,
 * so the browser asks this route and the key stays here.
 *
 * Responses are cached for about two seconds per set of feeds. A price update
 * is only useful while it is fresh (crypto feeds are registered with a 120 s
 * maximum age), but a burst of players opening the mint screen at once should
 * cost one upstream call, not one each.
 */
import { encodeAbiParameters, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN_ID, coinById, deployment, IS_DEV_CHAIN } from './chain.js';

const HERMES = (process.env.PYTH_HERMES_URL || 'https://pyth.dourolabs.app/hermes').replace(/\/+$/, '');
const KEY = process.env.PYTH_API_KEY || '';
const TTL_MS = 2_000;
/** A mint posts one feed; a deck screen might price eight. Beyond that is a scrape. */
const MAX_FEEDS = 16;
const cache = new Map(); // sorted coin ids → { at, body } | { at, inflight }

/*
 * Where signed price updates come from:
 *
 *  - `hermes`: Pyth's Hermes, with the server-held key. On Monad.
 *  - `local`: LOCAL CHAIN ONLY (31337). The game's contracts point at a
 *    LocalPriceOracle that accepts an update only if this relay's oracle key
 *    signed it — Pyth's model on a chain Pyth does not serve. The relay signs
 *    *only* a live market quote it just read (OKX, or CoinGecko), with that quote's own
 *    timestamp as the publish time, and its moving-average leg derived from the
 *    quote's real 24-hour change. No quote, no update: the caller gets an
 *    error, never a number nobody quoted.
 *  - `off`: neither configured. Mints answer "no price source configured".
 */
const ORACLE_KEY = process.env.ORACLE_PRIVATE_KEY || '';
const MODE = (() => {
  if (KEY) return 'hermes';
  if (ORACLE_KEY && IS_DEV_CHAIN) return 'local';
  if (ORACLE_KEY) console.warn('pyth: ORACLE_PRIVATE_KEY is only honoured on a local dev chain (31337/31338)');
  return 'off';
})();
export const pythMode = () => MODE;

let oracleAccount = null;
const oracle = () => (oracleAccount ??= privateKeyToAccount(ORACLE_KEY));

/** Live quotes the market feed read: coinId → { priceUsd, change24h, at }. */
const live = new Map();
export function noteLivePrices(rows) {
  for (const r of rows ?? []) {
    if (r?.priceUsd > 0 && (r.source === 'okx' || r.source === 'coingecko')) live.set(r.coinId, r);
  }
}

export const pythConfigured = () => MODE !== 'off';

const EXPO = -8;
/** A quote older than this is not "live" enough to sign for a 120 s feed. */
const MAX_QUOTE_AGE_S = 100;

async function localUpdate(coins) {
  // Make sure the quotes are fresh before signing anything.
  const { refreshQuotes } = await import('./market.js');
  await refreshQuotes(MAX_QUOTE_AGE_S * 1000).catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  const updateData = [];
  const prices = [];
  const missing = [];
  for (const c of coins) {
    const q = live.get(c.coinId);
    const at = Number(q?.at ?? 0);
    if (!q || now - at > MAX_QUOTE_AGE_S) { missing.push(c.ticker); continue; }
    const change = typeof q.change24h === 'number' ? q.change24h : 0;
    const price = BigInt(Math.max(1, Math.round(q.priceUsd * 1e8)));
    // The EMA leg: the price 24 hours ago is price / (1 + change); Pyth's EMA
    // sits between the two, so use the midpoint. Derived from the real move.
    const dayAgo = q.priceUsd / (1 + change / 100);
    const ema = BigInt(Math.max(1, Math.round(((q.priceUsd + dayAgo) / 2) * 1e8)));
    const publishTime = BigInt(at);
    const digest = keccak256(encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'int64' }, { type: 'int32' }, { type: 'int64' }, { type: 'uint64' }],
      [deployment.pyth, BigInt(CHAIN_ID), c.feedId, price, EXPO, ema, publishTime],
    ));
    const signature = await oracle().signMessage({ message: { raw: digest } });
    updateData.push(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'int64' }, { type: 'int32' }, { type: 'int64' }, { type: 'uint64' }, { type: 'bytes' }],
      [c.feedId, price, EXPO, ema, publishTime, signature],
    ));
    prices.push({ coinId: c.coinId, price: String(price), expo: EXPO, publishTime: at, ema: String(ema), source: q.source });
  }
  return { mode: 'local', updateData, prices, missing };
}

/** Strips the 0x Hermes omits, so feed ids compare in one spelling. */
const bare = (feedId) => feedId.toLowerCase().replace(/^0x/, '');

/**
 * Latest prices and signed update data for `coinIds`, via Hermes.
 *
 * Resolves `{ updateData: ['0x…'], prices: [{ coinId, price, expo, publishTime }] }`.
 * `price` is the raw integer Pyth publishes, as a string — a price times
 * 10^expo is the USD value, and a JS number cannot carry every int64 exactly.
 */
export async function fetchPythUpdate(coinIds) {
  if (MODE === 'off') throw Object.assign(new Error('pyth api key not configured'), { status: 503 });
  const ids = [...new Set(coinIds)].sort((a, b) => a - b);
  if (MODE === 'local') {
    const out = await localUpdate(ids.map((id) => coinById.get(id)).filter(Boolean));
    if (!out.updateData.length) {
      throw Object.assign(new Error(`no live price right now for ${out.missing.join(', ')}`), { status: 503 });
    }
    return out;
  }
  const cacheKey = ids.join(',');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body ?? hit.inflight;

  const coins = ids.map((id) => coinById.get(id));
  const qs = coins.map((c) => `ids[]=${c.feedId}`).join('&');
  const inflight = (async () => {
    const res = await fetch(`${HERMES}/v2/updates/price/latest?${qs}&encoding=hex&parsed=true`, {
      headers: { accept: 'application/json', authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`hermes answered ${res.status}`), { status: 502 });
    }
    const body = await res.json();
    const byFeed = new Map(coins.map((c) => [bare(c.feedId), c.coinId]));
    const prices = (body?.parsed ?? [])
      .filter((p) => byFeed.has(bare(String(p.id))))
      .map((p) => ({
        coinId: byFeed.get(bare(String(p.id))),
        price: String(p.price?.price),
        expo: Number(p.price?.expo),
        publishTime: Number(p.price?.publish_time),
      }));
    const updateData = (body?.binary?.data ?? []).map((d) => (d.startsWith('0x') ? d : `0x${d}`));
    return { mode: 'hermes', updateData, prices };
  })();

  cache.set(cacheKey, { at: Date.now(), inflight });
  try {
    const out = await inflight;
    cache.set(cacheKey, { at: Date.now(), body: out });
    // Keyed by whatever combination the callers asked for, so prune rather
    // than let a stream of distinct combinations grow the map for ever.
    if (cache.size > 200) {
      for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
    }
    return out;
  } catch (e) {
    cache.delete(cacheKey);
    throw e;
  }
}

/** Parses `?coinIds=1,2` into roster coin ids, or returns an error string. */
export function parseCoinIds(raw) {
  const parts = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return 'coinIds is required, e.g. ?coinIds=0,26';
  if (parts.length > MAX_FEEDS) return `at most ${MAX_FEEDS} coinIds per request`;
  const ids = [];
  for (const p of parts) {
    if (!/^\d{1,5}$/.test(p) || !coinById.has(Number(p))) return `unknown coinId ${p.slice(0, 8)}`;
    ids.push(Number(p));
  }
  return ids;
}

export function registerPythRoutes(app, gate) {
  const pass = (_req, _res, next) => next();
  app.get('/api/pyth/update', gate ?? pass, async (req, res) => {
    if (MODE === 'off') return res.status(503).json({ error: 'pyth api key not configured' });
    const ids = parseCoinIds(req.query.coinIds);
    if (typeof ids === 'string') return res.status(400).json({ error: ids });
    try {
      res.set('cache-control', 'no-store');
      res.json(await fetchPythUpdate(ids));
    } catch (e) {
      res.status(e?.status ?? 502).json({ error: String(e?.message ?? e).slice(0, 160) });
    }
  });
}
