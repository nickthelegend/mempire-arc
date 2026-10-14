/**
 * Finish cross-chain instructions whose dollars arrived late.
 *
 * A player on Base or Ethereum enters a match with one source transaction:
 * CCTP V2 moves the USDC to their address on Arc, and a CCIP message carries
 * the instruction to MempireCCIPGateway. The two travel independently; when
 * the CCIP message lands first, the gateway can't stake money that isn't there
 * yet, so it stores the message (by hash) and logs it in `MessageFailed`.
 *
 * Retrying is permissionless — the outcome is fixed by the message — so this
 * job does it for the player: it reads the gateway's MessageFailed logs,
 * simulates `retryFailedMessage` with the logged message, and sends it once the
 * simulation passes (i.e. once CCTP has minted). It never sends a retry that
 * would revert, and it needs no special role: anyone could run it.
 */
import { decodeEventLog, parseAbiItem } from 'viem';
import { abis, deployment, publicClient } from './chain.js';
import { relayerAddress, sendRelayerTx } from './relayer.js';

const FAILED = parseAbiItem('event MessageFailed(bytes32 indexed messageId, uint64 indexed sourceChainSelector, bytes sender, bytes data, bytes reason)');
const CHUNK = 100n; // Arc public RPC log-range limit
const pending = new Map(); // messageId → { message, firstSeen }
const done = new Set();
let fromBlock = null;
let last = { at: 0, retried: 0, waiting: 0, error: null };
export const ccipWatchStatus = () => ({ enabled: enabled(), ...last, waiting: pending.size });

const enabled = () => Boolean(deployment?.ccipGateway && deployment.ccipGateway !== '0x0000000000000000000000000000000000000000' && relayerAddress());

export async function tickCcipWatch() {
  if (!enabled()) return 0;
  const client = publicClient();
  const head = await client.getBlockNumber();
  fromBlock ??= BigInt(deployment.startBlock ?? head);
  // Catch up in bounded chunks: public RPCs cap eth_getLogs ranges.
  let chunks = 0;
  while (head >= fromBlock && chunks++ < 10) {
    const to = fromBlock + CHUNK - 1n < head ? fromBlock + CHUNK - 1n : head;
    const logs = await client.getLogs({ address: deployment.ccipGateway, event: FAILED, fromBlock, toBlock: to });
    for (const l of logs) {
      const { args } = decodeEventLog({ abi: [FAILED], data: l.data, topics: l.topics });
      if (done.has(args.messageId)) continue;
      pending.set(args.messageId, {
        message: { messageId: args.messageId, sourceChainSelector: args.sourceChainSelector, sender: args.sender, data: args.data, destTokenAmounts: [] },
        firstSeen: Date.now(),
      });
    }
    fromBlock = to + 1n;
  }
  let retried = 0;
  for (const [id, p] of pending) {
    const status = await client.readContract({ address: deployment.ccipGateway, abi: abis.gateway, functionName: 'messageStatus', args: [id] });
    if (Number(status) !== 1) { pending.delete(id); done.add(id); continue; } // resolved by someone else
    try {
      await client.simulateContract({
        address: deployment.ccipGateway, abi: abis.gateway, functionName: 'retryFailedMessage', args: [p.message], account: relayerAddress(),
      });
    } catch { continue; } // the dollars aren't there yet (or the permit expired): try again next tick
    try {
      const { hash } = await sendRelayerTx({ address: deployment.ccipGateway, abi: abis.gateway, functionName: 'retryFailedMessage', args: [p.message] });
      console.log(`ccip: completed stored message ${id.slice(0, 10)}… (${hash.slice(0, 10)}…)`);
      pending.delete(id);
      done.add(id);
      retried += 1;
    } catch (e) {
      last = { ...last, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160) };
    }
  }
  last = { ...last, error: null, at: Date.now(), retried: last.retried + retried };
  return retried;
}

export function startCcipWatch() {
  if (!enabled()) return;
  const run = () => { void tickCcipWatch().catch((e) => { last = { ...last, error: String(e?.message ?? e) }; }); };
  setTimeout(run, 2_000);
  setInterval(run, 20_000);
  console.log(`ccip: watching ${deployment.ccipGateway} for instructions that beat their CCTP transfer`);
}
