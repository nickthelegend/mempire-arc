/**
 * The meta keeper: posts the oracle-derived market meta each ten-minute window.
 *
 * `MarketMeta.postFromOracle` is permissionless — anyone may post fresh price
 * updates and have the contract derive every fighter's modifier from
 * spot-vs-EMA in that same transaction. Someone has to actually do it each
 * window, though, and that is this loop. It only ever submits fresh signed
 * updates; the numbers are computed on chain, so the keeper cannot choose them.
 *
 * On by default on Arc mainnet (Chainlink CRE does not serve it, so this is the
 * meta's only writer) and on local forks; opt-in on Arc testnet with
 * `META_KEEPER=1`, where the CRE workflow can write instead. The two share one
 * epoch clock and whichever posts first owns the window.
 *
 * A post re-derives all 36 fighters, ~1.7M gas: about 0.04 USDC at Arc's
 * ~25 gwei, so every window is ~6 USDC a day. `META_KEEPER_EVERY=n` posts every
 * n-th window instead (6 = hourly, ~1 USDC a day); a match snapshots whatever
 * epoch was posted last, so the gaps are safe.
 */
import { abis, deployment, IS_DEV_CHAIN, IS_MAINNET, publicClient, roster } from './chain.js';
import { fetchPythUpdate, pythConfigured } from './pyth.js';
import { relayerAddress, sendRelayerTx } from './relayer.js';

const WINDOW = 600;
const EVERY = BigInt(Math.max(1, Math.floor(Number(process.env.META_KEEPER_EVERY ?? 1)) || 1));
const pythAbi = [{
  type: 'function', name: 'getUpdateFee', stateMutability: 'view',
  inputs: [{ type: 'bytes[]', name: 'updateData' }], outputs: [{ type: 'uint256' }],
}];

let last = { epoch: 0, hash: null, at: 0, error: null };
export const keeperStatus = () => ({ enabled: enabled(), ...last });

function enabled() {
  const flag = process.env.META_KEEPER;
  if (flag === '0') return false;
  return (flag === '1' || IS_DEV_CHAIN || IS_MAINNET) && Boolean(deployment?.marketMeta) && pythConfigured();
}

/** Posts this window's meta if nobody has yet. Returns the tx hash or null. */
export async function tickKeeper(now = Math.floor(Date.now() / 1000)) {
  if (!enabled() || !relayerAddress()) return null;
  const client = publicClient();
  const want = BigInt(Math.floor(now / WINDOW));
  const current = await client.readContract({ address: deployment.marketMeta, abi: abis.marketMeta, functionName: 'currentEpoch' });
  if (current >= want || want - current < EVERY) return null;
  const ids = roster.map((c) => c.coinId);
  const { updateData, prices } = await fetchPythUpdate(ids);
  const coinIds = prices.map((p) => p.coinId);
  const fee = await client.readContract({ address: deployment.oracle, abi: pythAbi, functionName: 'getUpdateFee', args: [updateData] });
  try {
    const { hash } = await sendRelayerTx({
      address: deployment.marketMeta, abi: abis.marketMeta, functionName: 'postFromOracle', args: [coinIds, updateData], value: fee,
    });
    last = { epoch: Number(want), hash, at: Date.now(), error: null };
    console.log(`keeper: posted meta epoch ${want} for ${coinIds.length} fighters (${hash.slice(0, 10)}…)`);
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
  setTimeout(run, 2_000);
  setInterval(run, 60_000);
  console.log(`keeper: posting oracle momentum meta every ${EVERY === 1n ? 'ten-minute window' : `${EVERY} windows (${Number(EVERY) * 10} min)`}`);
}
