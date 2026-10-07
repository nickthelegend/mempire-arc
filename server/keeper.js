/**
 * The meta keeper: posts the Chainlink-derived market meta each window.
 *
 * `MarketMeta.postFromFeeds` is permissionless: the contract reads every
 * fighter's Chainlink feed itself and computes its 24-hour move on chain. All
 * the caller supplies is, per fighter, the feed round that was current 24 hours
 * ago — and the contract checks that round is exactly right, so the keeper
 * cannot choose or shop the numbers. Finding those rounds (walking
 * `getRoundData` back from the latest) is the only thing this loop does.
 *
 * On by default on Arc mainnet (CRE does not serve it) and local forks; on Arc
 * testnet set META_KEEPER=1 (the CRE workflow can write instead). A post
 * re-derives 20 fighters, ~1M gas — about 0.02–0.04 USDC on Arc —
 * and META_KEEPER_EVERY=n posts every n-th ten-minute window (6 = hourly,
 * well under a dollar a day). A match snapshots whatever epoch was posted last.
 */
import { abis, deployment, IS_DEV_CHAIN, IS_MAINNET, publicClient } from './chain.js';
import { feedsOnChain, roundAtOrBefore } from './feeds.js';
import { relayerAddress, sendRelayerTx } from './relayer.js';

const WINDOW = 600;
const DAY = 86_400;
const EVERY = BigInt(Math.max(1, Math.floor(Number(process.env.META_KEEPER_EVERY ?? 6)) || 1));

let last = { epoch: 0, hash: null, at: 0, error: null, fighters: 0 };
export const keeperStatus = () => ({ enabled: enabled(), ...last });

function enabled() {
  const flag = process.env.META_KEEPER;
  if (flag === '0') return false;
  return (flag === '1' || IS_DEV_CHAIN || IS_MAINNET) && Boolean(deployment?.marketMeta);
}

/** The day-ago round for every fighter whose feed has a day of history. */
export async function dayAgoHints(now = Math.floor(Date.now() / 1000)) {
  const feeds = (await feedsOnChain()).filter((f) => f.active);
  const hints = await Promise.all(feeds.map(async (f) => ({ coinId: f.coinId, round: await roundAtOrBefore(f.feed, now - DAY).catch(() => null) })));
  return hints.filter((h) => h.round !== null);
}

/** Posts this window's meta if nobody has yet. Returns the tx hash or null. */
export async function tickKeeper(now = Math.floor(Date.now() / 1000)) {
  if (!enabled() || !relayerAddress()) return null;
  const client = publicClient();
  const want = BigInt(Math.floor(now / WINDOW));
  const current = await client.readContract({ address: deployment.marketMeta, abi: abis.marketMeta, functionName: 'currentEpoch' });
  if (current >= want || want - current < EVERY) return null;
  const block = await client.getBlock();
  const hints = await dayAgoHints(Number(block.timestamp));
  if (!hints.length) { last = { ...last, error: 'no feed has 24h of history yet' }; return null; }
  try {
    const { hash } = await sendRelayerTx({
      address: deployment.marketMeta, abi: abis.marketMeta, functionName: 'postFromFeeds',
      args: [hints.map((h) => h.coinId), hints.map((h) => h.round)],
    });
    last = { epoch: Number(want), hash, at: Date.now(), error: null, fighters: hints.length };
    console.log(`keeper: posted Chainlink meta epoch ${want} for ${hints.length} fighters (${hash.slice(0, 10)}…)`);
    return hash;
  } catch (e) {
    last = { ...last, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160) };
    // StaleEpoch: someone else (CRE, another keeper) took the window. Fine.
    if (!/StaleEpoch/.test(last.error)) console.warn(`keeper: ${last.error}`);
    return null;
  }
}

export function startKeeper() {
  if (!enabled()) return;
  const run = () => { void tickKeeper().catch((e) => { last = { ...last, error: String(e?.message ?? e) }; }); };
  setTimeout(run, 3_000);
  setInterval(run, 60_000);
  console.log(`keeper: posting Chainlink-feed meta every ${EVERY === 1n ? 'ten-minute window' : `${EVERY} windows (${Number(EVERY) * 10} min)`}`);
}
