import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { activeSigner, signText } from '../chain/account';
import { IS_MAINNET } from '../chain/provider';

/*
 * Identity for the relay, and the guest key.
 *
 * The relay authenticates every write by an EIP-191 signature over a
 * timestamped, per-action message — a wallet address identifies, it does not
 * authenticate. Whoever is signed in signs it: a passkey session or a guest key
 * without a prompt, a browser wallet with one.
 *
 * The guest key is a real secp256k1 key generated in this browser, which is what
 * lets a first-time player be in a match — and hold a starter deck on chain —
 * before they have decided anything. It is a testnet convenience: on mainnet a
 * key in localStorage is refused for anything that holds value.
 */

/*
 * `?guest=2` (testnet only) gives a tab its own guest, so two tabs on one
 * machine can play each other — which is how a staked match is demoed on a
 * single laptop. Without the parameter every tab shares the one guest.
 */
const slot = (() => {
  try {
    const g = new URLSearchParams(window.location.search).get('guest');
    return g && /^[1-9]$/.test(g) && g !== '1' ? `_${g}` : '';
  } catch {
    return '';
  }
})();
const GUEST_SK = `mempire_guest_evm_sk${slot}`;
const GUEST_ON = `mempire_guest_on${slot}`;

/** The exact bytes the relay verifies. Any drift here fails every request. */
export function authMessage(address: string, action: string, ts: number): string {
  return `Mempire\naction: ${action}\nwallet: ${address}\nts: ${ts}`;
}

function storedGuestKey(): Hex | null {
  try {
    const k = localStorage.getItem(GUEST_SK);
    return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null;
  } catch {
    return null;
  }
}

/** The guest account, created on first use. Null on mainnet. */
export function guestAccount(): PrivateKeyAccount | null {
  if (IS_MAINNET) return null;
  let k = storedGuestKey();
  if (!k) {
    k = generatePrivateKey();
    try { localStorage.setItem(GUEST_SK, k); } catch { /* the guest lives for this tab only */ }
  }
  return privateKeyToAccount(k);
}

export interface Signed {
  address: string;
  ts: number;
  signature: string;
}

/**
 * Sign `action` for the relay as the active signer.
 *
 * Returns null rather than throwing when nobody is signed in or the wallet
 * declines: every caller treats an unsigned request as "this write does not
 * happen", which is the right outcome either way.
 */
export async function signAction(_address: string, action: string, _legacy?: unknown): Promise<Signed | null> {
  const s = activeSigner();
  if (!s) return null;
  const ts = Date.now();
  try {
    const signature = await signText(authMessage(s.address, action, ts), s);
    return { address: s.address, ts, signature };
  } catch {
    return null;
  }
}

export function clearGuestIdentity(): void {
  try { localStorage.removeItem(GUEST_SK); } catch { /* nothing to clear */ }
  markGuestActive(false);
}

export function markGuestActive(on: boolean): void {
  try {
    if (on) localStorage.setItem(GUEST_ON, '1');
    else localStorage.removeItem(GUEST_ON);
  } catch { /* private mode — the session simply will not survive a reload */ }
}

export function guestWasActive(): boolean {
  try { return localStorage.getItem(GUEST_ON) === '1'; } catch { return false; }
}
