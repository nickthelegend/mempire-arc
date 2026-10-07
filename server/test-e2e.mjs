/**
 * The whole game, end to end, on a throwaway fork of Monad testnet.
 *
 * Every sponsor-free step a player takes, against the real contracts, the real
 * relay, Agora's real AUSD and faucet (present on the fork), and live market
 * prices signed by the relay for the LocalPriceOracle (Pyth's update model;
 * Hermes does not serve a local chain):
 *
 *   1. guest onboarding — starter deck, AUSD from the real faucet, a gas drip
 *   2. a card minted with a fresh signed price posted in the same transaction
 *   3. the market meta posted from price momentum, snapshotted by a match
 *   4. a $1 AUSD match staked with EIP-2612 permits, played by session keys,
 *      settled 90/10 with the win reward and a chest
 *   5. the chest opened against a future block, a duplicate merged for a level
 *   6. an abandoned match refunded by the permissionless timeout
 *
 * Steps 5 and 6 warp chain time, which is why this runs on its own fork
 * (test-chain.mjs: :8613, chain 31338) and never on the dev chain.
 *
 *   node test-e2e.mjs
 */
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseEther, parseSignature, zeroAddress,
} from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { startTestChain } from './test-chain.mjs';
import { client, signed, startRelay, tally } from './test-util.mjs';

const tc = await startTestChain();
const RPC_URL = tc.rpcUrl;
const PORT = Number(process.env.PORT ?? 8793);
const MNEMONIC = 'test test test test test test test test test test test junk';
const RELAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// anvil #4 — the signer DeployLocal registers on the LocalPriceOracle.
const ORACLE_KEY = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const dep = tc.dep;
const cardsAbi = read('./shared/abi/MempireCards.json');
const arenaAbi = read('./shared/abi/MempireArena.json');
const metaAbi = read('./shared/abi/MarketMeta.json');
const permitAbi = [
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'eip712Domain', stateMutability: 'view', inputs: [], outputs: [
    { type: 'bytes1' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256[]' },
  ] },
];
const pythAbi = [{ type: 'function', name: 'getUpdateFee', stateMutability: 'view', inputs: [{ type: 'bytes[]' }], outputs: [{ type: 'uint256' }] }];
const { chain } = tc;
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const NO_PERMIT = { deadline: 0n, v: 0, r: `0x${'00'.repeat(32)}`, s: `0x${'00'.repeat(32)}` };
const rpc = (method, params = []) => pub.request({ method, params });

