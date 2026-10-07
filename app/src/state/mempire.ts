import { create } from 'zustand';
import { mempireBalance } from '../chain/spend';

/**
 * The wallet's $MEMPIRE, as one number the whole app reads.
 *
 * # Why this store exists
 *
 * The game used to run two currencies. Crowns were the soft one — granted
 * freely, spent on shop cards and rerolls, never leaving the game — and
 * $MEMPIRE was the hard one, spent on chest skips and clan charters. The
 * reasoning was sound in the abstract: a currency the game *spends* should not
 * be repriced by traders, so the tradable token stayed out of the checkout.
 *
 * In practice it produced a header reading `0 $MEMPIRE` beside `120 ♛`, and
 * every player read that as "I have 120 of the token this game is named
 * after". They did not. They had 120 of a thing that does not exist on chain,
 * next to none of the thing that does — and the one number they watched all
 * game was the fake one. A token economy whose visible balance is play money
 * is not a token economy, it is a scoreboard with a mint address attached.
 *
 * So there is one currency now, it is the real SPL token, and this store is
 * where its balance lives. Read it, do not cache it elsewhere: it is the only
 * copy, and it is always what the chain last said.
 *
 * # Why the balance is nullable
 *
 * `null` means "not read yet", which is not the same as zero and must not
 * render as zero — showing a real wallet 0 for the second before the first
 * read lands is exactly the throttled-RPC bug that made funded wallets look
 * empty. Callers render nothing until there is a number.
 */
interface MempireState {
  /** Whole $MEMPIRE, or null before the first read lands. */
  balance: number | null;
  /** The address the current balance belongs to, so a wallet swap invalidates. */
  address: string | null;
  refresh: (address: string | null) => Promise<void>;
  /** True when the wallet can cover `price` whole tokens. Unknown reads false. */
  canAfford: (price: number) => boolean;
}

export const useMempire = create<MempireState>((set, get) => ({
  balance: null,
  address: null,

  refresh: async (address) => {
    if (!address) {
      set({ balance: null, address: null });
      return;
    }
    try {
      // Whole tokens. The economy is priced in units of one, so the fraction
      // is noise on every screen that shows it.
      set({ balance: Math.floor(await mempireBalance(address)), address });
    } catch {
      // Leave the last known number rather than blanking the header on a
      // single failed read — the retrying fetch under this will usually win.
      set({ address });
    }
  },

  canAfford: (price) => {
    const b = get().balance;
    return b !== null && b >= price;
  },
}));

/**
 * Refresh after a spend lands.
 *
 * `ConfirmSpend` fires `mempire-spent` once the transfer confirms. The delay is
 * for the RPC rather than the chain: reading the balance in the same tick the
 * signature confirms usually returns the pre-spend number, and a header that
 * does not move is the whole reason this rewrite happened.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('mempire-spent', () => {
    const { address, refresh } = useMempire.getState();
    setTimeout(() => void refresh(address), 1200);
  });
}
