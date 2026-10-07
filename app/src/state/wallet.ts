import type { EIP1193Provider } from 'viem';
import { create } from 'zustand';
import {
  injectedSigner, localSigner, onSigned, setSigner,
} from '../chain/account';
import { guestAccount, guestWasActive, markGuestActive } from '../lib/identity';
import {
  createPasskeyAccount, passkeyErrorText, passkeyHint, signInWithPasskey, type PasskeySession,
} from '../lib/passkey';

/*
 * The signed-in account, whichever kind it is.
 *
 * # The passkey session, and when it ends
 *
 * A passkey sign-in opens a signing session: the derived key lives in memory
 * and every transaction signs without a prompt — mints, merges, card plays,
 * claims. That is what makes a sub-second chain feel like a game rather than a
 * stream of confirmations. It is also a live key, so it is scoped in time:
 *
 *  - it ends after IDLE_MS without a signature, and at MAX_MS no matter what;
 *  - ending it drops the in-memory key (`session.end()`); the account shows as
 *    locked, one tap and one passkey prompt opens a new session, and the
 *    address is the same because it is derived, not stored;
 *  - stakes at or above the Duke tier ask for the passkey again even inside
 *    an open session (see `confirmWithPasskey`), so the session can play and
 *    spend small amounts on its own but cannot put real size on a match.
 *
 * A match in progress keeps its own per-match session key (chain/session.ts),
 * so a passkey session expiring mid-match never interrupts the match.
 */

const IDLE_MS = 30 * 60_000;
const MAX_MS = 2 * 60 * 60_000;

export type WalletKind = 'passkey' | 'guest' | 'injected';

export interface WalletChoice {
  id: string;
  name: string;
  icon: string;
  provider: EIP1193Provider;
}

/** EIP-6963: every installed wallet announces itself; nobody fights over window.ethereum. */
const discovered = new Map<string, WalletChoice>();
let discoveryStarted = false;

