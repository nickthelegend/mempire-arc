/**
 * LIVE Arc TESTNET end to end. Real transactions, real relay, real deployment
 * (deployments/arc-testnet.json). Nothing is forked or simulated by the chain.
 *
 *   1. two players onboard through the relay (starter deck minted by the relayer)
 *   2. a card is minted for USDC at the feed price (the testnet feed is a MIRROR of the
 *      Arc-mainnet Chainlink round - see docs/E2E-TESTNET.md)
 *   3. the daily meta is posted by the relayer via MarketMeta.postFromFeeds
 *   4. a $1 USDC staked match: both queue on the relay's WebSocket, are paired, seat 0 opens
 *      the escrow, seat 1 joins it after reading it back from the chain
 *   5. the match itself is the app's REAL deterministic simulation (bots drive both seats,
 *      run faster than real time); the first plays are logged on chain by the session keys
 *      and relayed over the WebSocket; both seats claim the sim's result
 *   6. the second claim settles: the winner is paid 90% of the pot in the same block
 *   7. both players report the match to the relay -> leaderboard + history
 *   8. (if AI_AGENT_ID is registered) the winner rates the AI opponent on ERC-8004
 *
 * Run (keys are sourced inside the command, never printed):
 *   cd server && set -a && . ./.env.local && set +a && ../app/node_modules/.bin/tsx test-e2e-testnet.mjs
 * Needs a relay on RELAY (default http://127.0.0.1:8780) pointed at chain 5042002, and
 * ../.local/testnet-players.json funded (see docs/E2E-TESTNET.md).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { createWalletClient, erc20Abi, formatUnits, http, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { abis, chain, coinById, deployment, feeParams, publicClient, RPC_URL, USDC } from './chain.js';
import { client, signed, tally, usdcPermit } from './test-util.mjs';
import { createMatch, hashState, stepSim } from '../app/src/sim/engine';
import { decideBot } from '../app/src/sim/bot';
import { HASH_EVERY_TICKS, OVERTIME_TICKS, REGULATION_TICKS } from '../app/src/sim/types';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8780';
const WS_URL = RELAY.replace(/^http/, 'ws') + '/ws';
const EXPLORER = 'https://explorer.testnet.arc.io';
const PLAYS_ON_CHAIN = Number(process.env.PLAYS_ON_CHAIN ?? 8); // per seat; the sim itself plays every input
const FLOAT = 20_000n; // 0.02 USDC of gas for each session key
const OUT = new URL('../docs/e2e-testnet-run.json', import.meta.url);

const keys = JSON.parse(readFileSync(new URL('../.local/testnet-players.json', import.meta.url), 'utf8'));
const acct = (n) => privateKeyToAccount(keys[n].key);
const [p0, p1, s0, s1] = ['p0', 'p1', 's0', 's1'].map(acct);
const pub = publicClient();
const { check, done } = tally();
const req = client(RELAY);
const txs = []; // { label, hash }
const link = (h) => `${EXPLORER}/tx/${h}`;
const wallet = (a) => createWalletClient({ account: a, chain, transport: http(RPC_URL) });
const NO_PERMIT = { deadline: 0n, v: 0, r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}` };

async function send(account, call, label) {
  const gas = await pub.estimateContractGas({ account, ...call });
  const hash = await wallet(account).writeContract({ ...call, gas: (gas * 112n) / 100n, ...(await feeParams()) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label ?? call.functionName} reverted (${hash})`);
  txs.push({ label: label ?? call.functionName, hash, gas: r.gasUsed.toString() });
  return r;
}
const rd = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const usdcOf = (a) => rd(USDC, erc20Abi, 'balanceOf', [a]);
const fmt = (n) => formatUnits(n, 6);
const dep = deployment;
const AGG = [
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
  { type: 'function', name: 'getRoundData', stateMutability: 'view', inputs: [{ type: 'uint80' }], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
  { type: 'function', name: 'source', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

console.log(`LIVE Arc testnet e2e -> chain ${chain.id}, relay ${RELAY}\n`);
const health = await req('GET', '/api/health');
check('relay is up and on Arc testnet', health.data?.chain?.chainId === 5042002 && health.data.chain.prices === 'mirror');
const start = { p0: await usdcOf(p0.address), p1: await usdcOf(p1.address), t: await usdcOf(dep.treasury) };
check('players are funded (throwaway keys in .local/testnet-players.json)', start.p0 > 1_030_000n && start.p1 > 1_030_000n, `${fmt(start.p0)} / ${fmt(start.p1)}`);

// ── 1. onboarding ──────────────────────────────────────────────────────────────
console.log('1. onboarding through the relay');
for (const p of [p0, p1]) {
  const r = await req('POST', '/api/onboard', await signed(p, 'onboard'));
  check(`onboard ${p.address.slice(0, 8)} (or already onboarded)`, r.status === 200 || /already onboarded/.test(r.data?.error ?? ''), JSON.stringify(r.data).slice(0, 200));
}
const deckOf = async (a) => {
  const [ids, data, locked] = await rd(dep.cards, abis.cards, 'cardsOf', [a.address]);
  const seen = new Set();
  const picked = [];
  ids.forEach((id, i) => { if (!locked[i] && !seen.has(Number(data[i].coinId)) && picked.length < 8) { seen.add(Number(data[i].coinId)); picked.push({ id, c: data[i] }); } });
  return picked;
};
let d0 = await deckOf(p0);
let d1 = await deckOf(p1);
check('both hold an 8-fighter starter deck minted on chain', d0.length === 8 && d1.length === 8);
const onboardTx = (await rd(dep.cards, abis.cards, 'starterClaimed', [p0.address]).catch(() => null));
void onboardTx;

// ── 2. mint at the feed price ─────────────────────────────────────────────────
console.log('\n2. mint a fighter at its feed price');
const coinId = 0; // BTC
const coin = await rd(dep.cards, abis.cards, 'coin', [coinId]);
const [, mirrorAnswer, , mirrorAt] = await rd(coin.feed, AGG, 'latestRoundData');
const mintFee = await rd(dep.cards, abis.cards, 'mintFee');
const tBefore = await usdcOf(dep.treasury);
const have = (await rd(dep.cards, abis.cards, 'cardsOf', [p0.address]))[0].length;
const mintRc = have > 8 ? null : await send(p0, {
  address: dep.cards, abi: abis.cards, functionName: 'mint',
  args: [coinId, await usdcPermit(p0, pub, chain.id, dep.cards, mintFee)],
}, 'mint BTC card ($0.05, permit inside the tx)');
const [ids0, data0] = await rd(dep.cards, abis.cards, 'cardsOf', [p0.address]);
const minted = data0.find((c, i) => i >= 8 && Number(c.coinId) === coinId) ?? data0[ids0.length - 1];
check('card stamped with the feed answer at mint', minted.mintPrice === mirrorAnswer && Number(minted.coinId) === coinId, `${minted.mintPrice} vs ${mirrorAnswer}`);
if (mintRc) check('mint fee reached the treasury', (await usdcOf(dep.treasury)) - tBefore >= mintFee);
const mirrorSource = await rd(coin.feed, AGG, 'source');
console.log(`  BTC/USD mirror ${coin.feed} <- Arc mainnet Chainlink ${mirrorSource}; price ${Number(mirrorAnswer) / 1e8}, mirrored round updatedAt ${new Date(Number(mirrorAt) * 1000).toISOString()}`);
void mintRc;

// ── 3. daily meta ─────────────────────────────────────────────────────────────
console.log('\n3. daily meta (MarketMeta.postFromFeeds, relayer-signed)');
const MAINNET_RPC = process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io';
const { createPublicClient } = await import('viem');
const mainnet = createPublicClient({ transport: http(MAINNET_RPC) });
const block = await pub.getBlock();
const cutoff = block.timestamp - 86_400n;
const roster = await rd(dep.cards, abis.cards, 'roster');
const hints = [];
for (let i = 0; i < roster.length; i += 1) {
  const feed = roster[i].feed;
  const src = await rd(feed, AGG, 'source');
  let [r] = await mainnet.readContract({ address: src, abi: AGG, functionName: 'latestRoundData' });
  for (let n = 0; n < 400; n += 1, r -= 1n) {
    const [, , , at] = await mainnet.readContract({ address: src, abi: AGG, functionName: 'getRoundData', args: [r] });
    if (at <= cutoff) break;
  }
  const ok = await rd(dep.marketMeta, abis.marketMeta, 'feedMomentumBps', [i, r]).then(() => true).catch(() => false);
  if (ok) hints.push({ coinId: i, round: r });
}
check('the day-ago round of most fighters is on the mirror and accepted by the contract', hints.length >= 10, `${hints.length}/20`);
let metaHash = null;
const epochNow = await rd(dep.marketMeta, abis.marketMeta, 'currentEpoch');
const fresh = epochNow > 0n && BigInt(block.timestamp) / 600n - epochNow < 6n && Number(await rd(dep.marketMeta, abis.marketMeta, 'epochSource', [epochNow])) === 1;
if (fresh) console.log(`  meta epoch ${epochNow} (feed-sourced) is under an hour old - reusing it`);
else if (process.env.RELAYER_PRIVATE_KEY) {
  const relayer = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY);
  const r = await send(relayer, {
    address: dep.marketMeta, abi: abis.marketMeta, functionName: 'postFromFeeds',
    args: [hints.map((h) => h.coinId), hints.map((h) => h.round)],
  }, `postFromFeeds (${hints.length} fighters)`);
  metaHash = r.transactionHash;
}
const epoch = await rd(dep.marketMeta, abis.marketMeta, 'currentEpoch');
check('a feed-sourced meta epoch exists', epoch > 0n && Number(await rd(dep.marketMeta, abis.marketMeta, 'epochSource', [epoch])) === 1, String(epoch));
const mods = {};
for (const h of hints) mods[h.coinId] = Number(await rd(dep.marketMeta, abis.marketMeta, 'modifierBps', [epoch, h.coinId]));
console.log('  modifiers (bps):', Object.entries(mods).slice(0, 8).map(([k, v]) => `${coinById.get(Number(k))?.ticker}:${v}`).join(' '));
void metaHash;

// ── 4. a staked match through the relay ──────────────────────────────────────
console.log('\n4. a $1 USDC staked match, paired by the relay');
d0 = await deckOf(p0);
d1 = await deckOf(p1);
const relayDeck = (d) => d.map(({ c }) => {
  const k = coinById.get(Number(c.coinId));
  return { coinId: k.feedId.toLowerCase(), name: k.ticker, archetype: Number(c.archetype), level: Number(c.level) };
});
const mkSocket = (name) => {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    const w = waiters.findIndex((x) => x.t === m.t);
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m); else inbox.push(m);
  });
  return {
    name, ws,
    open: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (m) => ws.send(JSON.stringify(m)),
    next: (t, ms = 30_000) => {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: timeout waiting for ${t}`)), ms);
        waiters.push({ t, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
  };
};
const c0 = mkSocket('seat-a');
const c1 = mkSocket('seat-b');
await Promise.all([c0.open(), c1.open()]);
const queue = async (c, p, deck) => c.send({
  t: 'queue', ...(await signed(p, 'queue')), tier: 0, currency: 'USDC', deck: relayDeck(deck),
  format: 'standard', ranked: true, trophies: 0, name: p === p0 ? 'Testnet e2e A' : 'Testnet e2e B',
});
await queue(c0, p0, d0);
await new Promise((r) => { setTimeout(r, 1500); });
await queue(c1, p1, d1);
const [m0, m1] = await Promise.all([c0.next('matched'), c1.next('matched')]);
check('the relay paired the two wallets (ranked, $1 USDC tier)', m0.role !== m1.role && m0.metaEpoch === m1.metaEpoch && m0.seed === m1.seed, `roles ${m0.role}/${m1.role}, epoch ${m0.metaEpoch}`);
const seat0 = m0.role === 0 ? { p: p0, s: s0, c: c0, d: d0 } : { p: p1, s: s1, c: c1, d: d1 };
const seat1 = m0.role === 0 ? { p: p1, s: s1, c: c1, d: d1 } : { p: p0, s: s0, c: c0, d: d0 };
const stake = await rd(dep.arena, abis.arena, 'stakeFor', [0]);
const matchId = await rd(dep.arena, abis.arena, 'nextMatchId');
await send(seat0.p, {
  address: dep.arena, abi: abis.arena, functionName: 'createMatch',
  args: [0, seat0.d.map((x) => x.id), seat0.s.address, FLOAT, await usdcPermit(seat0.p, pub, chain.id, dep.arena, stake + FLOAT)],
}, `createMatch #${matchId} ($1 stake + permit + session float)`);
seat0.c.send({ t: 'chain', stage: 'opened', onchainMatchId: Number(matchId), txHash: txs.at(-1).hash });
const opened = await seat1.c.next('chain');
check('seat 1 got the escrow handshake over the relay', opened.stage === 'opened' && opened.onchainMatchId === Number(matchId));
const seen = await rd(dep.arena, abis.arena, 'getMatch', [matchId]);
check('seat 1 read the match back from chain before staking (open, opened by seat 0)', Number(seen.state) === 1 && seen.p0 === seat0.p.address);
await send(seat1.p, {
  address: dep.arena, abi: abis.arena, functionName: 'joinMatch',
  args: [matchId, seat1.d.map((x) => x.id), seat1.s.address, FLOAT, await usdcPermit(seat1.p, pub, chain.id, dep.arena, stake + FLOAT)],
}, `joinMatch #${matchId} ($1 stake + permit + session float)`);
seat1.c.send({ t: 'chain', stage: 'joined', onchainMatchId: Number(matchId), txHash: txs.at(-1).hash });
const joined = await seat0.c.next('chain');
check('seat 0 saw the join over the relay', joined.stage === 'joined');
const active = await rd(dep.arena, abis.arena, 'getMatch', [matchId]);
check('both stakes escrowed, match Active, meta epoch snapshotted', Number(active.state) === 2 && active.metaEpoch === epoch, `epoch ${active.metaEpoch}`);
check('arena holds the $2 pot', (await usdcOf(dep.arena)) >= stake * 2n);

// ── 5. the match: the app's real sim ─────────────────────────────────────────
console.log('\n5. the match (real lockstep sim, bot-driven, run faster than real time)');
const mcard = (d, bps) => d.map(({ c }) => {
  const k = coinById.get(Number(c.coinId));
  return { coinId: k.feedId.toLowerCase(), name: k.ticker, archetype: Number(c.archetype), level: Number(c.level), metaBps: bps[Number(c.coinId)] ?? 0 };
});
const sim = createMatch(m0.seed, [mcard(seat0.d, mods), mcard(seat1.d, mods)]);
const pending = new Map();
const hashes = [];
const events = [];
const cap = REGULATION_TICKS + OVERTIME_TICKS + 10;
while (sim.phase !== 'ended' && sim.tick < cap) {
  for (const player of [0, 1]) {
    const ev = decideBot(sim, player, player === 0 ? 'hard' : 'normal');
    if (ev) { events.push(ev); pending.set(ev.tick, [...(pending.get(ev.tick) ?? []), ev]); }
  }
  stepSim(sim, pending.get(sim.tick) ?? []);
  pending.delete(sim.tick - 1);
  if (sim.tick % HASH_EVERY_TICKS === 0) hashes.push(hashState(sim));
}
const winnerSeat = sim.winner === -2 ? 2 : sim.winner;
const finalHash = toHex(BigInt((hashes.at(-1) ?? 0) >>> 0), { size: 32 });
console.log(`  sim ended: phase ${sim.phase}, tick ${sim.tick} (${(sim.tick / 20).toFixed(0)} s of game time), ${events.length} drops, winner seat ${winnerSeat}`);
check('the sim reached a result', sim.phase === 'ended' && (winnerSeat === 0 || winnerSeat === 1), `winner ${winnerSeat}`);
const bySeat = [events.filter((e) => e.player === 0), events.filter((e) => e.player === 1)];
const logged = [0, 0];
for (const seat of [0, 1]) {
  const who = seat === 0 ? seat0 : seat1;
  for (const e of bySeat[seat].slice(0, PLAYS_ON_CHAIN)) {
    who.c.send({ t: 'input', input: { tick: e.tick, player: seat, deckIndex: e.deckIndex, x: e.x, y: e.y } });
    await send(who.s, { address: dep.arena, abi: abis.arena, functionName: 'play', args: [matchId, e.tick, e.deckIndex, e.x, e.y] }, `play seat ${seat} tick ${e.tick}`);
    logged[seat] += 1;
  }
}
await send(seat0.s, { address: dep.arena, abi: abis.arena, functionName: 'checkpoint', args: [matchId, Math.min(sim.tick, 4000), BigInt(hashes.at(-1) >>> 0)] }, 'checkpoint');
const mid = await rd(dep.arena, abis.arena, 'getMatch', [matchId]);
check(`the play log holds ${logged[0] + logged[1]} card drops from the session keys`, Number(mid.plays0) === logged[0] && Number(mid.plays1) === logged[1], `${mid.plays0}/${mid.plays1}`);

// ── 6. settlement ────────────────────────────────────────────────────────────
console.log('\n6. both seats claim the sim result; the second claim settles');
// A settling claim costs ~0.01 USDC of gas; the float (0.02) is mostly spent by then, so top up what is short.
for (const who of [seat0, seat1]) {
  const have = await pub.getBalance({ address: who.s.address });
  if (have < 16_000_000_000_000_000n) {
    const h = await wallet(who.p).sendTransaction({ to: who.s.address, value: 8_000_000_000_000_000n, ...(await feeParams()) });
    await pub.waitForTransactionReceipt({ hash: h });
    txs.push({ label: `top up session key gas (0.008 USDC, from its player)`, hash: h });
  }
}
const before = { w: await usdcOf((winnerSeat === 0 ? seat0 : seat1).p.address), t: await usdcOf(dep.treasury) };
await send(seat0.s, { address: dep.arena, abi: abis.arena, functionName: 'claim', args: [matchId, winnerSeat, finalHash] }, `claim seat 0 -> winner seat ${winnerSeat}`);
const settleRc = await send(seat1.s, { address: dep.arena, abi: abis.arena, functionName: 'claim', args: [matchId, winnerSeat, finalHash] }, `claim seat 1 -> winner seat ${winnerSeat} (settles)`);
const fin = await rd(dep.arena, abis.arena, 'getMatch', [matchId]);
check('match settled on the second claim', Number(fin.state) === 3 && Number(fin.winner) === winnerSeat);
if (winnerSeat < 2) {
  const w = winnerSeat === 0 ? seat0 : seat1;
  const gain = (await usdcOf(w.p.address)) - before.w;
  check('the winner was paid 90% of the $2 pot ($1.80)', gain === 1_800_000n, fmt(gain));
  check('the treasury got the 10% rake ($0.20)', (await usdcOf(dep.treasury)) - before.t === 200_000n);
  check('the arena holds nothing after settlement', (await usdcOf(dep.arena)) === 0n);
  const mem = await rd(dep.token, erc20Abi, 'balanceOf', [w.p.address]);
  check('the winner also got the $MEMPIRE reward', mem > 0n, fmt(mem * 1_000_000n / 10n ** 18n));
}
for (const c of [c0, c1]) { c.send({ t: 'ended' }); }

// ── 7. report to the relay: leaderboard + history ────────────────────────────
console.log('\n7. report to the relay (chain-verified)');
for (const [seat, who] of [[0, seat0], [1, seat1]]) {
  const r = await req('POST', `/api/match/${who.p.address}`, await signed(who.p, 'match.post', {
    won: winnerSeat === seat, draw: winnerSeat === 2, crowns: winnerSeat === seat ? [1, 0] : [0, 1], escrowed: true, matchId: Number(matchId), currency: 'USDC',
  }));
  check(`seat ${seat} result accepted`, r.status === 200, JSON.stringify(r.data).slice(0, 160));
}
const board = (await req('GET', '/api/leaderboard')).data;
const winRow = Array.isArray(board) ? board.find((r) => r.address === (winnerSeat === 0 ? seat0 : seat1).p.address.toLowerCase()) : null;
check('the leaderboard shows the winner with chain-verified net USDC', Boolean(winRow) && winRow.netUsdc > 0, JSON.stringify(winRow));

// ── 8. ERC-8004 rating of the AI opponent ─────────────────────────────────────
console.log('\n8. rate the AI opponent on ERC-8004');
const agentInfo = (await req('GET', '/api/agent')).data;
let ratingTx = null;
if (agentInfo?.registered) {
  const rep = agentInfo.registries.reputation;
  const w = winnerSeat === 0 ? seat0.p : seat1.p;
  const repAbi = [{ type: 'function', name: 'giveFeedback', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256' }, { type: 'int128' }, { type: 'uint8' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }], outputs: [] }];
  try {
    const r = await send(w, {
      address: rep, abi: repAbi, functionName: 'giveFeedback',
      args: [BigInt(agentInfo.agentId), 90n, 0, 'mempire.match', 'player-won', '', '', `0x${'00'.repeat(32)}`],
    }, 'ERC-8004 giveFeedback (rate the AI opponent)');
    ratingTx = r.transactionHash;
    check('ERC-8004 feedback landed', true);
  } catch (e) { check('ERC-8004 feedback landed', false, String(e?.shortMessage ?? e).slice(0, 160)); }
} else {
  console.log('  AI agent not registered on this deployment (/api/agent registered:false) - skipped');
}
void ratingTx;

const end = { p0: await usdcOf(p0.address), p1: await usdcOf(p1.address) };
console.log(`\nfinal USDC: p0 ${fmt(end.p0)} (was ${fmt(start.p0)}), p1 ${fmt(end.p1)} (was ${fmt(start.p1)})`);
writeFileSync(OUT, JSON.stringify({
  chainId: chain.id, matchId: Number(matchId), winnerSeat, players: { p0: p0.address, p1: p1.address, s0: s0.address, s1: s1.address },
  seats: { 0: seat0.p.address, 1: seat1.p.address }, metaEpoch: Number(epoch), simTicks: sim.tick, drops: events.length, onChainPlays: logged,
  txs: txs.map((t) => ({ ...t, url: link(t.hash) })),
}, null, 2));
for (const t of txs) console.log(`  ${t.label}\n    ${link(t.hash)}`);
c0.ws.close(); c1.ws.close();
process.exit(done() ? 1 : 0);
