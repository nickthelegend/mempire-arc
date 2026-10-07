/**
 * Chain-verified money, end to end on the local anvil deployment.
 *
 * Two fresh wallets are onboarded through the relay (starter deck + 2 USDC
 * drip), stake a $1 Pauper match in USDC on `MempireArena` — one seat with an
 * EIP-2612 permit inside the stake tx, the other with a plain allowance — and
 * both claim seat 0 as the winner, which settles the pot on the second claim.
 * The USDC balances must move exactly: winner +$0.80 net, loser −$1, treasury
 * +$0.20. Then each reports the match to `/api/match`, and the leaderboard's
 * USDC column must show exactly what the arena paid. A report before settlement
 * must come back `pending` and be credited on the retry, never twice.
 *
 *   node test-settlement.mjs   (forks Arc testnet with arc-anvil on :8711, chain 31338)
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, maxUint256, parseEther, zeroAddress } from 'viem';
import { startTestChain } from './test-chain.mjs';
import { USDC, client, devKey, freshAccount, signed, startRelay, tally, usdcPermit } from './test-util.mjs';

const tc = await startTestChain();
const RPC_URL = tc.rpcUrl;
const PORT = Number(process.env.PORT ?? 8794);
const RELAYER_KEY = devKey(1);

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const dep = tc.dep;
const cardsAbi = read('./shared/abi/MempireCards.json');
const arenaAbi = read('./shared/abi/MempireArena.json');
const { chain } = tc;
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const NO_PERMIT = { deadline: 0n, v: 0, r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}` };

const { check, done } = tally();
console.log(`settlement → Arc fork ${RPC_URL}, relay :${PORT}\n`);
const usdcOf = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const relay = await startRelay(PORT, { CHAIN_ID: String(tc.chainId), RPC_URL, RELAYER_PRIVATE_KEY: RELAYER_KEY });
const req = client(relay.base);

async function write(account, call) {
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const hash = await wallet.writeContract(call);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${call.functionName} reverted`);
  return r;
}

try {
  const [p0, p1] = [freshAccount(), freshAccount()];
  console.log('1. onboard both seats');
  const onboarded = await Promise.all([p0, p1].map(async (a) => req('POST', '/api/onboard', await signed(a, 'onboard'))));
  check('both onboard', onboarded.every((r) => r.status === 200), onboarded.map((r) => r.status).join(','));
  const deckOf = async (a) => (await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'cardsOf', args: [a.address] }))[0];
  const [d0, d1] = await Promise.all([deckOf(p0), deckOf(p1)]);

  console.log('\n2. stake, join, claim');
  const stake = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'stakeFor', args: [0] });
  check('the Pauper tier is one dollar of USDC (6 decimals)', stake === 1_000_000n, String(stake));
  const id = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'nextMatchId' });
  const treasury = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'treasury' });
  const before = { p0: await usdcOf(p0.address), p1: await usdcOf(p1.address), t: await usdcOf(treasury) };
  const native0 = await pub.getBalance({ address: p0.address });
  const fee = (r) => r.gasUsed * r.effectiveGasPrice; // gas is native USDC (18 decimals)
  const session = freshAccount();
  const float = 50_000n; // 0.05 USDC of session-key gas, paid in ERC-20 USDC with the stake
  const permit = await usdcPermit(p0, pub, tc.chainId, dep.arena, stake + float);
  const created = await write(p0, {
    address: dep.arena, abi: arenaAbi, functionName: 'createMatch', args: [0, d0, session.address, float, permit],
  });
  check('seat 0 staked with a permit inside the create tx (one transaction)', created.status === 'success');
  check('and armed its session key with 0.05 USDC of gas — an ERC-20 transfer that is native gas on Arc', (await pub.getBalance({ address: session.address })) === parseEther('0.05'));
  await write(p1, { address: USDC, abi: erc20Abi, functionName: 'approve', args: [dep.arena, maxUint256] });
  await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'joinMatch', args: [id, d1, zeroAddress, 0n, NO_PERMIT] });
  check('the arena escrows both stakes in USDC', (await usdcOf(dep.arena)) === stake * 2n);
  const finalHash = `0x${'5e'.repeat(32)}`;
  const claim0 = await write(p0, { address: dep.arena, abi: arenaAbi, functionName: 'claim', args: [id, 0, finalHash] });

  // One claim in: active, not settled. A report now must not credit money.
  const early = await req('POST', `/api/match/${p0.address}`, await signed(p0, 'match.post', {
    won: true, crowns: [3, 0], escrowed: true, matchId: Number(id), currency: 'USDC',
  }));
  check('a report before settlement is counted but not credited', early.status === 200);
  // The client retries only on `pending`; without it this win's money is never credited.
  check('and it says pending, so the client comes back for the money', early.data?.pending === true, JSON.stringify(early.data));
  let board = (await req('GET', '/api/leaderboard')).data;
  check('no USDC credited yet', board.find((r) => r.address === p0.address.toLowerCase())?.netUsdc === 0);

  const settleRcpt = await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'claim', args: [id, 0, finalHash] });
  const m = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'getMatch', args: [id] });
  check('the arena settled for seat 0 in the second claim\'s own transaction', Number(m.state) === 3 && Number(m.winner) === 0);
  const after = { p0: await usdcOf(p0.address), p1: await usdcOf(p1.address), t: await usdcOf(treasury) };
  // One balance: the winner's USDC also paid their gas and the session-key float.
  const native1 = await pub.getBalance({ address: p0.address });
  const netOfCosts = native1 - native0 + parseEther('0.05') + fee(created) + fee(claim0); // float came out of the same balance
  check('winner +$0.80 net to the wei, once their gas and session float are added back', netOfCosts === parseEther('0.8'),
    `${formatUnits(netOfCosts, 18)} (gas ${formatUnits(fee(created) + fee(claim0), 18)} USDC)`);
  check('loser −$1 plus their own gas (gas is USDC too)', before.p1 - after.p1 >= 1_000_000n && before.p1 - after.p1 < 1_100_000n,
    formatUnits(before.p1 - after.p1, 6));
  check('treasury +$0.20 rake', after.t - before.t === 200_000n, formatUnits(after.t - before.t, 6));
  check('the arena holds nothing after settlement', (await usdcOf(dep.arena)) === 0n);
  console.log(`  (settled in block ${settleRcpt.blockNumber}, ${settleRcpt.gasUsed} gas)`);

  console.log('\n3. the money column');
  const rake = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'rakeBps' });
  const wantWin = Number(formatUnits(stake * 2n - (stake * 2n * BigInt(rake)) / 10_000n - stake, 6));
  const retry = await req('POST', `/api/match/${p0.address}`, await signed(p0, 'match.post', {
    won: true, crowns: [3, 0], escrowed: true, matchId: Number(id), currency: 'USDC',
  }));
  check('the retry credits what the chain paid', retry.data?.credited === wantWin && retry.data?.currency === 'USDC',
    JSON.stringify(retry.data));
  const again = await req('POST', `/api/match/${p0.address}`, await signed(p0, 'match.post', {
    won: true, crowns: [3, 0], escrowed: true, matchId: Number(id), currency: 'USDC',
  }));
  check('a third report credits nothing more', again.data?.note === 'already recorded', JSON.stringify(again.data));
  const lost = await req('POST', `/api/match/${p1.address}`, await signed(p1, 'match.post', {
    won: false, crowns: [0, 3], escrowed: true, matchId: Number(` ${id}`), currency: 'EURC', payout: 999,
  }));
  check('the loser\'s report is accepted', lost.status === 200);

  board = (await req('GET', '/api/leaderboard')).data;
  const w = board.find((r) => r.address === p0.address.toLowerCase());
  const l = board.find((r) => r.address === p1.address.toLowerCase());
  check('winner: +pot − rake − stake in USDC, counted once', Math.abs(w.netUsdc - wantWin) < 1e-12 && w.matches === 1,
    `${w.netUsdc} vs ${wantWin}, matches ${w.matches}`);
  check('loser: −stake in USDC, whatever currency or payout they claimed', Math.abs(l.netUsdc + Number(formatUnits(stake, 6))) < 1e-12,
    `${l.netUsdc}`);
  const other = await req('GET', '/api/leaderboard?currency=AUSD');
  check('any other board currency is refused', other.status === 400);

  const stranger = freshAccount();
  await req('POST', `/api/match/${stranger.address}`, await signed(stranger, 'match.post', {
    won: true, escrowed: true, matchId: Number(id), currency: 'USDC', payout: parseEther('1').toString(),
  }));
  board = (await req('GET', '/api/leaderboard')).data;
  check('a wallet that was not seated is credited nothing',
    board.find((r) => r.address === stranger.address.toLowerCase())?.netUsdc === 0);
} catch (e) {
  check('suite ran to completion', false, String(e?.stack ?? e).slice(0, 400));
  console.log(relay.log().slice(-1500));
} finally {
  await relay.stop();
  await tc.stop();
}
process.exit(done() ? 1 : 0);