function startDiscovery(onChange: () => void): void {
  if (discoveryStarted || typeof window === 'undefined') return;
  discoveryStarted = true;
  window.addEventListener('eip6963:announceProvider', ((ev: CustomEvent) => {
    const d = ev.detail as { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider };
    if (!d?.info?.rdns || !d.provider) return;
    discovered.set(d.info.rdns, { id: d.info.rdns, name: d.info.name, icon: d.info.icon, provider: d.provider });
    onChange();
  }) as EventListener);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

let passkey: PasskeySession | null = null;
let lockTimer: ReturnType<typeof setTimeout> | null = null;

interface WalletState {
  connected: boolean;
  connecting: string | null;
  error: string | null;
  address: string;
  walletName: string;
  walletIcon: string | null;
  kind: WalletKind | null;
  /** USDC balance in dollars, read from chain (Arc's gas token and the stake currency). */
  usdc: number;
  isGuest: boolean;
  /** A passkey account whose session has ended: same address, needs one prompt. */
  locked: boolean;
  sessionStartedAt: number;
  sessionExpiresAt: number;
  pickerOpen: boolean;
  wallets: WalletChoice[];

  openPicker: () => void;
  closePicker: () => void;
  createPasskey: (name: string) => Promise<void>;
  signInPasskey: () => Promise<void>;
  connectGuest: () => void;
  connect: (id: string) => Promise<void>;
  autoConnect: () => Promise<void>;
  /** Called after each signature: an active session stays open while it is used. */
  touch: () => void;
  lock: () => void;
  disconnect: () => void;
  setChainBalance: (usdc: number) => void;
  spend: (amount: number) => boolean;
  receive: (amount: number) => void;
}

export const useWallet = create<WalletState>((set, get) => {
  const refreshWallets = () => set({ wallets: [...discovered.values()] });

  const armExpiry = () => {
    if (lockTimer) clearTimeout(lockTimer);
    const { sessionStartedAt } = get();
    const expiresAt = Math.min(Date.now() + IDLE_MS, sessionStartedAt + MAX_MS);
    set({ sessionExpiresAt: expiresAt });
    lockTimer = setTimeout(() => get().lock(), Math.max(0, expiresAt - Date.now()));
  };

  const adoptPasskey = (s: PasskeySession, name: string) => {
    passkey?.session.end();
    passkey = s;
    setSigner(localSigner('passkey', s.account, name));
    markGuestActive(false);
    set({
      connected: true, connecting: null, pickerOpen: false, error: null,
      address: s.account.address, walletName: name, walletIcon: null,
      kind: 'passkey', isGuest: false, locked: false, sessionStartedAt: Date.now(),
    });
    armExpiry();
  };

  return {
    connected: false,
    connecting: null,
    error: null,
    address: '',
    walletName: '',
    walletIcon: null,
    kind: null,
    usdc: 0,
    isGuest: false,
    locked: false,
    sessionStartedAt: 0,
    sessionExpiresAt: 0,
    pickerOpen: false,
    wallets: [],
    openPicker: () => {
      startDiscovery(refreshWallets);
      refreshWallets();
      set({ pickerOpen: true, error: null });
    },
    closePicker: () => set({ pickerOpen: false, connecting: null }),

    createPasskey: async (name) => {
      if (get().connecting) return;
      set({ connecting: 'passkey', error: null });
      try {
        adoptPasskey(await createPasskeyAccount(name.trim() || 'Mempire player'), name.trim() || 'Passkey');
      } catch (e) {
        set({ connecting: null, error: passkeyErrorText(e) });
      }
    },

    signInPasskey: async () => {
      if (get().connecting) return;
      set({ connecting: 'passkey', error: null });
      try {
        const s = await signInWithPasskey();
        adoptPasskey(s, passkeyHint()?.name ?? 'Passkey');
      } catch (e) {
        set({ connecting: null, error: passkeyErrorText(e) });
      }
    },

    connectGuest: () => {
      const account = guestAccount();
      if (!account) {
        set({ error: 'Guest play is testnet-only' });
        return;
      }
      passkey?.session.end();
      passkey = null;
      setSigner(localSigner('guest', account, 'Guest'));
      markGuestActive(true);
      set({
        connected: true, connecting: null, pickerOpen: false, error: null,
        address: account.address, walletName: 'Guest', walletIcon: null,
        kind: 'guest', isGuest: true, locked: false,
      });
    },

    connect: async (id) => {
      if (get().connecting) return;
      const choice = discovered.get(id);
      if (!choice) {
        set({ error: 'That wallet is not available in this browser' });
        return;
      }
      set({ connecting: choice.name, error: null });
      try {
        const s = await injectedSigner(choice.provider, choice.name, choice.icon);
        passkey?.session.end();
        passkey = null;
        setSigner(s);
        markGuestActive(false);
        set({
          connected: true, connecting: null, pickerOpen: false,
          address: s.address, walletName: choice.name, walletIcon: choice.icon,
          kind: 'injected', isGuest: false, locked: false,
        });
        const p = choice.provider as EIP1193Provider & {
          on?: (ev: string, fn: (...a: unknown[]) => void) => void;
        };
        p.on?.('accountsChanged', () => get().disconnect());
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Connection failed';
        set({ connecting: null, error: /reject|denied|cancel|user/i.test(msg) ? 'Connection rejected' : msg });
      }
    },

    /*
     * A reload never opens a passkey session on its own — that would be a
     * prompt the player did not ask for. It shows the remembered account as
     * locked instead, one tap from open. A guest resumes silently.
     */
    autoConnect: async () => {
      startDiscovery(refreshWallets);
      if (get().connected) return;
      const hint = passkeyHint();
      if (hint) {
        set({
          connected: false, locked: true, address: hint.address, walletName: hint.name,
          kind: 'passkey', isGuest: false,
        });
        return;
      }
      if (guestWasActive()) get().connectGuest();
    },

    touch: () => {
      if (get().kind === 'passkey' && !get().locked && passkey) armExpiry();
    },

    lock: () => {
      if (get().kind !== 'passkey') return;
      if (lockTimer) clearTimeout(lockTimer);
      passkey?.session.end();
      passkey = null;
      setSigner(null);
      set({ connected: false, locked: true, sessionExpiresAt: 0 });
    },

    disconnect: () => {
      if (lockTimer) clearTimeout(lockTimer);
      passkey?.session.end();
      passkey = null;
      setSigner(null);
      markGuestActive(false);
      set({
        connected: false, address: '', walletName: '', walletIcon: null, kind: null,
        usdc: 0, isGuest: false, locked: false, pickerOpen: false, sessionExpiresAt: 0,
      });
    },

    setChainBalance: (usdc) => set({ usdc: +usdc.toFixed(6) }),
    spend: (amount) => get().usdc >= amount,
    receive: () => { /* the chain is the only source of a balance */ },
  };
});

onSigned(() => useWallet.getState().touch());

/** Back-compat for call sites that ask "who signs?" — the active signer, or null. */
export { activeSigner as signer } from '../chain/account';
