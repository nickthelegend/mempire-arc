/**
 * Chain-verified money, end to end on the local anvil deployment.
 *
 * Two fresh wallets are onboarded through the relay, stake a Pauper match in
 * MON on `MempireArena`, and both claim seat 0 as the winner — which settles
 * the pot on the second claim. Then each reports the match to `/api/match`,
 * and the leaderboard's MON column must show exactly what the arena paid:
 * the winner up by the pot less the 10% rake less their stake, the loser down
 * one stake. The AUSD column must not move. A report before settlement must
 * come back `pending` and be credited on the retry, never twice.
 *
 *   node test-settlement.mjs   (forks Monad testnet on :8613, chain 31338)
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, http, parseEther, zeroAddress } from 'viem';
import { startTestChain } from './test-chain.mjs';
import { client, freshAccount, signed, startRelay, tally } from './test-util.mjs';

const tc = await startTestChain();
const RPC_URL = tc.rpcUrl;
const PORT = Number(process.env.PORT ?? 8794);
const RELAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const dep = tc.dep;
const cardsAbi = read('./shared/abi/MempireCards.json');
const arenaAbi = read('./shared/abi/MempireArena.json');
const { chain } = tc;
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const NO_PERMIT = { deadline: 0n, v: 0, r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}` };

const { check, done } = tally();
console.log(`settlement → anvil ${RPC_URL}, relay :${PORT}\n`);
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
  const stake = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'stakeFor', args: [zeroAddress, 0] });
  const id = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'nextMatchId' });
  await write(p0, { address: dep.arena, abi: arenaAbi, functionName: 'createMatch', args: [0, zeroAddress, d0, zeroAddress, NO_PERMIT], value: stake });
  await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'joinMatch', args: [id, d1, zeroAddress, NO_PERMIT], value: stake });
  const finalHash = `0x${'5e'.repeat(32)}`;
  await write(p0, { address: dep.arena, abi: arenaAbi, functionName: 'claim', args: [id, 0, finalHash] });

  // One claim in: active, not settled. A report now must not credit money.
  const early = await req('POST', `/api/match/${p0.address}`, await signed(p0, 'match.post', {
    won: true, crowns: [3, 0], escrowed: true, matchId: Number(id), currency: 'MON',
  }));
  check('a report before settlement is counted but not credited', early.status === 200);
  // The client retries only on `pending`; without it this win's money is never credited.
  check('and it says pending, so the client comes back for the money', early.data?.pending === true, JSON.stringify(early.data));
  let board = (await req('GET', '/api/leaderboard')).data;
  check('no MON credited yet', board.find((r) => r.address === p0.address.toLowerCase())?.netMon === 0);

  await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'claim', args: [id, 0, finalHash] });
  const m = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'getMatch', args: [id] });
  check('the arena settled for seat 0', Number(m.state) === 3 && Number(m.winner) === 0);

  console.log('\n3. the money column');
  const rake = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'rakeBps' });
  const wantWin = Number(formatEther(stake * 2n - (stake * 2n * BigInt(rake)) / 10_000n - stake));
  const retry = await req('POST', `/api/match/${p0.address}`, await signed(p0, 'match.post', {
    won: true, crowns: [3, 0], escrowed: true, matchId: Number(id), currency: 'MON',
  }));
  check('the retry credits what the chain paid', retry.data?.credited === wantWin && retry.data?.currency === 'MON',
    JSON.stringify(retry.data));
  const again = await req('POST', `/api/match/${p0.address}`, await signed(p0, 'match.post', {
    won: true, crowns: [3, 0], escrowed: true, matchId: Number(id), currency: 'MON',
  }));
  check('a third report credits nothing more', again.data?.note === 'already recorded', JSON.stringify(again.data));
  const lost = await req('POST', `/api/match/${p1.address}`, await signed(p1, 'match.post', {
    won: false, crowns: [0, 3], escrowed: true, matchId: Number(` ${id}`), currency: 'AUSD', payout: 999,
  }));
  check('the loser\'s report is accepted', lost.status === 200);

  board = (await req('GET', '/api/leaderboard')).data;
  const w = board.find((r) => r.address === p0.address.toLowerCase());
  const l = board.find((r) => r.address === p1.address.toLowerCase());
  check('winner: +pot − rake − stake in MON, counted once', Math.abs(w.netMon - wantWin) < 1e-12 && w.matches === 1,
    `${w.netMon} vs ${wantWin}, matches ${w.matches}`);
  check('loser: −stake in MON, whatever currency they claimed', Math.abs(l.netMon + Number(formatEther(stake))) < 1e-12,
    `${l.netMon}`);
  check('the AUSD column never moved', w.netAusd === 0 && l.netAusd === 0);
  const ausdBoard = (await req('GET', '/api/leaderboard?currency=AUSD')).data;
  check('the AUSD board ranks by its own column', Array.isArray(ausdBoard) && ausdBoard.every((r) => 'netAusd' in r));

  const stranger = freshAccount();
  await req('POST', `/api/match/${stranger.address}`, await signed(stranger, 'match.post', {
    won: true, escrowed: true, matchId: Number(id), currency: 'MON', payout: parseEther('1').toString(),
  }));
  board = (await req('GET', '/api/leaderboard')).data;
  check('a wallet that was not seated is credited nothing',
    board.find((r) => r.address === stranger.address.toLowerCase())?.netMon === 0);
} catch (e) {
  check('suite ran to completion', false, String(e?.stack ?? e).slice(0, 400));
  console.log(relay.log().slice(-1500));
} finally {
  await relay.stop();
  await tc.stop();
}
process.exit(done() ? 1 : 0);
