/**
 * The whole game, end to end, on a throwaway fork of Arc testnet (arc-anvil).
 *
 * Every step a player takes, against the real contracts, the real relay, Arc's
 * real USDC (FiatToken behind 0x3600…0000, native and ERC-20 views of one
 * balance), and live market prices signed by the relay for the
 * SignedPriceOracle — the same price path Arc mainnet uses:
 *
 *   1. guest onboarding — starter deck and a 2 USDC drip (gas and stake in one)
 *   2. a card minted for USDC (permit inside the tx) with a fresh signed price
 *   3. the market meta posted from price momentum, snapshotted by a match
 *   4. a $1 USDC match staked with EIP-2612 permits, played by session keys,
 *      settled 90/10 with the win reward and a chest
 *   5. the chest opened against a future block, a duplicate merged for a level
 *   6. an abandoned match refunded by the permissionless timeout
 *
 * Steps 5 and 6 warp chain time, which is why this runs on its own fork
 * (test-chain.mjs: :8711, chain 31338) and never on the dev chain.
 *
 *   node test-e2e.mjs
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseEther, zeroAddress,
} from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { startTestChain } from './test-chain.mjs';
import { DEV_BASE, DEV_MNEMONIC, USDC, client, devKey, signed, startRelay, tally, usdcPermit } from './test-util.mjs';

const tc = await startTestChain();
const RPC_URL = tc.rpcUrl;
const PORT = Number(process.env.PORT ?? 8793);
const RELAYER_KEY = devKey(1);
// The signer DeployLocal registers on the SignedPriceOracle.
const ORACLE_KEY = devKey(4);

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const dep = tc.dep;
const cardsAbi = read('./shared/abi/MempireCards.json');
const arenaAbi = read('./shared/abi/MempireArena.json');
const metaAbi = read('./shared/abi/MarketMeta.json');
const pythAbi = [{ type: 'function', name: 'getUpdateFee', stateMutability: 'view', inputs: [{ type: 'bytes[]' }], outputs: [{ type: 'uint256' }] }];
const { chain } = tc;
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const rpc = (method, params = []) => pub.request({ method, params });

const { check, done } = tally();
console.log(`e2e → Arc fork ${RPC_URL}, relay :${PORT}\n`);
const relay = await startRelay(PORT, {
  CHAIN_ID: String(tc.chainId), RPC_URL, RELAYER_PRIVATE_KEY: RELAYER_KEY, ORACLE_PRIVATE_KEY: ORACLE_KEY, META_KEEPER: '0',
});
const req = client(relay.base);

const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC_URL) });
async function write(account, call) {
  const hash = await wallet(account).writeContract(call);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${call.functionName} reverted`);
  return r;
}
const read$ = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

const permit = (account, value, spender = dep.arena) => usdcPermit(account, pub, tc.chainId, spender, value);
const usdcOf = (a) => read$(USDC, erc20Abi, 'balanceOf', [a]);

try {
  const funder = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: DEV_BASE + 3 });
  const p0 = privateKeyToAccount(generatePrivateKey());
  const p1 = privateKeyToAccount(generatePrivateKey());

  console.log('1. guest onboarding');
  const ob = await Promise.all([p0, p1].map(async (a) => req('POST', '/api/onboard', await signed(a, 'onboard'))));
  check('both guests onboard', ob.every((r) => r.status === 200), ob.map((r) => r.data?.error ?? r.status).join(','));
  const [ids0] = await read$(dep.cards, cardsAbi, 'cardsOf', [p0.address]);
  const [ids1] = await read$(dep.cards, cardsAbi, 'cardsOf', [p1.address]);
  check('each holds an 8-card starter deck', ids0.length === 8 && ids1.length === 8);
  check('each got 2 USDC — the only token they will need, for gas and stakes alike',
    ob.every((r) => r.data?.usdc === 'sent') && (await usdcOf(p0.address)) === 2_000_000n, String(await usdcOf(p0.address)));

  console.log('\n2. a card minted with a fresh signed live price in the same tx');
  const coinId = 0; // BTC
  const up = await req('GET', `/api/pyth/update?coinIds=${coinId}`);
  check('the relay signs a live price update (signed oracle)', up.status === 200 && up.data?.mode === 'signed' && up.data.updateData.length === 1,
    `${up.status} ${up.data?.mode} missing=${up.data?.missing}`);
  check('the price is a live market quote', ['okx', 'coingecko'].includes(up.data?.prices?.[0]?.source), up.data?.prices?.[0]?.source);
  const fee = await read$(dep.oracle, pythAbi, 'getUpdateFee', [up.data.updateData]);
  check('signed-oracle updates are free (no native USDC trapped)', fee === 0n);
  const mintFee = await read$(dep.cards, cardsAbi, 'mintFee');
  check('a mint costs $0.05 of USDC (6 decimals)', mintFee === 50_000n, String(mintFee));
  const treasury = await read$(dep.cards, cardsAbi, 'treasury');
  const tBefore = await usdcOf(treasury);
  const mintRc = await write(p0, {
    address: dep.cards, abi: cardsAbi, functionName: 'mint', args: [coinId, up.data.updateData, await permit(p0, mintFee, dep.cards)], value: fee,
  });
  check('the USDC mint fee reached the treasury (permit inside the mint tx)', (await usdcOf(treasury)) - tBefore === mintFee);
  const [ids0b, data0b] = await read$(dep.cards, cardsAbi, 'cardsOf', [p0.address]);
  const minted = data0b[ids0b.length - 1];
  check('the card records the posted price', String(minted.mintPrice) === up.data.prices[0].price && Number(minted.coinId) === coinId);
  check('mint receipt has a CardMinted log', mintRc.logs.length > 0);

  console.log('\n3. market meta from price momentum');
  // No time warp: the fresh deployment has posted no epoch, and the prices
  // are live — warping ahead would only make them stale.
  const all = await req('GET', `/api/pyth/update?coinIds=${[0, 1, 2, 3, 4].join(',')}`);
  check('five live prices signed', all.data?.prices?.length === 5, `missing=${all.data?.missing}`);
  const metaFee = await read$(dep.oracle, pythAbi, 'getUpdateFee', [all.data.updateData]);
  await write(funder, { address: dep.marketMeta, abi: metaAbi, functionName: 'postFromOracle', args: [all.data.prices.map((p) => p.coinId), all.data.updateData], value: metaFee });
  const epoch = await read$(dep.marketMeta, metaAbi, 'currentEpoch');
  const src = await read$(dep.marketMeta, metaAbi, 'epochSource', [epoch]);
  const btcBps = await read$(dep.marketMeta, metaAbi, 'modifierBps', [epoch, coinId]);
  const p = all.data.prices.find((x) => x.coinId === coinId);
  const expected = Math.max(-1500, Math.min(1500, Math.trunc(((Number(p.price) - Number(p.ema)) * 20000) / Number(p.ema))));
  check('a price-sourced epoch was posted', Number(src) === 1 && epoch > 0n);
  check('the modifier is spot-vs-EMA momentum, computed on chain', Number(btcBps) === expected, `${btcBps} vs ${expected}`);

  console.log('\n4. a $1 USDC match: permits, session keys, settlement');
  const stake = await read$(dep.arena, arenaAbi, 'stakeFor', [0]);
  const s0 = privateKeyToAccount(generatePrivateKey());
  const s1 = privateKeyToAccount(generatePrivateKey());
  const id = await read$(dep.arena, arenaAbi, 'nextMatchId');
  await write(p0, { address: dep.arena, abi: arenaAbi, functionName: 'createMatch', args: [0, ids0, s0.address, await permit(p0, stake)], value: parseEther('0.05') });
  await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'joinMatch', args: [id, ids1, s1.address, await permit(p1, stake)], value: parseEther('0.05') });
  const m = await read$(dep.arena, arenaAbi, 'getMatch', [id]);
  check('both stakes escrowed with permits, match Active', Number(m.state) === 2 && await usdcOf(dep.arena) >= stake * 2n);
  check('the match snapshotted the oracle epoch', m.metaEpoch === epoch);
  check('session keys were funded in the stake txs', (await pub.getBalance({ address: s0.address })) === parseEther('0.05'));
  const playMs = [];
  let playGas = 0n;
  for (let t = 20; t <= 100; t += 20) {
    const t0 = Date.now();
    const rc = await write(s0, { address: dep.arena, abi: arenaAbi, functionName: 'play', args: [id, t, t % 8, 100, -100] });
    playMs.push(Date.now() - t0);
    playGas += rc.gasUsed * rc.effectiveGasPrice;
    await write(s1, { address: dep.arena, abi: arenaAbi, functionName: 'play', args: [id, t + 1, (t + 3) % 8, -100, 100] });
  }
  console.log(`  (5 plays by seat 0's session key: ${(Number(playGas) / 1e18).toFixed(6)} USDC gas in all, send-to-receipt ${playMs.join('/')} ms on the fork)`);
  check('the session key paid for its plays out of its USDC float', (await pub.getBalance({ address: s0.address })) < parseEther('0.05'));
  await write(s0, { address: dep.arena, abi: arenaAbi, functionName: 'checkpoint', args: [id, 400, 12345n] });
  const before = await usdcOf(p0.address);
  const memBefore = await read$(dep.token, erc20Abi, 'balanceOf', [p0.address]);
  await write(s0, { address: dep.arena, abi: arenaAbi, functionName: 'claim', args: [id, 0, `0x${'ee'.repeat(32)}`] });
  await write(s1, { address: dep.arena, abi: arenaAbi, functionName: 'claim', args: [id, 0, `0x${'ee'.repeat(32)}`] });
  const m2 = await read$(dep.arena, arenaAbi, 'getMatch', [id]);
  check('ten plays logged on chain', Number(m2.plays0) + Number(m2.plays1) === 10);
  check('settled to seat 0', Number(m2.state) === 3 && Number(m2.winner) === 0);
  const after = await usdcOf(p0.address);
  check('winner paid 90% of the $2 pot', after - before === 1_800_000n, String(after - before));
  check('winner got 50 $MEMPIRE', (await read$(dep.token, erc20Abi, 'balanceOf', [p0.address])) - memBefore === parseEther('50'));
  check('winner got an on-chain chest', Number(await read$(dep.cards, cardsAbi, 'activeChests', [p0.address])) === 1);

  console.log('\n5. open the chest, merge a duplicate');
  const [chestIds, chestData] = await read$(dep.cards, cardsAbi, 'chestsOf', [p0.address]);
  const chestId = chestIds[0];
  await write(p0, { address: dep.cards, abi: cardsAbi, functionName: 'startUnlock', args: [chestId] });
  const secs = await read$(dep.cards, cardsAbi, 'unlockSeconds', [chestData[0].tier]);
  await rpc('evm_increaseTime', [Number(secs) + 1]);
  await rpc('evm_mine');
  await write(p0, { address: dep.cards, abi: cardsAbi, functionName: 'open', args: [chestId] });
  await rpc('anvil_mine', ['0x2']);
  const owned = [...new Set((await read$(dep.cards, cardsAbi, 'cardsOf', [p0.address]))[1].map((c) => Number(c.coinId)))];
  await write(p0, { address: dep.cards, abi: cardsAbi, functionName: 'reveal', args: [chestId, owned.slice(0, 8)] });
  check('the chest is spent', Number(await read$(dep.cards, cardsAbi, 'activeChests', [p0.address])) === 0);
  // Find any two cards of one coin and merge them.
  const [allIds, allData] = await read$(dep.cards, cardsAbi, 'cardsOf', [p0.address]);
  const byCoin = new Map();
  allIds.forEach((cid, i) => byCoin.set(Number(allData[i].coinId), [...(byCoin.get(Number(allData[i].coinId)) ?? []), cid]));
  const pair = [...byCoin.values()].find((v) => v.length >= 2);
  check('the mint + chest produced a duplicate', Boolean(pair));
  if (pair) {
    const deployer = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: DEV_BASE });
    await write(deployer, { address: dep.token, abi: erc20Abi, functionName: 'transfer', args: [p0.address, parseEther('1000')] });
    await write(p0, { address: dep.token, abi: erc20Abi, functionName: 'approve', args: [dep.cards, parseEther('1000')] });
    await write(p0, { address: dep.cards, abi: cardsAbi, functionName: 'merge', args: [pair[0], pair[1]] });
    const kept = await read$(dep.cards, cardsAbi, 'card', [pair[0]]);
    check('merging the duplicate raised the level to 2', Number(kept.level) === 2);
  }

  console.log('\n6. an abandoned match refunds by timeout');
  const freeIds = async (a) => {
    const [i, d, locked] = await read$(dep.cards, cardsAbi, 'cardsOf', [a.address]);
    const seen = new Set();
    return i.filter((_, k) => !locked[k] && !seen.has(Number(d[k].coinId)) && seen.add(Number(d[k].coinId))).slice(0, 8);
  };
  const id2 = await read$(dep.arena, arenaAbi, 'nextMatchId');
  const stake2 = await read$(dep.arena, arenaAbi, 'stakeFor', [0]);
  // The loser of match 1 is under $1 now (stake, gas and session float all came out of one USDC balance): top up.
  await pub.waitForTransactionReceipt({ hash: await wallet(funder).sendTransaction({ to: p1.address, value: parseEther('1') }) });
  await write(p0, { address: dep.arena, abi: arenaAbi, functionName: 'createMatch', args: [0, await freeIds(p0), zeroAddress, await permit(p0, stake2)] });
  await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'joinMatch', args: [id2, await freeIds(p1), zeroAddress, await permit(p1, stake2)] });
  const timeout = await read$(dep.arena, arenaAbi, 'matchTimeout');
  await rpc('evm_increaseTime', [Number(timeout) + 1]);
  await rpc('evm_mine');
  const a0 = await usdcOf(p0.address);
  const a1 = await usdcOf(p1.address);
  await write(funder, { address: dep.arena, abi: arenaAbi, functionName: 'claimTimeout', args: [id2] });
  const m3 = await read$(dep.arena, arenaAbi, 'getMatch', [id2]);
  check('voided (no claims) after the deadline', Number(m3.state) === 3 && Number(m3.winner) === 3);
  check('both stakes refunded in full (a third party paid the timeout gas)', (await usdcOf(p0.address)) - a0 === stake2
    && (await usdcOf(p1.address)) - a1 === stake2);
  const [, , lockedAfter] = await read$(dep.cards, cardsAbi, 'cardsOf', [p0.address]);
  check('and every card is free again', lockedAfter.every((l) => !l));
  void encodeFunctionData;
} finally {
  await relay.stop();
  await tc.stop();
}
process.exit(done() ? 1 : 0);
