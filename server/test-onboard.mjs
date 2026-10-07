/**
 * Onboarding against a real chain — the local anvil deployment.
 *
 * Starts its own test fork (test-chain.mjs) and relay (in-memory store) and proves the things
 * a new player depends on: a signed onboard mints exactly eight starter cards
 * covering every archetype, the MON drip lands, a second onboard mints nothing
 * and drips nothing, a bad or replayed signature is refused, and three players
 * onboarding at the same instant all get their decks — the relayer's nonce
 * queue is what that last one is testing.
 *
 * `AUSD_FAUCET` is Agora's real testnet faucet, present on the fork. It has a
 * cooldown, so of several players onboarding together one is paid and the rest
 * are `queued` for a retry — and a busy faucet is not a player who failed to
 * onboard, so every one of them must still get a 200.
 *
 *   node test-onboard.mjs   (forks Monad testnet on :8613, chain 31338)
 *
 * PORT overrides the relay port. The relayer key is anvil's account
 * #1, which is the relayer that deployment registers; it is a well-known test
 * key and holds nothing anywhere else.
 */
import { createPublicClient, erc20Abi, formatEther, http, parseEther } from 'viem';
import { readFileSync } from 'node:fs';
import { startTestChain } from './test-chain.mjs';
import { client, freshAccount, signed, startRelay, tally } from './test-util.mjs';

const tc = await startTestChain();
const RPC_URL = tc.rpcUrl;
const PORT = Number(process.env.PORT ?? 8792);
const RELAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const deployment = tc.dep;
const cardsAbi = JSON.parse(readFileSync(new URL('./shared/abi/MempireCards.json', import.meta.url), 'utf8'));
const chain = createPublicClient({ transport: http(RPC_URL) });
const cardsOf = async (address) => {
  const [ids, data] = await chain.readContract({
    address: deployment.cards, abi: cardsAbi, functionName: 'cardsOf', args: [address],
  });
  return { ids, data };
};

const { check, done } = tally();

console.log(`onboarding → anvil ${RPC_URL}, relay :${PORT}\n`);
const relay = await startRelay(PORT, {
  CHAIN_ID: String(tc.chainId),
  RPC_URL,
  RELAYER_PRIVATE_KEY: RELAYER_KEY,
  AUSD_FAUCET: deployment.ausdFaucet,
  PUBLIC_APP_URL: 'https://mempire.test',
});
const req = client(relay.base);

