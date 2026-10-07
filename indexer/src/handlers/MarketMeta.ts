// MarketMeta: one bounded (±15%) modifier per fighter each epoch, written by a
// Chainlink CRE report (onReport) or derived from Pyth momentum (postFromPyth).
// A coin left out of an epoch's report reads 0 on chain for that epoch, so
// every known coin's current modifier is rewritten, not just the ones in the
// report. MetaSource follows MetaPosted in the same transaction and records
// which of the two wrote the epoch.
import { indexer, type MarketEpoch } from "envio";
import { addr, meta, totals, updateCoin } from "../lib/common.js";

/** MarketMeta.SOURCE_CRE = 0, SOURCE_PYTH = 1. */
export const META_SOURCES = ["ChainlinkCRE", "PythMomentum"] as const;

indexer.onEvent({ contract: "MarketMeta", event: "MetaPosted" }, async ({ event, context }) => {
  const m = meta(event);
  const epoch = event.params.epoch;
  const epochId = epoch.toString();
  const coinIds = event.params.coinIds.map((c) => Number(c));
  const bps = event.params.bps.map((b) => Number(b));

  let top: { coinId: number; bps: number } | undefined;
  let bottom: { coinId: number; bps: number } | undefined;
  const posted = new Map<number, number>();
  for (let i = 0; i < coinIds.length; i++) {
    const coinId = coinIds[i]!;
    const b = bps[i] ?? 0;
    posted.set(coinId, b);
    if (top === undefined || b > top.bps) top = { coinId, bps: b };
    if (bottom === undefined || b < bottom.bps) bottom = { coinId, bps: b };
  }

  // Keep a source already recorded for this epoch (MetaSource normally comes
  // second, but the row must not depend on log order within the tx).
  const prior = await context.MarketEpoch.get(epochId);
  context.MarketEpoch.set({
    source: prior?.source,
    sourceCode: prior?.sourceCode,
    poster: prior?.poster,
    id: epochId,
    epoch,
    postedAt: m.ts,
    blockNumber: m.block,
    txHash: m.tx,
    coinCount: coinIds.length,
    maxBps: top?.bps ?? 0,
    minBps: bottom?.bps ?? 0,
    topCoin_id: top ? String(top.coinId) : undefined,
    bottomCoin_id: bottom ? String(bottom.coinId) : undefined,
    matches: 0,
  });

  for (const [coinId, b] of posted) {
    context.CoinModifier.set({
      id: `${epochId}-${coinId}`,
      epoch_id: epochId,
      coin_id: String(coinId),
      bps: b,
      postedAt: m.ts,
    });
    await updateCoin(context, coinId, (c) => ({ ...c, currentModifierBps: b, modifierEpoch: epoch }));
  }

  // Coins registered on chain but absent from this report are neutral this epoch.
  const g = await totals(context, (x) => ({ ...x, currentEpoch: epoch > x.currentEpoch ? epoch : x.currentEpoch }));
  for (let coinId = 0; coinId < g.coins; coinId++) {
    if (posted.has(coinId)) continue;
    const coin = await context.Coin.get(String(coinId));
    if (coin && coin.modifierEpoch < epoch) {
      context.Coin.set({ ...coin, currentModifierBps: 0, modifierEpoch: epoch });
    }
  }
});

indexer.onEvent({ contract: "MarketMeta", event: "MetaSource" }, async ({ event, context }) => {
  const m = meta(event);
  const epoch = event.params.epoch;
  const epochId = epoch.toString();
  const code = Number(event.params.source);
  const sourceFields = {
    source: META_SOURCES[code],
    sourceCode: code,
    poster: addr(event.params.poster),
  };
  const existing = await context.MarketEpoch.get(epochId);
  const base: MarketEpoch = existing ?? {
    id: epochId,
    epoch,
    postedAt: m.ts,
    blockNumber: m.block,
    txHash: m.tx,
    coinCount: 0,
    maxBps: 0,
    minBps: 0,
    topCoin_id: undefined,
    bottomCoin_id: undefined,
    matches: 0,
    source: undefined,
    sourceCode: undefined,
    poster: undefined,
  };
  context.MarketEpoch.set({ ...base, ...sourceFields });
});
