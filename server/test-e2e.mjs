/**
 * The whole game, end to end, on a throwaway fork of Arc MAINNET (arc-anvil):
 * nothing is broadcast to any real network.
 *
 * Every step a player takes, against our contracts (deployed on the fork), the
 * real relay, Arc's real USDC (native and ERC-20 views of one balance),
 * Chainlink's real Arc Data Feeds and Chainlink's real Arc CCIP router:
 *
 *   1. guest onboarding — starter deck and a 2 USDC drip (gas and stake in one)
 *   2. a card minted for USDC (permit inside the tx) at its Chainlink price
 *   3. the daily meta computed on chain from the feeds' history; 3b. a
 *      cross-chain ENTER from Base delivered by the real router address, stored
 *      while its USDC is in flight and completed by the relay's ccip-watch
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
  createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256, parseEther, toHex, zeroAddress,
} from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { startTestChain } from './test-chain.mjs';
import { DEV_BASE, DEV_MNEMONIC, USDC, client, devKey, signed, startRelay, tally, usdcPermit } from './test-util.mjs';

const tc = await startTestChain();
const RPC_URL = tc.rpcUrl;
const PORT = Number(process.env.PORT ?? 8793);
const RELAYER_KEY = devKey(1);

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const dep = tc.dep;
const cardsAbi = read('./shared/abi/MempireCards.json');
const arenaAbi = read('./shared/abi/MempireArena.json');
const metaAbi = read('./shared/abi/MarketMeta.json');
const gatewayAbi = read('./shared/abi/MempireCCIPGateway.json');
const feedAbi = [
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
  { type: 'function', name: 'getRoundData', stateMutability: 'view', inputs: [{ type: 'uint80' }], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
];
const { chain } = tc;
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const rpc = (method, params = []) => pub.request({ method, params });

const { check, done } = tally();
console.log(`e2e → Arc fork ${RPC_URL}, relay :${PORT}\n`);
const relay = await startRelay(PORT, {
  CHAIN_ID: String(tc.chainId), RPC_URL, RELAYER_PRIVATE_KEY: RELAYER_KEY, META_KEEPER: '0',
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

  console.log('\n2. a card minted at its live Chainlink price, read in the same tx');
  const coinId = 0; // BTC
  const coins = await req('GET', '/api/coins');
  check('the relay serves every fighter at its Chainlink feed price', coins.status === 200 && coins.data.length === 20
    && coins.data.every((c) => c.source === 'chainlink' && c.fresh), `${coins.data?.length} rows`);
  const btcFeed = (await read$(dep.cards, cardsAbi, 'coin', [coinId])).feed;
  const [, btcAnswer] = await read$(btcFeed, feedAbi, 'latestRoundData');
  const mintFee = await read$(dep.cards, cardsAbi, 'mintFee');
  check('a mint costs $0.05 of USDC (6 decimals)', mintFee === 50_000n, String(mintFee));
  const treasury = await read$(dep.cards, cardsAbi, 'treasury');
  const tBefore = await usdcOf(treasury);
  const mintRc = await write(p0, {
    address: dep.cards, abi: cardsAbi, functionName: 'mint', args: [coinId, await permit(p0, mintFee, dep.cards)],
  });
  check('the USDC mint fee reached the treasury (permit inside the mint tx)', (await usdcOf(treasury)) - tBefore === mintFee);
  const [ids0b, data0b] = await read$(dep.cards, cardsAbi, 'cardsOf', [p0.address]);
  const minted = data0b[ids0b.length - 1];
  check('the card records Chainlink\'s BTC/USD answer', minted.mintPrice === btcAnswer && Number(minted.coinId) === coinId,
    `${minted.mintPrice} vs ${btcAnswer}`);
  check('mint receipt has a CardMinted log', mintRc.logs.length > 0);

  console.log('\n3. the daily meta, computed on chain from the Chainlink feeds');
  const block = await pub.getBlock();
  const hints = [];
  for (const cid of [0, 1, 2, 9, 12, 13]) { // BTC ETH SOL LINK PAXG EUR
    const f = (await read$(dep.cards, cardsAbi, 'coin', [cid])).feed;
    let [r] = await read$(f, feedAbi, 'latestRoundData');
    for (let i = 0; i < 400; i += 1, r -= 1n) {
      const [, , , at] = await read$(f, feedAbi, 'getRoundData', [r]);
      if (at <= block.timestamp - 86_400n) break;
    }
    hints.push({ cid, f, r });
  }
  await write(funder, {
    address: dep.marketMeta, abi: metaAbi, functionName: 'postFromFeeds', args: [hints.map((h) => h.cid), hints.map((h) => h.r)],
  });
  const epoch = await read$(dep.marketMeta, metaAbi, 'currentEpoch');
  const src = await read$(dep.marketMeta, metaAbi, 'epochSource', [epoch]);
  check('a feed-sourced epoch was posted (SOURCE_FEEDS)', Number(src) === 1 && epoch > 0n);
  for (const h of hints) {
    const [, now] = await read$(h.f, feedAbi, 'latestRoundData');
    const [, then] = await read$(h.f, feedAbi, 'getRoundData', [h.r]);
    const want = Math.max(-1500, Math.min(1500, Number(((now - then) * 20_000n) / (then * 5n))));
    const got = Number(await read$(dep.marketMeta, metaAbi, 'modifierBps', [epoch, h.cid]));
    if (got !== want) check(`coin ${h.cid}: on-chain move matches the feed history`, false, `${got} vs ${want}`);
  }
  check('each modifier is the feed\'s own 24h move ×0.4, clamped ±15%', true);

  console.log('\n3b. cross-chain entry: a CCIP message from Base, delivered by Arc\'s real CCIP router');
  // The gateway on the fork is wired to Arc mainnet's real router; impersonate it as its OffRamp would.
  const gateway = dep.ccipGateway;
  const BASE_SELECTOR = 15971525489660198786n;
  const remote = privateKeyToAccount(generatePrivateKey()).address; // stands in for MempireRemoteEntry on Base
  const owner = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: DEV_BASE });
  await write(owner, { address: gateway, abi: gatewayAbi, functionName: 'setRemoteEntry', args: [BASE_SELECTOR, remote, 6] });
  const xp = privateKeyToAccount(generatePrivateKey()); // a player who has only ever been on Base
  const xo = await req('POST', '/api/onboard', await signed(xp, 'onboard'));
  const [xDeck] = await read$(dep.cards, cardsAbi, 'cardsOf', [xp.address]);
  // Spend the drip so the player holds no USDC on Arc yet: the CCIP message will beat the "CCTP" mint.
  const drip = await pub.getBalance({ address: xp.address });
  const sweepGas = 60_000n * 50_000_000_000n;
  await pub.waitForTransactionReceipt({ hash: await wallet(xp).sendTransaction({ to: funder.address, value: drip - sweepGas, gas: 60_000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }) });
  const stakeX = await read$(dep.arena, arenaAbi, 'stakeFor', [0]);
  const px = await permit(xp, stakeX);
  const order = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'matchId', type: 'uint64' }, { name: 'tier', type: 'uint8' }, { name: 'cardIds', type: 'uint256[]' },
      { name: 'session', type: 'address' }, { name: 'permitDeadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] }],
    [{ matchId: 0n, tier: 0, cardIds: xDeck, session: zeroAddress, permitDeadline: px.deadline, v: px.v, r: px.r, s: px.s }],
  );
  const msg = {
    messageId: keccak256(toHex(`e2e-${xp.address}`)), sourceChainSelector: BASE_SELECTOR,
    sender: encodeAbiParameters([{ type: 'address' }], [remote]),
    data: encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }, { type: 'bytes' }], [1, xp.address, order]),
    destTokenAmounts: [],
  };
  const ROUTER = '0xB79791184973589c38e114D43Eb8E4588C283A18';
  await rpc('anvil_impersonateAccount', [ROUTER]);
  await rpc('anvil_setBalance', [ROUTER, '0x8ac7230489e80000']);
  const nextBefore = await read$(dep.arena, arenaAbi, 'nextMatchId');
  const rh = await pub.request({ method: 'eth_sendTransaction', params: [{ from: ROUTER, to: gateway, data: encodeFunctionData({ abi: gatewayAbi, functionName: 'ccipReceive', args: [msg] }), gas: '0x7a120' }] });
  const rr = await pub.waitForTransactionReceipt({ hash: rh });
  await rpc('anvil_stopImpersonatingAccount', [ROUTER]);
  check('delivered within the 450k ENTER gas budget', rr.status === 'success' && rr.gasUsed < 450_000n, String(rr.gasUsed));
  check('no USDC on Arc yet: the instruction is stored, not lost', Number(await read$(gateway, gatewayAbi, 'messageStatus', [msg.messageId])) === 1
    && (await read$(dep.arena, arenaAbi, 'nextMatchId')) === nextBefore);
  // "CCTP mints" the player's USDC on Arc; the relay's ccip-watch job completes the stored instruction on its own.
  await pub.waitForTransactionReceipt({ hash: await wallet(funder).sendTransaction({ to: xp.address, value: parseEther('2') }) });
  let seated = false;
  for (let i = 0; i < 30 && !seated; i += 1) {
    await new Promise((r) => { setTimeout(r, 1000); });
    seated = Number(await read$(gateway, gatewayAbi, 'messageStatus', [msg.messageId])) === 2;
  }
  const xm = await read$(dep.arena, arenaAbi, 'getMatch', [nextBefore]);
  check('the relay completed it once the dollars landed: the Base player is seated on Arc', seated && xm.p0 === xp.address,
    `${seated} ${xm.p0}`);
  void xo;

  console.log('\n4. a $1 USDC match: permits, session keys, settlement');
  const stake = await read$(dep.arena, arenaAbi, 'stakeFor', [0]);
  const s0 = privateKeyToAccount(generatePrivateKey());
  const s1 = privateKeyToAccount(generatePrivateKey());
  const id = await read$(dep.arena, arenaAbi, 'nextMatchId');
  await write(p0, { address: dep.arena, abi: arenaAbi, functionName: 'createMatch', args: [0, ids0, s0.address, await permit(p0, stake)], value: parseEther('0.05') });
  await write(p1, { address: dep.arena, abi: arenaAbi, functionName: 'joinMatch', args: [id, ids1, s1.address, await permit(p1, stake)], value: parseEther('0.05') });
  const m = await read$(dep.arena, arenaAbi, 'getMatch', [id]);
  check('both stakes escrowed with permits, match Active', Number(m.state) === 2 && await usdcOf(dep.arena) >= stake * 2n);
  check('the match snapshotted the Chainlink-feed epoch', m.metaEpoch === epoch);
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
