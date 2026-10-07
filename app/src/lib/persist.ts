/**
 * Player-state sync. Writes are debounced and fire-and-forget: the game must
 * stay fully playable when the API is down, so every failure degrades to
 * local-only rather than surfacing an error mid-match.
 */
import type { MintedCard } from '../state/collection';
import type { ChestSlot } from '../state/economy';
import type { MatchResult } from '../state/match';
import type { ShopOffer } from '../state/shop';
import { apiFetch, apiPost } from './api';

const SAVE_DEBOUNCE_MS = 900;

export interface SavedState {
  cards: MintedCard[];
  deck: string[];
  tier: number;
  /** Retired: balances are read from chain. Old saves may still carry it. */
  sol?: number;
  nextId: number;
  history: MatchResult[];
  /** Saved loadouts + which one is selected. Older saves lack these. */
  slots?: string[][];
  slot?: number;
  /** Premium economy — gems, chest rail (absolute timestamps), spend ledger. */
  gems?: number;
  chests?: ChestSlot[];
  nextChestId?: number;
  gemsSpent?: number;
  monSpentOnGems?: number;
  /** The day's shop, so bought flags and rerolls survive a reload. */
  shop?: { offers: ShopOffer[]; day: number; rerollsUsed: number };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let online = true;

export const isOnline = (): boolean => online;

export async function loadPlayer(address: string): Promise<SavedState | null> {
  try {
    const res = await apiFetch(`/api/player/${address}`);
    if (!res?.ok) throw new Error(res ? String(res.status) : 'no backend');
    online = true;
    return (await res.json()) as SavedState | null;
  } catch {
    online = false;
    return null;
  }
}

export function savePlayer(address: string, state: SavedState): void {
  if (!address) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void apiPost(`/api/player/${address}`, 'player.put', state as unknown as Record<string, unknown>, 'PUT')
      .then((r) => { online = r?.ok ?? false; })
      .catch(() => { online = false; });
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Records a settled match for the leaderboard. Never blocks the result screen.
 *
 * Retried while the relay says `pending`, because the report and the money it
 * describes do not arrive together. A client posts the instant its match ends;
 * settlement is a separate transaction sent after both seats agree, so the
 * chain read the relay does to verify the pot routinely finds nothing yet. The
 * relay counts the win immediately and keeps the money owed — this is the half
 * that comes back for it. Without it the one column that is chain-verified is
 * the one column that stays zero.
 */
export function recordMatch(address: string, result: MatchResult, attempt = 0): void {
  if (!address) return;
  // The relay's fields are currency-neutral (`pot`, `payout`, `rake`, plus
  // `currency`); the result object still carries the old names internally.
  const body = {
    ...result,
    pot: result.potSol, payout: result.payoutSol, rake: result.rakeSol,
    currency: result.currency ?? 'MON',
  } as unknown as Record<string, unknown>;
  void apiPost(`/api/match/${address}`, 'match.post', body)
    .then(async (r) => {
      if (!r?.ok) { online = false; return; }
      const body = await r.json().catch(() => null);
      // Six tries over roughly five minutes, which comfortably outlasts a
      // settlement that is merely slow. A match that never settles stops
      // asking rather than retrying forever.
      if (body?.pending === true && attempt < 5) {
        setTimeout(
          () => recordMatch(address, result, attempt + 1),
          15_000 * (attempt + 1),
        );
      }
    })
    .catch(() => { online = false; });
}

export interface LeaderRow {
  address: string;
  netSol?: number;
  netMon?: number;
  netAusd?: number;
  wins: number;
  losses: number;
  crowns: number;
  matches: number;
}

export async function loadLeaderboard(): Promise<LeaderRow[]> {
  try {
    const res = await apiFetch(`/api/leaderboard`);
    if (!res?.ok) throw new Error(res ? String(res.status) : 'no backend');
    return (await res.json()) as LeaderRow[];
  } catch {
    return [];
  }
}
