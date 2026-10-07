/**
 * Wallet-signature auth, without a server.
 *
 * The rules in `auth.js` that are easy to get subtly wrong: the exact message
 * text, the five-minute window, and the one-spelling-per-signature rule the
 * replay store depends on — a malleated (high-s) twin or an uppercase copy of a
 * captured signature must not count as a fresh one.
 *
 *   node test-auth.mjs
 */
import { parseSignature, serializeSignature } from 'viem';
import { canonicalSignature, verifySignature } from './auth.js';
import { normAddress } from './chain.js';
import { authMessage, freshAccount, tally } from './test-util.mjs';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const { check, done } = tally();

const me = freshAccount();
const ts = Date.now();
const sign = (address, action, t = ts) => me.signMessage({ message: authMessage(address, action, t) });

console.log('1. verification');
const sig = await sign(me.address, 'onboard');
check('a correct signature verifies', (await verifySignature({ address: me.address, action: 'onboard', ts, signature: sig })) === null);
check('the same signature for another action does not',
  (await verifySignature({ address: me.address, action: 'clan.kick', ts, signature: sig })) !== null);
check('the same signature at another timestamp does not',
  (await verifySignature({ address: me.address, action: 'onboard', ts: ts + 1, signature: sig })) !== null);
check('another wallet\'s address does not',
  (await verifySignature({ address: freshAccount().address, action: 'onboard', ts, signature: sig })) !== null);
const lowerSig = await sign(me.address.toLowerCase(), 'onboard');
check('a lowercase address the wallet signed as lowercase verifies',
  (await verifySignature({ address: me.address.toLowerCase(), action: 'onboard', ts, signature: lowerSig })) === null);
const old = Date.now() - 6 * 60_000;
check('a six-minute-old signature has expired',
  (await verifySignature({ address: me.address, action: 'onboard', ts: old, signature: await sign(me.address, 'onboard', old) }))
    === 'signature expired');
check('a non-EVM address is refused before any crypto',
  /20-byte/.test(await verifySignature({ address: 'GKLFeUT1cqG82iVkRsBekyZh5eCbhHSDjdvZLA1HZzxj', action: 'onboard', ts, signature: sig })));
check('garbage does not throw', typeof (await verifySignature({ address: me.address, action: 'onboard', ts, signature: '0xzz' })) === 'string');

console.log('\n2. one spelling per signature');
const p = parseSignature(sig);
const twin = serializeSignature({ r: p.r, s: `0x${(N - BigInt(p.s)).toString(16).padStart(64, '0')}`, yParity: p.yParity ? 0 : 1 });
check('the malleated high-s twin is refused',
  canonicalSignature(twin) === null
  && (await verifySignature({ address: me.address, action: 'onboard', ts, signature: twin })) !== null);
check('an uppercase copy canonicalises to the same key',
  canonicalSignature(`0x${sig.slice(2).toUpperCase()}`) === canonicalSignature(sig));
check('a 64-byte compact signature is refused', canonicalSignature(sig.slice(0, 130)) === null);

console.log('\n3. addresses');
check('checksummed and lowercase normalise together', normAddress(me.address) === normAddress(me.address.toLowerCase()));
check('a short address is null', normAddress('0x1234') === null);
check('a non-string is null', normAddress(42) === null);

process.exit(done() ? 1 : 0);
