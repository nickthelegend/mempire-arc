/**
 * Chainlink Data Feeds, as the relay reads them.
 *
 * Every fighter's on-chain price is its Chainlink feed on Arc (mainnet, or a
 * local fork of it; on Arc testnet, the MirrorAggregator copy — see mirror.js).
 * The contracts read the feeds themselves: a mint stamps `latestRoundData`, and
 * `MarketMeta.postFromFeeds` derives the daily meta on chain. This module only
 * reads the same feeds for display and finds the day-ago round the keeper has
 * to point at — it never supplies a price to a contract.
 *
 * Feed addresses come from the deployed MempireCards (`roster()`), so the relay
 * always reads exactly what the contracts read.
 */
import { abis, coinById, deployment, publicClient } from './chain.js';

export const AGGREGATOR_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint80', name: 'roundId' }, { type: 'int256', name: 'answer' }, { type: 'uint256', name: 'startedAt' },
      { type: 'uint256', name: 'updatedAt' }, { type: 'uint80', name: 'answeredInRound' }],
  },
  {
    type: 'function', name: 'getRoundData', stateMutability: 'view', inputs: [{ type: 'uint80', name: 'roundId' }],
    outputs: [{ type: 'uint80', name: 'roundId' }, { type: 'int256', name: 'answer' }, { type: 'uint256', name: 'startedAt' },
      { type: 'uint256', name: 'updatedAt' }, { type: 'uint80', name: 'answeredInRound' }],
  },
];

let feedCache = null; // [{ coinId, feed, maxPriceAge }]

/** coinId → feed address, as registered on MempireCards. */
export async function feedsOnChain() {
  if (feedCache) return feedCache;
  if (!deployment?.cards) return [];
  const coins = await publicClient().readContract({ address: deployment.cards, abi: abis.cards, functionName: 'roster' });
  feedCache = coins.map((c, coinId) => ({ coinId, feed: c.feed, maxPriceAge: Number(c.maxPriceAge), active: c.active }));
  return feedCache;
}

/**
 * Latest round of every feed, in one multicall-batched sweep:
 * [{ coinId, ticker, priceUsd, answer, decimals, roundId, updatedAt, fresh }].
 */
export async function latestPrices() {
  const feeds = await feedsOnChain();
  const client = publicClient();
  const rows = await Promise.all(feeds.map(async (f) => {
    try {
      const [round, decimals] = await Promise.all([
        client.readContract({ address: f.feed, abi: AGGREGATOR_ABI, functionName: 'latestRoundData' }),
        client.readContract({ address: f.feed, abi: AGGREGATOR_ABI, functionName: 'decimals' }),
      ]);
      const [roundId, answer, , updatedAt] = round;
      if (answer <= 0n) return null;
      const now = Math.floor(Date.now() / 1000);
      return {
        coinId: f.coinId,
        ticker: coinById.get(f.coinId)?.ticker,
        priceUsd: Number(answer) / 10 ** Number(decimals),
        answer: answer.toString(),
        decimals: Number(decimals),
        roundId: roundId.toString(),
        updatedAt: Number(updatedAt),
        fresh: now - Number(updatedAt) <= f.maxPriceAge,
        source: 'chainlink',
        feed: f.feed,
      };
    } catch {
      return null;
    }
  }));
  return rows.filter(Boolean);
}

/**
 * The round that was current `lookback` seconds ago — the hint
 * `MarketMeta.postFromFeeds` verifies. Walks back from the latest round; Arc's
 * feeds have a 24 h heartbeat with a deviation trigger, so a day is usually a
 * handful of rounds. Returns null when the history is too short (e.g. a
 * testnet mirror that has not been running for a day yet).
 */
export async function roundAtOrBefore(feed, cutoff, maxSteps = 400) {
  const client = publicClient();
  const [latest] = await client.readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: 'latestRoundData' });
  let r = latest;
  for (let i = 0; i < maxSteps; i += 1) {
    let at;
    try {
      [, , , at] = await client.readContract({ address: feed, abi: AGGREGATOR_ABI, functionName: 'getRoundData', args: [r] });
    } catch {
      return null; // walked off the start of this phase / mirror history
    }
    if (at === 0n) return null;
    if (at <= BigInt(cutoff)) return r;
    if ((r & ((1n << 64n) - 1n)) <= 1n) return null;
    r -= 1n;
  }
  return null;
}
