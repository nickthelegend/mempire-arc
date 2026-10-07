import { create } from 'zustand';
import { apiFetch, apiPost } from '../lib/api';
import {
  LEAGUES, STARTING_TROPHIES, applyMatch, leagueFor, leagueProgress, nextLeague,
  type League, type Outcome, type TrophyChange,
} from '../lib/ranking';

/**
 * The trophy ladder.
 *
 * Trophies are the persistent rating; crowns are per-match performance. Only
 * **ranked** matches move trophies — practice cannot, because a ladder you can
 * farm against a bot is not a ladder.
 *
 * The client computes optimistically so the result screen can show the change
 * immediately, then the server reconciles. On disagreement the server wins: it
 * is the only party that sees both sides of a match.
 */


export interface LadderRow {
  address: string;
  name: string | null;
  trophies: number;
  best: number;
  wins: number;
  losses: number;
  streak: number;
}

interface LadderState {
  trophies: number;
  /** Highest ever reached — what Monthly Cup qualification reads. */
  best: number;
  wins: number;
  losses: number;
  /** Consecutive ranked wins. Drives the Rush streak multiplier. */
  streak: number;
  /** The most recent ranked change, for the result screen. Cleared on dismiss. */
  lastChange: TrophyChange | null;
  top: LadderRow[];
  rank: number | null;
  loading: boolean;

  load: (address: string) => Promise<void>;
  loadTop: () => Promise<void>;
  /** Applies a ranked result locally, then reconciles with the server. */
  record: (address: string, opponentTrophies: number, outcome: Outcome, pairKey?: string) => TrophyChange;
  clearChange: () => void;
  reset: () => void;

  league: () => League;
  next: () => League | null;
  progress: () => number;
}

export const useLadder = create<LadderState>((set, get) => ({
  trophies: STARTING_TROPHIES,
  best: STARTING_TROPHIES,
  wins: 0,
  losses: 0,
  streak: 0,
  lastChange: null,
  top: [],
  rank: null,
  loading: false,

  load: async (address) => {
    if (!address) return;
    set({ loading: true });
    try {
      const res = await apiFetch(`/api/ladder/${address}`);
      if (!res?.ok) throw new Error(res ? String(res.status) : 'no backend');
      const d = await res.json();
      set({
        trophies: Number(d?.trophies) || 0,
        best: Number(d?.best) || 0,
        wins: Number(d?.wins) || 0,
        losses: Number(d?.losses) || 0,
        streak: Number(d?.streak) || 0,
        rank: d?.rank ?? null,
        loading: false,
      });
    } catch {
      // No ladder service is not a reason to block play — start from local zero.
      set({ loading: false });
    }
  },

  loadTop: async () => {
    try {
      const res = await apiFetch(`/api/ladder`);
      if (!res?.ok) return;
      const d = await res.json();
      set({ top: Array.isArray(d?.players) ? d.players : [] });
    } catch { /* leaderboard is decoration when offline */ }
  },

  record: (address, opponentTrophies, outcome, pairKey) => {
    const change = applyMatch(get().trophies, opponentTrophies, outcome);
    set((s) => ({
      trophies: change.after,
      best: Math.max(s.best, change.after),
      wins: s.wins + (outcome === 'win' ? 1 : 0),
      losses: s.losses + (outcome === 'loss' ? 1 : 0),
      // A draw preserves a streak without extending it — it was not a loss.
      streak: outcome === 'win' ? s.streak + 1 : outcome === 'loss' ? 0 : s.streak,
      lastChange: change,
    }));

    // Fire-and-forget: the result screen must never wait on the ladder service.
    if (address) {
      // Signed: the server rejects an unsigned ladder update, and rightly —
      // an unauthenticated one let anyone set anyone's rating.
      // `opponentTrophies` is still sent for older relays; the current one
      // reads it from its own pairing record and ignores the body's copy.
      void apiPost(`/api/ladder/${address}`, 'ladder.post', { opponentTrophies, outcome, pairKey })
        .then((r) => (r?.ok ? r.json() : null))
        .then((d) => {
          // The server sees both sides, so it is the authority. Reconcile quietly.
          if (d && typeof d.trophies === 'number') {
            set({
              trophies: d.trophies,
              best: Number(d.best) || d.trophies,
              wins: Number(d.wins) || 0,
              losses: Number(d.losses) || 0,
              streak: Number(d.streak) || 0,
              rank: d.rank ?? null,
            });
          }
        })
        .catch(() => { /* local value stands until the next load */ });
    }
    return change;
  },

  clearChange: () => set({ lastChange: null }),
  reset: () => set({
    trophies: STARTING_TROPHIES, best: STARTING_TROPHIES,
    wins: 0, losses: 0, streak: 0, lastChange: null, rank: null,
  }),

  league: () => leagueFor(get().trophies),
  next: () => nextLeague(get().trophies),
  progress: () => leagueProgress(get().trophies),
}));

export { LEAGUES };
export type { League, TrophyChange, Outcome };
