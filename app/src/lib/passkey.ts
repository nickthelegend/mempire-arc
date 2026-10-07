import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { bytesToHex, type LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/*
 * A Mempire account is a passkey. Nothing else.
 *
 * One WebAuthn ceremony evaluates the authenticator's PRF extension for our
 * account salt — 32 bytes that are a deterministic function of (credential,
 * rpId, salt), and that never leave the authenticator except to this page.
 * Those bytes are the BIP-39 entropy of a 24-word phrase the player never sees,
 * and the account is m/44'/60'/0'/0/0 under it: an ordinary Arc address that
 * holds USDC, pays its own gas in USDC and signs EIP-2612 permits. Same passkey,
 * same address, on any device the passkey syncs to; there is no seed phrase, no
 * extension, no custody backend, no third-party key service, and nothing secret
 * is ever written to storage.
 *
 * This is the browser's own WebAuthn PRF (Chrome, Safari, Edge, Firefox with
 * iCloud Keychain, Google Password Manager, 1Password, Windows Hello…), so it
 * works on any chain. Circle's Modular Wallets also run passkeys on Arc, as
 * ERC-4337 smart accounts; they need a Circle Console client key, and every
 * card play would become a UserOperation through a bundler. A PRF-derived key
 * keeps a card drop one plain sub-second transaction (see README → Accounts).
 *
 * What *is* stored, in localStorage, is the credential id and the address it
 * produced: a hint that lets the next sign-in target the right passkey and show
 * the right name before the prompt. Clearing it loses nothing — sign-in falls
 * back to a discoverable-credential prompt and the same key comes back.
 *
 * The derived key lives in a session object in memory; the PRF output, the BIP-39
 * seed and the key bytes are zeroed as soon as the account exists, and `end()`
 * drops the account. (A hex copy inside viem's account can't be wiped by
 * JavaScript — it goes when the session is dropped and collected.)
 */

const enc = new TextEncoder();
/** WebAuthn PRF salts are any bytes; a SHA-256 of a readable label keeps them human-auditable. */
async function salt(label: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(label)));
}

/** The namespace that derives the game account. Never reused for anything else. */
export const ACCOUNT_SALT_LABEL = 'mempire.account.v1';

const HINT_KEY = 'mempire_passkey_hint';
const DERIVATION_PATH = "m/44'/60'/0'/0/0";

export interface PasskeyHint {
  credentialId: string;
  address: string;
  name: string;
}

export function passkeyHint(): PasskeyHint | null {
  try {
    const raw = localStorage.getItem(HINT_KEY);
    return raw ? JSON.parse(raw) as PasskeyHint : null;
  } catch {
    return null;
  }
}

function saveHint(h: PasskeyHint): void {
  try { localStorage.setItem(HINT_KEY, JSON.stringify(h)); } catch { /* private mode: the passkey still works */ }
}

export function forgetPasskeyHint(): void {
  try { localStorage.removeItem(HINT_KEY); } catch { /* nothing to forget */ }
}

/** WebAuthn binds a passkey to a domain. Locally that is `localhost`. */
const rpId = (): string => window.location.hostname;

// ── WebAuthn PRF ─────────────────────────────────────────────────────────────

export type PasskeyErrorCode = 'PRF_UNAVAILABLE' | 'PASSKEY_OPERATION_FAILED' | 'UNSUPPORTED';
export class PasskeyError extends Error {
  readonly code: PasskeyErrorCode;
  constructor(code: PasskeyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const b64url = (b: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const random = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n));

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } } };

function prfOf(cred: PublicKeyCredential): Uint8Array | null {
  const ext = cred.getClientExtensionResults() as PrfResults;
  const first = ext.prf?.results?.first;
  return first ? new Uint8Array(first instanceof Uint8Array ? first : new Uint8Array(first)) : null;
}

async function ceremony<T>(fn: () => Promise<T>): Promise<T> {
  if (!passkeysSupported()) throw new PasskeyError('UNSUPPORTED', 'This browser cannot use passkeys here (it needs a secure context).');
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PasskeyError) throw e;
    throw new PasskeyError('PASSKEY_OPERATION_FAILED', e instanceof Error ? e.message : 'The passkey prompt failed.');
  }
}

