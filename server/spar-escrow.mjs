/**
 * A sparring partner that actually stakes.
 *
 * The plain `spar.mjs` holds a queue slot but never touches the chain, so the
 * arena match it pairs into stays Open — the browser seat correctly waits for
 * a join that never comes, which made the settlement half of a staked match
 * untestable rather than broken.
 *
 * This one joins the escrow for real: when the browser (seat 0) announces its
 * arena match over the relay's `chain` handshake, it reads the match with
 * `getMatch`, checks the opener is its opponent, and calls `joinMatch` with
 * eight unlocked cards of eight distinct coins at the same stake — approving
 * the arena first when the stake is AUSD. Once it joins, the match is Active
 * and the browser's play log has a second seat to run against.
 *
 * It plays no cards and never claims; the simulation is the browser's. If the
 * browser claims alone, `claimTimeout` settles it after the deadline.
 *
 *   SPAR_PRIVATE_KEY=0x… [CHAIN_ID=10143] [RPC_URL=…] [WS=wss://…/ws] [CURRENCY=MON|AUSD] node spar-escrow.mjs
 *
 * The key needs a starter deck (onboard it once) and MON for gas and stake.
 */
import WebSocket from 'ws';
import { createWalletClient, http, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abis, chain, deployment, publicClient, sameAddress, RPC_URL, ZERO_ADDRESS } from './chain.js';
import { signed } from './test-util.mjs';

const WS = process.env.WS ?? 'ws://localhost:8787/ws';
const CURRENCY = String(process.env.CURRENCY ?? 'MON').toUpperCase();
const key = process.env.SPAR_PRIVATE_KEY;
if (!key) { console.log('spar-escrow: set SPAR_PRIVATE_KEY'); process.exit(1); }
if (!deployment) { console.log('spar-escrow: no deployment for this CHAIN_ID'); process.exit(1); }

const me = privateKeyToAccount(key);
const pub = publicClient();
const wallet = createWalletClient({ account: me, chain, transport: http(RPC_URL) });
const NO_PERMIT = { deadline: 0n, v: 0, r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}` };

/** Estimated, with the same 15% margin the relayer uses: Monad bills the limit. */
async function send(call) {
  const gas = await pub.estimateContractGas({ account: me, ...call });
  const hash = await wallet.writeContract({ ...call, gas: (gas * 115n) / 100n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${call.functionName} reverted (${hash})`);
  return hash;
}

// Eight unlocked cards, one per coin — the same rule `lockDeck` enforces.
const [ids, cards, locked] = await pub.readContract({
  address: deployment.cards, abi: abis.cards, functionName: 'cardsOf', args: [me.address],
});
const byCoin = new Map();
ids.forEach((id, i) => {
  if (!locked[i] && !byCoin.has(cards[i].coinId)) byCoin.set(cards[i].coinId, { id, card: cards[i] });
});
const deck = [...byCoin.values()].slice(0, 8);
if (deck.length < 8) {
  console.log(`spar-escrow: only ${deck.length} free distinct coins — onboard this key first`);
  process.exit(1);
}
console.log(`spar-escrow: ${me.address} deck ready`, deck.map((d) => d.id).join(','));

const relayDeck = deck.map((d, i) => ({
  coinId: Number(d.card.coinId), name: `S${i}`, archetype: Number(d.card.archetype), level: Number(d.card.level),
}));

const ws = new WebSocket(WS);
let opponent = null;

ws.on('open', async () => {
  console.log(`spar-escrow: queueing tier 0, ${CURRENCY}`);
  ws.send(JSON.stringify({
    t: 'queue', ...(await signed(me, 'queue')), tier: 0, currency: CURRENCY, deck: relayDeck,
    format: 'standard', ranked: true, trophies: 16, name: 'Sparring Partner',
  }));
});

ws.on('message', async (raw) => {
  let m; try { m = JSON.parse(String(raw)); } catch { return; }
  if (m.t === 'matched') {
    console.log('spar-escrow: matched, role', m.role, 'opponent', m.opponent?.address, 'epoch', m.metaEpoch);
    if (m.role === 0) console.log('spar-escrow: we are seat 0 — the browser must queue first');
    opponent = m.opponent?.address ?? null;
    return;
  }
  if (m.t !== 'chain' || m.stage !== 'opened' || !m.onchainMatchId) return;

  const id = BigInt(m.onchainMatchId);
  try {
    // Never trust the peer's announcement: read the match it names.
    const match = await pub.readContract({ address: deployment.arena, abi: abis.arena, functionName: 'getMatch', args: [id] });
    if (Number(match.state) !== 1 || !sameAddress(match.p0, opponent)) {
      console.log(`spar-escrow: match #${id} is not an open match by our opponent — not joining`);
      return;
    }
    const isMon = sameAddress(match.currency, ZERO_ADDRESS);
    if (!isMon) {
      const allowance = await pub.readContract({
        address: match.currency, abi: abis.erc20, functionName: 'allowance', args: [me.address, deployment.arena],
      });
      if (allowance < match.stake) {
        await send({ address: match.currency, abi: abis.erc20, functionName: 'approve', args: [deployment.arena, maxUint256] });
      }
    }
    const hash = await send({
      address: deployment.arena,
      abi: abis.arena,
      functionName: 'joinMatch',
      args: [id, deck.map((d) => d.id), ZERO_ADDRESS, NO_PERMIT],
      value: isMon ? match.stake : 0n,
    });
    console.log(`spar-escrow: JOINED match #${id} — ${hash}`);
    ws.send(JSON.stringify({ t: 'chain', stage: 'joined', onchainMatchId: Number(id), txHash: hash }));
  } catch (e) {
    console.log('spar-escrow: join failed —', String(e?.shortMessage ?? e?.message).slice(0, 160));
    ws.send(JSON.stringify({ t: 'chain', stage: 'failed', onchainMatchId: Number(id), reason: 'sparring partner could not join' }));
  }
});

setTimeout(() => { console.log('spar-escrow: done'); process.exit(0); }, 150000);
