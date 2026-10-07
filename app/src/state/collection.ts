import { create } from 'zustand';
import { coinByMint } from '../lib/coins';
import { archetypeForMint } from '../sim/archetypes';
import type { Archetype } from '../sim/types';

/** Mirrors the contracts: `MempireCards.mintFee` and `MempireArena.rakeBps`/`tieRakeBps`. */
export const FEES = {
  mintMon: 0.01,
  rakePct: 10,
  tieRakePct: 5,
};

// Devnet demo cooldown — mainnet is 72h; 60s here so judges can see the flow.

export interface MintedCard {
  id: string;
  mint: string; // coin mint
  archetype: Archetype;

  level: number;

  /**
   * A starter card, not something the player minted.
   *
   * These exist so a deck is fieldable before anyone spends anything, and they
   * merge alongside the real chain cards (see `useChainSync`). Anything asking
   * "has this coin been minted?" has to exclude them, or the answer is yes for
   * all eight starters and their Mint buttons vanish before they were ever used.
   */
  seeded?: boolean;
}

interface CollectionState {
  cards: MintedCard[];
  nextId: number;
  mintCard: (mint: string) => MintedCard | null;
  card: (id: string) => MintedCard | undefined;
}

export const useCollection = create<CollectionState>((set, get) => ({
  // Cards come from the chain only (useChainSync). Nothing is seeded locally:
  // a card on screen is a card the account owns.
  cards: [],
  nextId: 1,
  mintCard: (mint) => {
    const coin = coinByMint(mint);
    if (!coin) return null;
    const card: MintedCard = {
      id: `card_${get().nextId}`,
      mint,
      archetype: archetypeForMint(mint),
      level: 1,
    };
    set((s) => ({ cards: [...s.cards, card], nextId: s.nextId + 1 }));
    return card;
  },
  card: (id) => get().cards.find((c) => c.id === id),
}));
