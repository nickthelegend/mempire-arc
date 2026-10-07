import { create } from 'zustand';
import { COINS } from '../lib/coins';

/**
 * The daily Shop.
 *
 * This is the only route to a coin the player does not already hold, which is
 * what makes it convert: wanting a specific card is a want the game cannot
 * otherwise satisfy. Offers rotate on a real 24h clock so the visit is a habit,
 * and a paid reroll exists for players who will not wait for tomorrow.
 */

export const SHOP_SLOTS = 4;
export const FREE_REROLLS = 1;
/** Reroll, in whole $MEMPIRE. Was 35 Crowns; the currency changed, not the cost. */
export const REROLL_COST = 35;
import { IS_MAINNET } from '../chain/provider';

const DAY_MS = 86_400_000;
/** The shop day: real 24h on mainnet, 3 minutes on testnet so a judge sees a rotation. */
export const DEMO_DAY_MS = IS_MAINNET ? DAY_MS : 3 * 60_000;

export interface ShopOffer {
  mint: string;
  /** Whole $MEMPIRE. */
  tokenPrice: number;
  solPrice: number;
  /** 0 = plain, else a percentage off shown as a flash-sale tag. */
  discountPct: number;
  bought: boolean;
}

/** Deterministic per-day pick, so every player sees the same shop that day. */
function dayIndex(): number {
  return Math.floor(Date.now() / DEMO_DAY_MS);
}

function priceFor(mint: string): { tokenPrice: number; solPrice: number } {
  const coin = COINS.find((c) => c.mint === mint);
  // Deeper liquidity means a more desirable card, so it costs more.
  const liq = coin?.liquidityUsd ?? 50_000;
  const tier = liq > 300_000 ? 3 : liq > 120_000 ? 2 : 1;
  return { tokenPrice: [0, 60, 120, 250][tier], solPrice: [0, 0.03, 0.06, 0.12][tier] };
}

function rollOffers(seed: number, exclude: Set<string> = new Set()): ShopOffer[] {
  const pool = COINS.filter((c) => !exclude.has(c.mint));
  const picks: ShopOffer[] = [];
  let s = (seed * 2654435761) % 4294967296;
  const next = () => {
    s = (s * 1103515245 + 12345) % 4294967296;
    return s / 4294967296;
  };
  const taken = new Set<number>();
  while (picks.length < Math.min(SHOP_SLOTS, pool.length)) {
    const i = Math.floor(next() * pool.length);
    if (taken.has(i)) continue;
    taken.add(i);
    const coin = pool[i];
    const { tokenPrice, solPrice } = priceFor(coin.mint);
    // one slot in four carries a flash discount — the reason to look daily
    const discountPct = next() > 0.78 ? [20, 30, 50][Math.floor(next() * 3)] : 0;
    picks.push({ mint: coin.mint, tokenPrice, solPrice, discountPct, bought: false });
  }
  return picks;
}

interface ShopState {
  offers: ShopOffer[];
  day: number;
  rerollsUsed: number;
  /** Refresh when the day rolls over. Called on mount and on focus. */
  ensureFresh: () => void;
  reroll: (pay: (n: number) => boolean) => string | null;
  markBought: (mint: string) => void;
  msUntilRotation: () => number;
}

export const useShop = create<ShopState>((set, get) => ({
  offers: rollOffers(dayIndex()),
  day: dayIndex(),
  rerollsUsed: 0,

  ensureFresh: () => {
    const today = dayIndex();
    if (get().day === today) return;
    set({ offers: rollOffers(today), day: today, rerollsUsed: 0 });
  },

  reroll: (pay) => {
    const used = get().rerollsUsed;
    if (used >= FREE_REROLLS) {
      if (!pay(REROLL_COST)) return `need ${REROLL_COST} $MEMPIRE to reroll`;
    }
    // exclude what is already on the shelf so a reroll always changes something
    const shown = new Set(get().offers.map((o) => o.mint));
    set({ offers: rollOffers(Date.now() % 100000, shown), rerollsUsed: used + 1 });
    return null;
  },

  markBought: (mint) =>
    set((s) => ({ offers: s.offers.map((o) => (o.mint === mint ? { ...o, bought: true } : o)) })),

  msUntilRotation: () => DEMO_DAY_MS - (Date.now() % DEMO_DAY_MS),
}));

export const DAY_LABEL_MS = DAY_MS; // documented real cadence for the UI copy