/** Evaluate PRF(salt) with an existing passkey: the remembered one, or any for this site. */
async function evaluate(prfSalt: Uint8Array<ArrayBuffer>, credentialId?: string): Promise<{ prf: Uint8Array; credentialId: string }> {
  return ceremony(async () => {
    const cred = await navigator.credentials.get({
      publicKey: {
        rpId: rpId(),
        challenge: random(32),
        userVerification: 'required',
        allowCredentials: credentialId ? [{ type: 'public-key', id: unb64url(credentialId) }] : [],
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyError('PASSKEY_OPERATION_FAILED', 'The passkey prompt was cancelled.');
    const prf = prfOf(cred);
    if (!prf) throw new PasskeyError('PRF_UNAVAILABLE', 'This passkey cannot derive keys (no WebAuthn PRF).');
    return { prf, credentialId: b64url(cred.rawId) };
  });
}

/** Make a passkey with PRF enabled; read PRF(salt) from the same ceremony when the authenticator allows. */
async function register(name: string, prfSalt: Uint8Array<ArrayBuffer>): Promise<{ prf: Uint8Array; credentialId: string }> {
  return ceremony(async () => {
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId(), name: 'Mempire' },
        user: { id: random(16), name, displayName: name },
        challenge: random(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyError('PASSKEY_OPERATION_FAILED', 'The passkey prompt was cancelled.');
    const ext = cred.getClientExtensionResults() as PrfResults;
    if (ext.prf?.enabled === false) throw new PasskeyError('PRF_UNAVAILABLE', 'This passkey provider does not support WebAuthn PRF.');
    const credentialId = b64url(cred.rawId);
    const prf = prfOf(cred);
    // Some authenticators enable PRF at creation but only evaluate it on a get():
    // that is the second prompt "on some authenticators".
    return prf ? { prf, credentialId } : evaluate(prfSalt, credentialId);
  });
}

// ── the account ──────────────────────────────────────────────────────────────

/** An open signing session: the account, and `end()` to drop it. */
export interface SigningSession {
  end: () => void;
}

function deriveAccount(prfOutput: Uint8Array): LocalAccount {
  const mnemonic = entropyToMnemonic(prfOutput, wordlist);
  const seed = mnemonicToSeedSync(mnemonic);
  const node = HDKey.fromMasterSeed(seed).derive(DERIVATION_PATH);
  if (!node.privateKey) throw new Error('passkey derivation produced no key');
  const privateKey = new Uint8Array(node.privateKey);
  try {
    return privateKeyToAccount(bytesToHex(privateKey));
  } finally {
    privateKey.fill(0);
    seed.fill(0);
    node.wipePrivateData();
  }
}

export interface PasskeySession {
  account: LocalAccount;
  session: SigningSession;
  credentialId: string;
}

function open(prfOutput: Uint8Array, credentialId: string, name: string): PasskeySession {
  try {
    let account: LocalAccount | null = deriveAccount(prfOutput);
    saveHint({ credentialId, address: account.address, name });
    const live = account;
    return { account: live, session: { end: () => { account = null; } }, credentialId };
  } finally {
    prfOutput.fill(0);
  }
}

/** First visit: make a passkey and the account it derives. One prompt (two on some authenticators). */
export async function createPasskeyAccount(name: string): Promise<PasskeySession> {
  const res = await register(name, await salt(ACCOUNT_SALT_LABEL));
  return open(res.prf, res.credentialId, name);
}

/**
 * Returning visit, or a brand-new device: one prompt, same account.
 *
 * With a hint the prompt targets the remembered credential; without one —
 * cleared storage, a fresh browser — the platform offers every passkey it has
 * for this domain, and whichever the player picks derives its own account.
 */
export async function signInWithPasskey(): Promise<PasskeySession> {
  const hint = passkeyHint();
  const res = await evaluate(await salt(ACCOUNT_SALT_LABEL), hint?.credentialId);
  return open(res.prf, res.credentialId, hint?.name ?? 'Mempire player');
}

/**
 * Step-up: prove presence again before a big stake, without opening anything.
 *
 * The prompt evaluates the account salt again and the result must derive the
 * address already signed in — so the confirmation is the passkey itself saying
 * yes, not a button the open session could press on its own.
 */
export async function confirmWithPasskey(expected: string): Promise<boolean> {
  const hint = passkeyHint();
  const res = await evaluate(await salt(ACCOUNT_SALT_LABEL), hint?.credentialId);
  try {
    return deriveAccount(res.prf).address.toLowerCase() === expected.toLowerCase();
  } finally {
    res.prf.fill(0);
  }
}

/** Evaluate a non-account namespace. Callers must zero what they get back. */
export async function prfFor(label: string): Promise<Uint8Array> {
  const hint = passkeyHint();
  return (await evaluate(await salt(label), hint?.credentialId)).prf;
}

/** Can this browser even try? PRF support is only known for sure after a ceremony. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential !== 'undefined'
    && window.isSecureContext;
}

/** The errors worth saying differently. */
export function passkeyErrorText(e: unknown): string {
  if (e instanceof PasskeyError) {
    if (e.code === 'PRF_UNAVAILABLE') {
      return 'This browser\'s passkey store cannot derive keys (no PRF). Use iCloud Keychain, Google Password Manager or 1Password — or play as guest.';
    }
    if (e.code === 'PASSKEY_OPERATION_FAILED') return 'The passkey prompt was cancelled or failed.';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Passkey sign-in failed';
}
