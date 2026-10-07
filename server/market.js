/**
 * Market data for the roster — what each fighter's asset is trading at.
 *
 * Sourced server-side so the browser is not blocked by CORS and upstreams see
 * one cached call rather than one per player.
 *
 *  - **Crypto and memecoins** from OKX's public spot tickers (one keyless call
 *    covers 20 of the 24), topped up from CoinGecko's keyless `simple/price`
 *    for the rest when it answers. Cached for sixty seconds. A failed refresh
 *    serves the last good answer rather than nothing.
 *  - **Stocks** from Pyth through `pyth.js`, when a Pyth key is configured.
 *    Without one they are simply absent, and so is any 24-hour change Pyth
 *    does not publish.
 *
 * Nothing here is ever estimated. A coin with no price from either source is
 * left out of the list rather than shown at a number nobody quoted.
 */
import { formatUnits } from 'viem';
import { roster } from './chain.js';
import { fetchPythUpdate, noteLivePrices, pythMode } from './pyth.js';

const TTL_MS = 60_000;
/**
 * How soon to try again after a refresh that got nothing. CoinGecko's keyless
 * tier answers 429 under load, and retrying on every request while it does is
 * how a rate limit becomes a ban.
 */
const RETRY_MS = 15_000;
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price';
/** Optional. The keyless tier works; a free demo key just rate-limits less. */
const CG_KEY = process.env.COINGECKO_API_KEY || '';

let good = { at: 0, coins: [] };
let lastAttempt = 0;
let inflight = null;

/** Pyth's integer price and exponent as a plain USD number. */
function pythUsd(price, expo) {
  const p = BigInt(price);
  return expo < 0 ? Number(formatUnits(p, -expo)) : Number(p * 10n ** BigInt(expo));
}

