import { create } from 'zustand';
import { useCollection } from './collection';
import { useChain } from './chain';

/*
 * The four stake tiers, in both currencies. These mirror
 * `MempireArena.stakeFor` exactly — the contract refuses any other amount, so
 * the tier is a fact the chain enforces, not a label the client picks.
 */
export const TIERS = [
  { crowns: 1, mon: 0.01, ausd: 1, name: 'Pauper' },
  { crowns: 2, mon: 0.05, ausd: 5, name: 'Knight' },
  { crowns: 3, mon: 0.25, ausd: 25, name: 'Duke' },
  { crowns: 4, mon: 1, ausd: 100, name: 'Emperor' },
] as const;

export type StakeCurrency = 'MON' | 'AUSD';

export const stakeOf = (tier: number, currency: StakeCurrency): number =>
  (currency === 'AUSD' ? TIERS[tier].ausd : TIERS[tier].mon);

/** Tiers from here up ask for the passkey again, even inside an open session. */
export const STEP_UP_TIER = 2;

export const DECK_SLOTS = 3;

interface DeckState {
  active: string[]; // card ids, max 8
  tier: number; // index into TIERS
  /** What the pot is in: MON, or Agora's AUSD dollar stablecoin. */
  currency: StakeCurrency;
  setCurrency: (c: StakeCurrency) => void;
  /** Saved loadouts. Slot `slot` mirrors `active` while selected. */
  slots: string[][];
  slot: number;
  toggleCard: (cardId: string) => void;
  setTier: (i: number) => void;
  selectSlot: (i: number) => void;
  isComplete: () => boolean;
  power: () => number;
}


export const useDeck = create<DeckState>((set, get) => ({
  // Filled from the account's on-chain cards by useChainSync.
  active: [],
  tier: 0,
  currency: 'AUSD',
  setCurrency: (c) => set({ currency: c }),
  slots: [[], [], []],
  slot: 0,

  toggleCard: (cardId) =>
    set((s) => {
      let active: string[];
      if (s.active.includes(cardId)) {
        active = s.active.filter((id) => id !== cardId);
      } else {
        if (s.active.length >= 8) return s;
        // one card per coin per deck
        const cards = useCollection.getState().cards;
        const mint = cards.find((c) => c.id === cardId)?.mint;
        const dupe = s.active.some((id) => cards.find((c) => c.id === id)?.mint === mint);
        if (dupe) return s;
        active = [...s.active, cardId];
      }
      // the selected slot always mirrors the live deck, so edits are never lost
      const slots = s.slots.map((sl, i) => (i === s.slot ? active : sl));
      return { active, slots };
    }),

  setTier: (i) => set({ tier: i }),

  selectSlot: (i) =>
    set((s) => {
      if (i === s.slot || i < 0 || i >= DECK_SLOTS) return s;
      const slots = s.slots.map((sl, k) => (k === s.slot ? s.active : sl));
      // an untouched slot starts from the current deck rather than empty —
      // building a second deck from scratch is a chore nobody wants
      const next = slots[i].length ? slots[i] : s.active;
      return { slot: i, slots, active: next };
    }),

  isComplete: () => get().active.length === 8,
  /*
   * Power the chain will agree with.
   *
   * This summed `useCollection`'s levels — a local mirror that starts every
   * card at level 1 and is never refreshed — while `validate_and_lock_deck`
   * sums the levels on the card accounts it actually locks. The two numbers
   * are unrelated the moment anyone merges a duplicate, and three things
   * consume this one: the power shown on the deck, the `power` sent to the
   * matchmaker, and therefore who a player is paired against. `join_match`
   * then checks the *chain* power against `config.power_band` — so the relay
   * would pair two decks it believed were both power 8, seat 0's stake would
   * commit, and seat 1's join would be refused with `PowerOutOfBand` on a
   * match that had already taken money.
   *
   * The chain card is the authority when there is one, exactly as in
   * `buildDecks`. Local levels survive only for play that never touches chain.
   */
  power: () => {
    const cards = useCollection.getState().cards;
    const chainCards = useChain.getState().cards;
    return get().active.reduce((sum, id) => {
      const c = cards.find((x) => x.id === id);
      if (!c) return sum;
      const onchain = chainCards.find((k) => k.mint === c.mint && !k.inMatch);
      return sum + (onchain ? onchain.level : c.level);
    }, 0);
  },
}));