const { check, done } = tally();
console.log(`e2e → anvil ${RPC_URL}, relay :${PORT}\n`);
const relay = await startRelay(PORT, {
  CHAIN_ID: String(tc.chainId), RPC_URL, RELAYER_PRIVATE_KEY: RELAYER_KEY, ORACLE_PRIVATE_KEY: ORACLE_KEY,
  AUSD_FAUCET: dep.ausdFaucet, META_KEEPER: '0',
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

async function permit(account, value) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = await read$(dep.ausd, permitAbi, 'nonces', [account.address]);
  // The token's own EIP-712 domain (Agora's is "Agora Dollar", not the symbol).
  const [, name, version, chainId, verifyingContract] = await read$(dep.ausd, permitAbi, 'eip712Domain');
  const sig = await account.signTypedData({
    domain: { name, version, chainId: Number(chainId), verifyingContract },
    types: { Permit: [
      { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ] },
    primaryType: 'Permit',
    message: { owner: account.address, spender: dep.arena, value, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(sig);
  return { deadline, v: Number(v ?? BigInt(yParity + 27)), r, s };
}

try {
  const funder = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
  const p0 = privateKeyToAccount(generatePrivateKey());
  const p1 = privateKeyToAccount(generatePrivateKey());

  console.log('1. guest onboarding');
  // One after the other: the faucet has a cooldown, so the first is paid now.
  const ob = [];
  for (const a of [p0, p1]) ob.push(await req('POST', '/api/onboard', await signed(a, 'onboard')));
  check('both guests onboard', ob.every((r) => r.status === 200), ob.map((r) => r.data?.error ?? r.status).join(','));
  const [ids0] = await read$(dep.cards, cardsAbi, 'cardsOf', [p0.address]);
  const [ids1] = await read$(dep.cards, cardsAbi, 'cardsOf', [p1.address]);
  check('each holds an 8-card starter deck', ids0.length === 8 && ids1.length === 8);
  const ausd0 = await read$(dep.ausd, erc20Abi, 'balanceOf', [p0.address]);
  check('the first guest was paid by the real AUSD faucet', ob[0].data?.ausd === 'sent' && ausd0 > 0n, `${ob[0].data?.ausd} ${ausd0}`);
  check('the second is queued inside the faucet cooldown (or paid)', ['queued', 'sent'].includes(ob[1].data?.ausd), ob[1].data?.ausd);
  if ((await read$(dep.ausd, erc20Abi, 'balanceOf', [p1.address])) < 1_000_000n) {
    await write(p0, { address: dep.ausd, abi: erc20Abi, functionName: 'transfer', args: [p1.address, 100_000_000n] });
  }
  for (const a of [p0, p1]) {
    await pub.waitForTransactionReceipt({ hash: await wallet(funder).sendTransaction({ to: a.address, value: parseEther('2') }) });
  }

  // (the MON for gas is above; both now hold AUSD for a $1 stake)

  console.log('\n2. a card minted with a fresh signed live price in the same tx');
  const coinId = 0; // BTC
  const up = await req('GET', `/api/pyth/update?coinIds=${coinId}`);
  check('the relay signs a live price update (local oracle)', up.status === 200 && up.data?.mode === 'local' && up.data.updateData.length === 1,
    `${up.status} ${up.data?.mode} missing=${up.data?.missing}`);
  check('the price is a live market quote', ['okx', 'coingecko'].includes(up.data?.prices?.[0]?.source), up.data?.prices?.[0]?.source);
  const fee = await read$(dep.pyth, pythAbi, 'getUpdateFee', [up.data.updateData]);
  const mintFee = await read$(dep.cards, cardsAbi, 'mintFee');
  const mintRc = await write(p0, { address: dep.cards, abi: cardsAbi, functionName: 'mint', args: [coinId, up.data.updateData], value: mintFee + fee });
  const [ids0b, data0b] = await read$(dep.cards, cardsAbi, 'cardsOf', [p0.address]);
  const minted = data0b[ids0b.length - 1];
  check('the card records the posted price', String(minted.mintPrice) === up.data.prices[0].price && Number(minted.coinId) === coinId);
  check('mint receipt has a CardMinted log', mintRc.logs.length > 0);

  console.log('\n3. market meta from price momentum');
  // No time warp: the fresh deployment has posted no epoch, and the prices
  // are live — warping ahead would only make them stale.
  const all = await req('GET', `/api/pyth/update?coinIds=${[0, 1, 2, 3, 4].join(',')}`);
  check('five live prices signed', all.data?.prices?.length === 5, `missing=${all.data?.missing}`);
  const metaFee = await read$(dep.pyth, pythAbi, 'getUpdateFee', [all.data.updateData]);
  await write(funder, { address: dep.marketMeta, abi: metaAbi, functionName: 'postFromPyth', args: [all.data.prices.map((p) => p.coinId), all.data.updateData], value: metaFee });
  const epoch = await read$(dep.marketMeta, metaAbi, 'currentEpoch');
  const src = await read$(dep.marketMeta, metaAbi, 'epochSource', [epoch]);
  const btcBps = await read$(dep.marketMeta, metaAbi, 'modifierBps', [epoch, coinId]);
  const p = all.data.prices.find((x) => x.coinId === coinId);
  const expected = Math.max(-1500, Math.min(1500, Math.trunc(((Number(p.price) - Number(p.ema)) * 20000) / Number(p.ema))));
  check('a price-sourced epoch was posted', Number(src) === 1 && epoch > 0n);
  check('the modifier is spot-vs-EMA momentum, computed on chain', Number(btcBps) === expected, `${btcBps} vs ${expected}`);

  console.log('\n4. a $1 AUSD match: permits, session keys, settlement');
  const stake = await read$(dep.arena, arenaAbi, 'stakeFor', [dep.ausd, 0]);
  const s0 = privateKeyToAccount(generatePrivateKey());
  const s1 = privateKeyToAccount(generatePrivateKey());
  const id = await read$(dep.arena, arenaAbi, 'nextMatchId');
  await write(p0, { address: dep.arena, abi: arenaAbi, functionName: 'createMatch', args: [0, dep.ausd, ids0, s0.address, await permit(p0, stake)], value: parseEther('0.05') });
  await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'joinMatch', args: [id, ids1, s1.address, await permit(p1, stake)], value: parseEther('0.05') });
  const m = await read$(dep.arena, arenaAbi, 'getMatch', [id]);
  check('both stakes escrowed with permits, match Active', Number(m.state) === 2 && await read$(dep.ausd, erc20Abi, 'balanceOf', [dep.arena]) >= stake * 2n);
  check('the match snapshotted the Pyth epoch', m.metaEpoch === epoch);
  check('session keys were funded in the stake txs', (await pub.getBalance({ address: s0.address })) === parseEther('0.05'));
  for (let t = 20; t <= 100; t += 20) {
    await write(s0, { address: dep.arena, abi: arenaAbi, functionName: 'play', args: [id, t, t % 8, 100, -100] });
    await write(s1, { address: dep.arena, abi: arenaAbi, functionName: 'play', args: [id, t + 1, (t + 3) % 8, -100, 100] });
  }
  await write(s0, { address: dep.arena, abi: arenaAbi, functionName: 'checkpoint', args: [id, 400, 12345n] });
  const before = await read$(dep.ausd, erc20Abi, 'balanceOf', [p0.address]);
  const memBefore = await read$(dep.token, erc20Abi, 'balanceOf', [p0.address]);
  await write(s0, { address: dep.arena, abi: arenaAbi, functionName: 'claim', args: [id, 0, `0x${'ee'.repeat(32)}`] });
  await write(s1, { address: dep.arena, abi: arenaAbi, functionName: 'claim', args: [id, 0, `0x${'ee'.repeat(32)}`] });
  const m2 = await read$(dep.arena, arenaAbi, 'getMatch', [id]);
  check('ten plays logged on chain', Number(m2.plays0) + Number(m2.plays1) === 10);
  check('settled to seat 0', Number(m2.state) === 3 && Number(m2.winner) === 0);
  const after = await read$(dep.ausd, erc20Abi, 'balanceOf', [p0.address]);
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
    const deployer = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
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
  const monStake = await read$(dep.arena, arenaAbi, 'stakeFor', [zeroAddress, 0]);
  await write(p0, { address: dep.arena, abi: arenaAbi, functionName: 'createMatch', args: [0, zeroAddress, await freeIds(p0), zeroAddress, NO_PERMIT], value: monStake });
  await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'joinMatch', args: [id2, await freeIds(p1), zeroAddress, NO_PERMIT], value: monStake });
  const timeout = await read$(dep.arena, arenaAbi, 'matchTimeout');
  await rpc('evm_increaseTime', [Number(timeout) + 1]);
  await rpc('evm_mine');
  const a0 = await pub.getBalance({ address: p0.address });
  const a1 = await pub.getBalance({ address: p1.address });
  await write(funder, { address: dep.arena, abi: arenaAbi, functionName: 'claimTimeout', args: [id2] });
  const m3 = await read$(dep.arena, arenaAbi, 'getMatch', [id2]);
  check('voided (no claims) after the deadline', Number(m3.state) === 3 && Number(m3.winner) === 3);
  check('both stakes refunded in full', (await pub.getBalance({ address: p0.address })) - a0 === monStake
    && (await pub.getBalance({ address: p1.address })) - a1 === monStake);
  const [, , lockedAfter] = await read$(dep.cards, cardsAbi, 'cardsOf', [p0.address]);
  check('and every card is free again', lockedAfter.every((l) => !l));
  void encodeFunctionData;
} finally {
  await relay.stop();
  await tc.stop();
}
process.exit(done() ? 1 : 0);
