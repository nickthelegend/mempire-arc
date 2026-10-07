
/**
 * Chests — what winning pays out.
 *
 * # Crowns are gone
 *
 * This store used to hold `gems`: a soft currency granted freely, spent on
 * shop cards and rerolls, never touching the chain. The argument for it was
 * that a currency the game *spends* should not be repriced by traders. The
 * argument against it was on screen the whole time — a header reading
 * `0 $MEMPIRE` beside `120 ♛`, where the number players watched was the one
 * that did not exist. There is one currency now and it is the SPL token; see
 * `state/mempire.ts`.
 *
 * Chests therefore pay in **cards**, not currency. That is also the better
 * game: a chest you open for a fighter you can field is a reason to play the
 * next match, and a chest that pays a number is a reason to check a balance.
 *
 * The rule that survives unchanged: nothing bought here may sell stats. Power
 * comes from playing, so a paying player never out-levels a skilled one.
 */

export type ChestTier = 'silver' | 'golden' | 'magic' | 'legendary';

export interface ChestDef {
  tier: ChestTier;
  name: string;
  unlockMs: number;
  cards: number;
  /** Relative weight when a win rolls a chest. */
  weight: number;
  colors: [string, string];
}

/** What actually came out — the def plus the cards it minted, by ticker. */
export interface OpenedChest extends ChestDef {
  droppedTickers: string[];
  /** The seed these drops came from, so the reward screen can show it. */
  seed: string;
  source: 'chain';
}

export const CHESTS: Record<ChestTier, ChestDef> = {
  silver: {
    tier: 'silver', name: 'Silver Chest', unlockMs: 15 * 60_000,
    cards: 1, weight: 62, colors: ['#dfe8f5', '#8b9dbb'],
  },
  golden: {
    tier: 'golden', name: 'Golden Chest', unlockMs: 3 * 3_600_000,
    cards: 2, weight: 26, colors: ['#ffd766', '#c8890b'],
  },
  magic: {
    tier: 'magic', name: 'Magic Chest', unlockMs: 8 * 3_600_000,
    cards: 3, weight: 9, colors: ['#c77dff', '#6a2fb5'],
  },
  legendary: {
    tier: 'legendary', name: 'Legendary Chest', unlockMs: 12 * 3_600_000,
    cards: 4, weight: 3, colors: ['#7cf6d8', '#12a88a'],
  },
};

export const CHEST_SLOTS = 4;

/** Tier index → name, matching `TIER_WEIGHTS` in the program. */
export const TIER_ORDER: ChestTier[] = ['silver', 'golden', 'magic', 'legendary'];

/** Devnet demo pacing: minutes, not hours, so a judge sees the whole loop. */
import { IS_MAINNET } from '../chain/provider';

/**
 * Devnet demo pacing: an hour-long unlock plays out in a minute. On mainnet
 * the chest card states its real unlock time, so it must run at 1:1 — a
 * "12h legendary" that opens in 12 minutes would be the UI lying about the
 * scarcity the whole chest economy is priced on.
 */
export const DEMO_TIME_SCALE = IS_MAINNET ? 1 : 1 / 60;

export interface ChestSlot {
  id: string;
  tier: ChestTier;
  /** 0 = not started, else the timestamp it finishes unlocking. */
  readyAt: number;
  unlocking: boolean;
  /**
   * Where this chest's contents came from. Always `chain`: `MempireCards`
   * commits to a future block at `open` and `reveal` derives the drops from
   * that block's hash, so anyone can re-derive them from the seed below.
   */
  source: 'chain';
  /**
   * The 32 bytes this chest's contents are derived from, hex-encoded.
   *
   * Always present, whatever the provenance. A local seed is still a *recorded*
   * seed, which means the drop is a published function of something written down
   * rather than of an unrecorded `Math.random()` — the difference between "we
   * picked fairly, trust us" and "here is the input, check it yourself".
   *
   */
  seed: string;
}

/** Skipping the wait is the product. Price scales with time left. */
export function skipCost(remainingMs: number): number {
  const hours = remainingMs / 3_600_000;
  return Math.max(1, Math.ceil(hours * 18));
}