try {
  const alice = freshAccount();

  console.log('1. refusals');
  const forged = await signed(freshAccount(), 'onboard', {}, alice.address);
  const bad = await req('POST', '/api/onboard', forged);
  check('a signature from another key is 401', bad.status === 401, bad.data?.error);
  const garbage = await req('POST', '/api/onboard', { address: alice.address, ts: Date.now(), signature: `0x${'11'.repeat(65)}` });
  check('a malformed signature is 401', garbage.status === 401, garbage.data?.error);
  const wrongAction = await req('POST', '/api/onboard', await signed(alice, 'player.put'));
  check('a signature for another action is 401', wrongAction.status === 401, wrongAction.data?.error);
  const notAddress = await req('GET', '/api/onboard/not-an-address');
  check('status for a non-address is 400', notAddress.status === 400);
  check('nothing was minted by any of those', (await cardsOf(alice.address)).ids.length === 0);

  console.log('\n2. first onboard');
  const before = await req('GET', `/api/onboard/${alice.address}`);
  check('status before: starter not claimed, no MON',
    before.status === 200 && before.data.starterClaimed === false && before.data.mon.wei === '0',
    JSON.stringify(before.data).slice(0, 120));

  const body = await signed(alice, 'onboard');
  const first = await req('POST', '/api/onboard', body);
  check('signed onboard is 200', first.status === 200, `${first.status} ${JSON.stringify(first.data).slice(0, 200)}`);
  check('starter reported minted', first.data?.starter === 'minted');
  check('MON drip reported sent', first.data?.mon === 'sent');
  check('AUSD from the real faucet: sent, or queued inside its cooldown', ['sent', 'queued'].includes(first.data?.ausd), first.data?.ausd);
  if (first.data?.ausd === 'sent') {
    const ausd = await chain.readContract({ address: deployment.ausd, abi: erc20Abi, functionName: 'balanceOf', args: [alice.address] });
    check('the faucet\'s AUSD landed', ausd > 0n, String(ausd));
  }
  check('tx hashes returned for the mint and the drip',
    /^0x[0-9a-f]{64}$/.test(first.data?.txs?.starter ?? '') && /^0x[0-9a-f]{64}$/.test(first.data?.txs?.mon ?? ''));

  const owned = await cardsOf(alice.address);
  check('exactly 8 cards on chain', owned.ids.length === 8, `${owned.ids.length}`);
  check('the response lists the same 8 card ids',
    (first.data?.cardIds ?? []).slice().sort().join() === owned.ids.map(String).sort().join());
  const coins = owned.data.map((c) => Number(c.coinId));
  check('8 distinct coins', new Set(coins).size === 8, coins.join(','));
  check('every card is level 1 with no mint price', owned.data.every((c) => Number(c.level) === 1 && BigInt(c.mintPrice) === 0n));
  const arch = new Set(owned.data.map((c) => Number(c.archetype)));
  check('the deck covers all 6 archetypes', arch.size === 6, [...arch].sort().join(','));
  check('the coins are the advertised starter deck',
    coins.slice().sort((a, b) => a - b).join() === (first.data?.starterCoins ?? []).slice().sort((a, b) => a - b).join());

  const mon = await chain.getBalance({ address: alice.address });
  check('the MON drip landed (0.25, enough for a first stake)', mon === parseEther('0.25'), formatEther(mon));

  console.log('\n3. once per address');
  const replay = await req('POST', '/api/onboard', body);
  check('the same signed body again is 401 (replay)', replay.status === 401, replay.data?.error);
  const second = await req('POST', '/api/onboard', await signed(alice, 'onboard'));
  check('a fresh second onboard is 409', second.status === 409, second.data?.error);
  const lower = await req('POST', '/api/onboard', await signed(alice, 'onboard', {}, alice.address.toLowerCase()));
  check('the lowercase spelling of the same address is also 409', lower.status === 409, lower.data?.error);
  check('still exactly 8 cards', (await cardsOf(alice.address)).ids.length === 8);
  check('no second drip', (await chain.getBalance({ address: alice.address })) === parseEther('0.25'));

  const after = await req('GET', `/api/onboard/${alice.address.toLowerCase()}`);
  check('status after: starter claimed, claim complete',
    after.data?.starterClaimed === true && after.data?.claim?.complete === true && after.data?.mon?.balance === '0.25',
    JSON.stringify(after.data?.claim ?? null).slice(0, 120));

  console.log('\n4. concurrency');
  const [bob, carol, dave] = [freshAccount(), freshAccount(), freshAccount()];
  const bodies = await Promise.all([bob, carol, dave].map((a) => signed(a, 'onboard')));
  const results = await Promise.all(bodies.map((b) => req('POST', '/api/onboard', b)));
  check('three simultaneous onboards all succeed', results.every((r) => r.status === 200),
    results.map((r) => `${r.status}${r.data?.errors ? ` ${JSON.stringify(r.data.errors).slice(0, 80)}` : ''}`).join(' | '));
  const decks = await Promise.all([bob, carol, dave].map((a) => cardsOf(a.address)));
  check('each holds exactly 8 cards', decks.every((d) => d.ids.length === 8), decks.map((d) => d.ids.length).join(','));
  const nonces = await Promise.all(results.flatMap((r) => [r.data?.txs?.starter, r.data?.txs?.mon])
    .filter(Boolean).map((hash) => chain.getTransaction({ hash }).then((t) => t.nonce)));
  check('six relayer transactions, six distinct nonces', nonces.length === 6 && new Set(nonces).size === 6, nonces.join(','));

  console.log('\n5. gas limits');
  const mintTx = await chain.getTransaction({ hash: first.data.txs.starter });
  const mintRcpt = await chain.getTransactionReceipt({ hash: first.data.txs.starter });
  const ratio = Number(mintTx.gas) / Number(mintRcpt.gasUsed);
  check('the mint was sent with an estimated limit, not a blanket default', ratio > 1 && ratio < 1.6,
    `limit ${mintTx.gas} / used ${mintRcpt.gasUsed} = ${ratio.toFixed(3)}`);

  console.log('\n6. card metadata');
  const cardId = owned.ids[0];
  const meta = await req('GET', `/nft/${cardId}`);
  check('/nft/:id is 200', meta.status === 200, meta.data?.error);
  check('name is "$TICKER · Lv 1"', /^\$[A-Z0-9]+ · Lv 1$/.test(meta.data?.name ?? ''), meta.data?.name);
  check('image points at the app art', /^https:\/\/mempire\.test\/art\/card_[a-z0-9]+\.png$/.test(meta.data?.image ?? ''), meta.data?.image);
  const attr = Object.fromEntries((meta.data?.attributes ?? []).map((a) => [a.trait_type, a.value]));
  check('attributes carry ticker, kind, level and archetype name',
    attr.Ticker && attr.Kind && attr.Level === 1 && ['Tank', 'Swarm', 'Ranged', 'Splash', 'Support', 'Spell'].includes(attr.Archetype),
    JSON.stringify(attr));
  check('a starter card has no mint price attribute', !('Mint price (USD)' in attr));
  const missing = await req('GET', '/nft/999999999');
  check('a card that does not exist is 404', missing.status === 404);
  const zero = await req('GET', '/nft/0');
  check('card 0 is 404', zero.status === 404);
} catch (e) {
  check('suite ran to completion', false, String(e?.stack ?? e).slice(0, 400));
  console.log(relay.log().slice(-2000));
} finally {
  await relay.stop();
  await tc.stop();
}

process.exit(done() ? 1 : 0);
