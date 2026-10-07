/**
 * Market data for the roster — what each fighter's asset is trading at.
 *
 * The price is Chainlink's: every fighter's Data Feed on Arc, read from the
 * same proxies the contracts read (feeds.js). The 24-hour move shown beside it
 * comes from OKX's public spot tickers (keyless), topped up from CoinGecko —
 * display only; the move that actually buffs or nerfs a fighter is computed
 * on chain by MarketMeta from the feeds themselves. FX fighters have no
 * exchange ticker, so their display change is the feed's own day-ago round.
 *
 * Cached for thirty seconds; a failed refresh serves the last good answer.
 * Nothing here is ever estimated: a fighter whose feed can't be read is left
 * out rather than shown at a number nobody published.
 */
import { roster } from './chain.js';
import { AGGREGATOR_ABI, feedsOnChain, latestPrices, roundAtOrBefore } from './feeds.js';
import { publicClient } from './chain.js';

const TTL_MS = 30_000;
const RETRY_MS = 15_000;
const OKX = 'https://www.okx.com/api/v5/market/tickers?instType=SPOT';

let good = { at: 0, coins: [] };
let lastAttempt = 0;
let inflight = null;
const fxChange = new Map(); // coinId → { at, change24h }

/** 24h % change for crypto fighters from OKX, keyed by coinId. */
async function okxChanges() {
  const res = await fetch(OKX, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`okx answered ${res.status}`);
  const body = await res.json();
  if (body?.code !== '0' || !Array.isArray(body.data)) throw new Error('okx returned no tickers');
  const byInst = new Map(body.data.map((t) => [t.instId, t]));
  const out = new Map();
  for (const c of roster) {
    if (c.kind === 'rwa' && c.ticker !== 'PAXG') continue;
    const t = byInst.get(`${c.ticker}-USDT`) ?? byInst.get(`${c.ticker}-USDC`);
    const last = Number(t?.last);
    const open = Number(t?.open24h);
    if (last > 0 && open > 0) out.set(c.coinId, ((last - open) / open) * 100);
  }
  return out;
}

/** FX fighters: the feed's own move since its day-ago round (cached for 10 min). */
async function feedChange(coinId, feed, answerNow) {
  const hit = fxChange.get(coinId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.change24h;
  const r = await roundAtOrBefore(feed, Math.floor(Date.now() / 1000) - 86_400, 50).catch(() => null);
  if (r === null) return null;
  const [, then] = await publicClient().readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: 'getRoundData', args: [r] });
  const change24h = then > 0n ? (Number(BigInt(answerNow) - then) / Number(then)) * 100 : null;
  fxChange.set(coinId, { at: Date.now(), change24h });
  return change24h;
}

async function refresh() {
  lastAttempt = Date.now();
  const [prices, changes] = await Promise.all([latestPrices(), okxChanges().catch(() => new Map())]);
  if (!prices.length) throw new Error('no Chainlink feed could be read');
  const feeds = new Map((await feedsOnChain()).map((f) => [f.coinId, f.feed]));
  const coins = await Promise.all(prices.map(async (p) => ({
    ...p,
    change24h: changes.get(p.coinId) ?? await feedChange(p.coinId, feeds.get(p.coinId), p.answer).catch(() => null),
    at: p.updatedAt,
  })));
  good = { at: Date.now(), coins: coins.sort((a, b) => a.coinId - b.coinId) };
}

export async function refreshQuotes(maxAgeMs) {
  if (Date.now() - good.at < maxAgeMs && good.coins.length) return good.coins;
  inflight ??= refresh().finally(() => { inflight = null; });
  await inflight.catch(() => null);
  return good.coins;
}

export function registerMarketRoutes(app) {
  app.get('/api/coins', async (_req, res) => {
    let age = Date.now() - good.at;
    if ((age >= TTL_MS || !good.coins.length) && Date.now() - lastAttempt >= RETRY_MS) {
      inflight ??= refresh().finally(() => { inflight = null; });
      await inflight.catch((e) => console.warn(`coins: refresh failed — ${String(e?.message ?? e).slice(0, 80)}`));
      age = Date.now() - good.at;
    }
    res.set('x-data-age-seconds', String(good.at ? Math.round(age / 1000) : -1));
    res.json(good.coins);
  });
}
