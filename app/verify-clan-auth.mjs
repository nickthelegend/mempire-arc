/**
 * A4.3 — is `clan.create` auth failing in the client or at the relay?
 *
 * Signs exactly what `identity.ts` signs, with the same key the browser holds,
 * and posts it. A pass here puts the fault in the client's request; a fail
 * puts it in the relay's verification.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';

const API = 'https://mempire-relay-production.up.railway.app';
const demo = JSON.parse(readFileSync(new URL('./.demo-wallets.json', import.meta.url)));
const secret = Uint8Array.from(demo['0']);

const kp = nacl.sign.keyPair.fromSecretKey(secret);
const address = bs58.encode(kp.publicKey);
const ts = Date.now();
const action = 'clan.create';
const msg = `Mempire\naction: ${action}\nwallet: ${address}\nts: ${ts}`;
const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey));

console.log('address :', address);
console.log('verifies locally:', nacl.sign.detached.verify(
  new TextEncoder().encode(msg), bs58.decode(signature), bs58.decode(address),
));

const res = await fetch(`${API}/api/clans`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    address, ts, signature,
    name: 'Verify Squad', motto: 'built under test',
    region: 'Global', minPower: 0, joinPolicy: 'open', crest: { colour: 212 },
  }),
});
console.log('POST /api/clans ->', res.status, (await res.text()).slice(0, 220));