async function fromCoinGecko() {
  const listed = roster.filter((c) => c.coingeckoId);
  const ids = [...new Set(listed.map((c) => c.coingeckoId))].join(',');
  const res = await fetch(`${COINGECKO}?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`, {
    headers: { accept: 'application/json', ...(CG_KEY ? { 'x-cg-demo-api-key': CG_KEY } : {}) },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`coingecko answered ${res.status}`);
  const body = await res.json();
  const out = [];
  for (const c of listed) {
    const q = body?.[c.coingeckoId];
    const priceUsd = Number(q?.usd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    const change = Number(q?.usd_24h_change);
    out.push({
      coinId: c.coinId,
      ticker: c.ticker,
      priceUsd,
      change24h: Number.isFinite(change) ? change : null,
      source: 'coingecko',
      at: Number(q?.last_updated_at) || Math.floor(Date.now() / 1000),
    });
  }
  return out;
}

const OKX = 'https://www.okx.com/api/v5/market/tickers?instType=SPOT';

/** Every crypto/meme fighter OKX quotes against USDT, with the 24h move from open24h. */
async function fromOkx() {
  const res = await fetch(OKX, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`okx answered ${res.status}`);
  const body = await res.json();
  if (body?.code !== '0' || !Array.isArray(body.data)) throw new Error('okx returned no tickers');
  const byInst = new Map(body.data.map((t) => [t.instId, t]));
  const out = [];
  for (const c of roster) {
    if (c.kind === 'stock') continue;
    const t = byInst.get(`${c.ticker}-USDT`) ?? byInst.get(`${c.ticker}-USD`);
    const last = Number(t?.last);
    const open = Number(t?.open24h);
    if (!(last > 0)) continue;
    out.push({
      coinId: c.coinId,
      ticker: c.ticker,
      priceUsd: last,
      change24h: open > 0 ? ((last - open) / open) * 100 : null,
      source: 'okx',
      at: Math.floor(Number(t.ts) / 1000) || Math.floor(Date.now() / 1000),
    });
  }
  return out;
}

/** Stock rows from Pyth, or null when there is no key and so no source at all. */
async function fromPyth() {
  if (pythMode() !== 'hermes') return null;
  const stocks = roster.filter((c) => c.kind === 'stock');
  if (!stocks.length) return [];
  const { prices } = await fetchPythUpdate(stocks.map((c) => c.coinId));
  const byId = new Map(stocks.map((c) => [c.coinId, c]));
  if (pythMode() !== 'hermes') return [];
  return prices.map((p) => ({
    source: 'pyth',
    coinId: p.coinId,
    ticker: byId.get(p.coinId).ticker,
    priceUsd: pythUsd(p.price, p.expo),
    // Pyth's latest-price endpoint has no 24-hour change, and a stock's last
    // print may be a weekend old. Unknown is the honest value.
    change24h: null,
    publishTime: p.publishTime,
  }));
}

/**
 * Refreshes both sources independently: CoinGecko being down must not take the
 * stocks with it, or the reverse. Each half falls back to its own last good
 * rows.
 */
async function refresh() {
  lastAttempt = Date.now();
  const [ok, cg0, py] = await Promise.allSettled([fromOkx(), fromCoinGecko(), fromPyth()]);
  // OKX first; CoinGecko fills only the fighters OKX does not list.
  const okRows = ok.status === 'fulfilled' ? ok.value : [];
  const have = new Set(okRows.map((r) => r.coinId));
  const cg = (ok.status === 'fulfilled' || cg0.status === 'fulfilled')
    ? { status: 'fulfilled', value: [...okRows, ...(cg0.status === 'fulfilled' ? cg0.value.filter((r) => !have.has(r.coinId)) : [])] }
    : cg0;
  const prior = new Map(good.coins.map((c) => [c.coinId, c]));
  const keep = (kindTest) => [...prior.values()].filter((c) => kindTest(roster.find((r) => r.coinId === c.coinId)));
  const pythOk = py.status === 'fulfilled' && py.value !== null;
  const crypto = cg.status === 'fulfilled' ? cg.value : keep((r) => r?.kind !== 'stock');
  if (cg.status === 'fulfilled') noteLivePrices(cg.value);
  const stocks = pythOk ? py.value : (py.status === 'fulfilled' ? [] : keep((r) => r?.kind === 'stock'));
  const coins = [...crypto, ...stocks].sort((a, b) => a.coinId - b.coinId);
  // Only a source that actually answered makes the list "fresh".
  if (cg.status === 'fulfilled' || pythOk) good = { at: Date.now(), coins };
  else if (cg.status === 'rejected') console.warn(`coins: refresh failed — ${String(cg.reason?.message ?? cg.reason).slice(0, 80)}`);
}

/**
 * Refresh now if the last good read is older than `maxAgeMs` — for callers
 * about to sign a price, who must not sign a stale one. Shares the in-flight
 * refresh with the route.
 */
export async function refreshQuotes(maxAgeMs) {
  if (Date.now() - good.at < maxAgeMs && good.coins.length) return good.coins;
  if (Date.now() - lastAttempt < 3_000 && inflight) { await inflight.catch(() => null); return good.coins; }
  inflight ??= refresh().finally(() => { inflight = null; });
  await inflight.catch(() => null);
  return good.coins;
}

export function registerMarketRoutes(app) {
  app.get('/api/coins', async (_req, res) => {
    let age = Date.now() - good.at;
    const due = age >= TTL_MS || !good.coins.length;
    if (due && Date.now() - lastAttempt >= RETRY_MS) {
      inflight ??= refresh().finally(() => { inflight = null; });
      await inflight.catch(() => null);
      age = Date.now() - good.at;
    }
    // The age rides in a header so the body stays the plain list the client
    // renders. A large age means upstream has been failing and these are the
    // last prices anyone actually quoted.
    res.set('x-data-age-seconds', String(good.at ? Math.round(age / 1000) : -1));
    res.json(good.coins);
  });
}
