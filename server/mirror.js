/**
 * ARC TESTNET ONLY: keep each MirrorAggregator a faithful copy of its Arc
 * mainnet Chainlink feed.
 *
 * Chainlink publishes Data Feeds on Arc mainnet, not on Arc testnet, so the
 * testnet deployment points every fighter at a MirrorAggregator (contracts/
 * src/testnet). This job reads the real mainnet proxy (`source()`) and pushes
 * any rounds the mirror lacks — same round ids, answers and timestamps — so
 * the testnet contracts run exactly mainnet's code paths on mainnet's data.
 * On first run it copies a sparse seed (latest + the day-ago round and its successor) so the first meta post works; it is contiguous after 24 h of uptime.
 *
 * Runs only when the deployment says `priceFeeds: "mirror"`, and the relayer
 * (the mirrors' immutable updater) signs the pushes. Never runs on mainnet.
 */
import { createPublicClient, http } from 'viem';
import { abis, deployment, IS_MAINNET } from './chain.js';
import { AGGREGATOR_ABI, feedsOnChain } from './feeds.js';
import { relayerAddress, sendRelayerTx } from './relayer.js';

const MAINNET_RPC = process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io';
const MIRROR_ABI = [
  ...AGGREGATOR_ABI,
  { type: 'function', name: 'source', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'latestRound', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }] },
  {
    type: 'function', name: 'push', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint80[]' }, { type: 'int256[]' }, { type: 'uint64[]' }, { type: 'uint64[]' }], outputs: [],
  },
];
const SPARSE_LOOKBACK_S = 24 * 3600;

let mainnet = null;
let last = { at: 0, pushed: 0, error: null };
export const mirrorStatus = () => ({ enabled: enabled(), ...last });

const enabled = () => process.env.MIRROR_KEEPER !== '0' && !IS_MAINNET && deployment?.priceFeeds === 'mirror' && Boolean(relayerAddress());

async function syncOne(testnet, mirror) {
  mainnet ??= createPublicClient({ transport: http(MAINNET_RPC, { retryCount: 2, timeout: 15_000 }) });
  const source = await testnet.readContract({ address: mirror, abi: MIRROR_ABI, functionName: 'source' });
  const have = await testnet.readContract({ address: mirror, abi: MIRROR_ABI, functionName: 'latestRound' });
  const [latest] = await mainnet.readContract({ address: source, abi: AGGREGATOR_ABI, functionName: 'latestRoundData' });
  if (latest <= have) return 0;
  // Collect missing rounds newest-first. A mirror that has never been written
  // gets a SPARSE start (the latest round, the round current 24 h ago and the one
  // after it): that is all MarketMeta.postFromFeeds reads, and it costs ~0.1 USDC
  // instead of ~1 USDC for a full day of history. From then on every new
  // mainnet round is copied, so the mirror is contiguous after 24 h of uptime.
  const rounds = [];
  const dayAgo = Math.floor(Date.now() / 1000) - SPARSE_LOOKBACK_S;
  for (let r = latest; r > have && rounds.length < 400; r -= 1n) {
    let data;
    try { data = await mainnet.readContract({ address: source, abi: AGGREGATOR_ABI, functionName: 'getRoundData', args: [r] }); } catch { break; }
    const [, answer, startedAt, updatedAt] = data;
    if (updatedAt === 0n) break;
    rounds.push({ r, answer, startedAt, updatedAt });
    if (have === 0n && Number(updatedAt) <= dayAgo) break; // r is now the day-ago round; rounds[-2] is the one after it
  }
  if (have === 0n && rounds.length > 3) {
    // keep latest, and the last two collected (day-ago round and its successor)
    rounds.splice(1, rounds.length - 3);
  }
  rounds.reverse();
  if (!rounds.length) return 0;
  await sendRelayerTx({
    address: mirror, abi: MIRROR_ABI, functionName: 'push',
    args: [rounds.map((x) => x.r), rounds.map((x) => x.answer), rounds.map((x) => x.startedAt), rounds.map((x) => x.updatedAt)],
  });
  return rounds.length;
}

export async function tickMirror(testnetClient) {
  if (!enabled()) return 0;
  const { publicClient } = await import('./chain.js');
  const client = testnetClient ?? publicClient();
  let pushed = 0;
  for (const f of await feedsOnChain()) {
    try { pushed += await syncOne(client, f.feed); } catch (e) { last = { ...last, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160) }; }
  }
  last = { ...last, at: Date.now(), pushed: last.pushed + pushed };
  if (pushed) console.log(`mirror: copied ${pushed} Chainlink rounds from Arc mainnet`);
  return pushed;
}

export function startMirror() {
  if (!enabled()) return;
  void abis;
  const run = () => { void tickMirror().catch((e) => { last = { ...last, error: String(e?.message ?? e) }; }); };
  setTimeout(run, 1_000);
  setInterval(run, 5 * 60_000);
  console.log('mirror: keeping testnet MirrorAggregators in step with Arc mainnet Chainlink feeds');
}
