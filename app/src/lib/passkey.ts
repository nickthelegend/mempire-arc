import {
  createPasskeyWithPrfOutput, createSecp256k1SigningSession, getPasskeyPrfOutput, isMeraError,
  type PasskeyCredentialMetadata, type Secp256k1SigningSession,
} from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { LocalAccount } from 'viem';

/*
 * A Mempire account is a passkey. Nothing else.
 *
 * One ceremony returns the authenticator's PRF output for our account salt —
 * 32 bytes that are a deterministic function of (credential, rpId, salt). Those
 * bytes are the BIP-39 entropy of a 24-word phrase the player never sees, and
 * the account is m/44'/60'/0'/0/0 under it. Same passkey, same address, on any
 * device the passkey syncs to; there is no seed phrase, no extension and no
 * custody backend, and nothing secret is ever written to storage.
 *
 * What *is* stored, in localStorage, is the credential id and the address it
 * produced: a hint that lets the next sign-in target the right passkey and show
 * the right name before the prompt. Clearing it loses nothing — sign-in falls
 * back to a discoverable-credential prompt and the same key comes back.
 *
 * The derived key goes straight into a Mera signing session and every
 * intermediate (PRF output, seed, private key) is zeroed. The session is the
 * only holder, and `end()` zeroes it too.
 */

/** sha256-free, human-readable salts: Mera takes any 32 bytes as a namespace. */
const enc = new TextEncoder();
async function salt(label: string): Promise<Uint8Array> {
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

function deriveSession(prfOutput: Uint8Array): Secp256k1SigningSession {
  const mnemonic = entropyToMnemonic(prfOutput, wordlist);
  const seed = mnemonicToSeedSync(mnemonic);
  const node = HDKey.fromMasterSeed(seed).derive(DERIVATION_PATH);
  if (!node.privateKey) throw new Error('passkey derivation produced no key');
  const privateKey = new Uint8Array(node.privateKey);
  try {
    return createSecp256k1SigningSession({ privateKey });
  } finally {
    privateKey.fill(0);
    seed.fill(0);
    node.wipePrivateData();
  }
}

export interface PasskeySession {
  account: LocalAccount;
  session: Secp256k1SigningSession;
  credentialId: string;
}

function open(prfOutput: Uint8Array, credentialId: string, name: string): PasskeySession {
  try {
    const session = deriveSession(prfOutput);
    const account = toViemAccount(session) as LocalAccount;
    saveHint({ credentialId, address: account.address, name });
    return { account, session, credentialId };
  } finally {
    prfOutput.fill(0);
  }
}

/** First visit: make a passkey and the account it derives. One prompt (two on some authenticators). */
export async function createPasskeyAccount(name: string): Promise<PasskeySession> {
  const res = await createPasskeyWithPrfOutput({
    rp: { id: rpId(), name: 'Mempire' },
    user: { name, displayName: name },
    prfSalt: await salt(ACCOUNT_SALT_LABEL),
  });
  return open(res.prfOutput, res.credentialId, name);
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
  const res = await getPasskeyPrfOutput({
    rpId: rpId(),
    prfSalt: await salt(ACCOUNT_SALT_LABEL),
    credential: hint ? { credentialId: hint.credentialId } as PasskeyCredentialMetadata : undefined,
  });
  return open(res.prfOutput, res.credentialId, hint?.name ?? 'Mempire player');
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
  const res = await getPasskeyPrfOutput({
    rpId: rpId(),
    prfSalt: await salt(ACCOUNT_SALT_LABEL),
    credential: hint ? { credentialId: hint.credentialId } as PasskeyCredentialMetadata : undefined,
  });
  const probe = deriveSession(res.prfOutput);
  res.prfOutput.fill(0);
  try {
    return toViemAccount(probe).address.toLowerCase() === expected.toLowerCase();
  } finally {
    probe.end();
  }
}

/** Evaluate a non-account namespace. Callers must zero what they get back. */
export async function prfFor(label: string): Promise<Uint8Array> {
  const hint = passkeyHint();
  const res = await getPasskeyPrfOutput({
    rpId: rpId(),
    prfSalt: await salt(label),
    credential: hint ? { credentialId: hint.credentialId } as PasskeyCredentialMetadata : undefined,
  });
  return res.prfOutput;
}

/** Can this browser even try? PRF support is only known for sure after a ceremony. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential !== 'undefined'
    && window.isSecureContext;
}

/** The errors worth saying differently. */
export function passkeyErrorText(e: unknown): string {
  if (isMeraError(e)) {
    if (e.code === 'PRF_UNAVAILABLE') {
      return 'This browser\'s passkey store cannot derive keys (no PRF). Use iCloud Keychain, Google Password Manager or 1Password — or play as guest.';
    }
    if (e.code === 'PASSKEY_OPERATION_FAILED') return 'The passkey prompt was cancelled or failed.';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Passkey sign-in failed';
}
