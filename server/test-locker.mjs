/**
 * The passkey locker store: opaque ids, opaque ciphertext, strict shapes.
 *
 *   node test-locker.mjs
 */
import { randomBytes } from 'node:crypto';
import { startRelay, tally } from './test-util.mjs';

const { check, done } = tally();
const PORT = 8797;
const relay = await startRelay(PORT, { CHAIN_ID: '10143' });
const API = `http://127.0.0.1:${PORT}`;
const hex = (n) => randomBytes(n).toString('hex');

try {
  const id = hex(32);
  let r = await fetch(`${API}/api/locker/${id}`);
  check('an unknown locker is 404', r.status === 404);

  const blob = { v: 1, iv: hex(12), ct: hex(200) };
  r = await fetch(`${API}/api/locker/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(blob) });
  check('a well-formed locker is stored', r.ok);
  r = await fetch(`${API}/api/locker/${id}`);
  const got = await r.json();
  check('it comes back byte for byte', got.iv === blob.iv && got.ct === blob.ct && got.v === 1);

  const blob2 = { v: 1, iv: hex(12), ct: hex(64) };
  await fetch(`${API}/api/locker/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(blob2) });
  got.ct = (await (await fetch(`${API}/api/locker/${id}`)).json()).ct;
  check('a save replaces the previous one', got.ct === blob2.ct);

  const bad = async (path, body) => (await fetch(`${API}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
  check('a short id is refused', await bad(`/api/locker/${hex(16)}`, blob) === 400);
  check('a non-hex id is refused', await bad(`/api/locker/${'z'.repeat(64)}`, blob) === 400);
  check('an uppercase id is refused (one spelling per locker)', await bad(`/api/locker/${id.toUpperCase()}`, blob) === 400);
  check('a wrong iv length is refused', await bad(`/api/locker/${id}`, { ...blob, iv: hex(8) }) === 400);
  check('an oversized blob is refused', await bad(`/api/locker/${id}`, { ...blob, ct: hex(9000) }) === 400);
  check('an unknown version is refused', await bad(`/api/locker/${id}`, { ...blob, v: 2 }) === 400);
} finally {
  relay.stop();
}
done();
