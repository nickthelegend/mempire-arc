import { prfFor } from './passkey';
import { apiFetch, hasApi } from './api';

/*
 * The passkey locker: a second key from the same passkey, doing work that has
 * nothing to do with the account.
 *
 * The account comes from the PRF namespace `mempire.account.v1`. The locker
 * comes from `mempire.locker.v1` — a different salt, so a different and
 * unrelated 32 bytes. From those, HKDF derives two things with distinct `info`
 * labels:
 *
 *  - a non-extractable AES-256-GCM key that encrypts the locker in the browser;
 *  - a 256-bit locker id the relay stores the ciphertext under.
 *
 * The id is not the wallet address and cannot be linked to it: it comes from
 * another PRF output that only this passkey can produce. So the relay holds an
 * opaque blob under an opaque name — it cannot read the locker, cannot tell
 * whose it is, and cannot correlate it with anything on chain. Nothing derived
 * here is ever persisted; the PRF output is zeroed the moment HKDF has it.
 *
 * What it holds: saved decks (by fighter ticker, so they mean the same thing
 * on any device), and private scouting notes. Sign in with the same passkey on
 * a phone and the locker opens there — that is the cross-device test.
 */

export const LOCKER_LABEL = 'mempire.locker.v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface LockerContents {
  v: 1;
  savedAt: number;
  decks: string[][]; // tickers, per deck slot
  notes: string;
}

export interface OpenLocker {
  id: string;
  key: CryptoKey;
}

const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

const unhex = (h: string) => new Uint8Array((h.match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));

/** One passkey prompt: evaluate the locker namespace and derive id + key. */
export async function openLocker(): Promise<OpenLocker> {
  const prf = await prfFor(LOCKER_LABEL);
  let base: CryptoKey;
  try {
    base = await crypto.subtle.importKey('raw', prf as BufferSource, 'HKDF', false, ['deriveKey', 'deriveBits']);
  } finally {
    prf.fill(0);
  }
  const salt = new Uint8Array(32);
  const idBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('mempire/locker/id') }, base, 256,
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('mempire/locker/aes-256-gcm') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { id: hex(idBits), key };
}

/** Encrypt and store. The id is bound into the ciphertext as associated data. */
export async function saveLocker(l: OpenLocker, contents: LockerContents): Promise<void> {
  if (!hasApi()) throw new Error('the relay is not configured');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(l.id) },
    l.key,
    enc.encode(JSON.stringify(contents)),
  );
  const res = await apiFetch(`/api/locker/${l.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, iv: hex(iv), ct: hex(ct) }),
  });
  if (!res || !res.ok) throw new Error(`the relay refused the locker (${res?.status ?? 'offline'})`);
}

/** Fetch and decrypt. Null when this passkey has never saved a locker. */
export async function loadLocker(l: OpenLocker): Promise<LockerContents | null> {
  const res = await apiFetch(`/api/locker/${l.id}`);
  if (!res) throw new Error('the relay is unreachable');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the relay answered ${res.status}`);
  const body = await res.json() as { iv: string; ct: string };
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unhex(body.iv), additionalData: enc.encode(l.id) },
    l.key,
    unhex(body.ct),
  );
  return JSON.parse(dec.decode(pt)) as LockerContents;
}
