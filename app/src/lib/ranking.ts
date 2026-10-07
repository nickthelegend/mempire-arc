/**
 * The trophy ladder.
 *
 * Pure functions — no store, no network — so the same math can run on the client
 * for an optimistic display and on the server as the authority. If these two ever
 * disagree the ladder is meaningless, so there is exactly one implementation and
 * the server imports the same rules.
 *
 * Trophies are **rating**, crowns are **performance**. A crown is earned per
 * tower felled inside one match; trophies persist across matches and decide who
 * you are matched against. Clash Royale runs both for the same reason: one tells
 * you how a match went, the other tells you how good you are.
 */

/** Elo K-factor. 32 is the chess default and moves ~30 trophies a match here. */
const K = 32;

/** Elo's scale constant: a 400-point gap means the favourite wins ~91% of the time. */
const ELO_SCALE = 400;

export const STARTING_TROPHIES = 0;

export interface League {
  name: string;
  /** Trophies needed to enter. */
  at: number;
  /**
   * Trophies you cannot fall below once this league is reached.
   *
   * A floor is what makes a ladder feel like progress instead of a treadmill —
   * without it a bad night erases a month. It also kills trophy-tanking, because
   * you cannot drop into a weaker bracket to farm it.
   */
  floor: number;
  /** Hue for the league badge; the crest is drawn, not an asset. */
  hue: number;
}

/**
 * Seven leagues. Names carry the degen seasoning PRODUCT.md calls for — this is
 * a "moment", not a control, so flavour belongs here.
 */
export const LEAGUES: League[] = [
  { name: 'Paper Hands', at: 0, floor: 0, hue: 210 },
  { name: 'Bag Holder', at: 400, floor: 400, hue: 30 },
  { name: 'Diamond Hands', at: 900, floor: 900, hue: 190 },
  { name: 'Whale Watcher', at: 1500, floor: 1500, hue: 265 },
  { name: 'Degen Duke', at: 2200, floor: 2200, hue: 320 },
  { name: 'Meme Lord', at: 3000, floor: 3000, hue: 45 },
  { name: 'Mempire', at: 4000, floor: 4000, hue: 0 },
];

export function leagueFor(trophies: number): League {
  const t = Math.max(0, Math.floor(trophies || 0));
  let found = LEAGUES[0];
  for (const l of LEAGUES) if (t >= l.at) found = l;
  return found;
}

/** The next league up, or null at the top. */
export function nextLeague(trophies: number): League | null {
  const t = Math.max(0, Math.floor(trophies || 0));
  return LEAGUES.find((l) => l.at > t) ?? null;
}

/** 0–1 progress through the current league, for a progress bar. */
export function leagueProgress(trophies: number): number {
  const t = Math.max(0, Math.floor(trophies || 0));
  const cur = leagueFor(t);
  const next = nextLeague(t);
  if (!next) return 1;
  const span = next.at - cur.at;
  return span <= 0 ? 1 : Math.min(1, Math.max(0, (t - cur.at) / span));
}

/** Probability the player rated `mine` beats the player rated `theirs`. */
export function expectedScore(mine: number, theirs: number): number {
  return 1 / (1 + 10 ** ((theirs - mine) / ELO_SCALE));
}

export type Outcome = 'win' | 'loss' | 'draw';

export interface TrophyChange {
  delta: number;
  /** Trophies after the change, with the league floor already applied. */
  after: number;
  /** True when the floor absorbed part of a loss — surfaced, never hidden. */
  floored: boolean;
  leagueBefore: League;
  leagueAfter: League;
  promoted: boolean;
  demoted: boolean;
}

/**
 * What one ranked match does to a rating.
 *
 * Elo, so beating someone above you pays more than beating someone below, and
 * losing to a stronger player costs less. That is the property that makes a
 * ladder worth climbing rather than grinding: volume alone does not move you.
 */
export function applyMatch(
  mine: number, theirs: number, outcome: Outcome,
): TrophyChange {
  const before = Math.max(0, Math.floor(mine || 0));
  const opp = Math.max(0, Math.floor(theirs || 0));
  const score = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;

  const raw = Math.round(K * (score - expectedScore(before, opp)));
  // A win always pays at least 1 and a loss always costs at least 1, or a heavy
  // favourite would grind wins for zero and the ladder would stall.
  const delta = outcome === 'draw' ? raw
    : outcome === 'win' ? Math.max(1, raw)
      : Math.min(-1, raw);

  const leagueBefore = leagueFor(before);
  const uncapped = before + delta;
  const after = Math.max(leagueBefore.floor, uncapped);
  const leagueAfter = leagueFor(after);

  return {
    delta,
    after,
    floored: uncapped < leagueBefore.floor,
    leagueBefore,
    leagueAfter,
    promoted: leagueAfter.at > leagueBefore.at,
    demoted: leagueAfter.at < leagueBefore.at,
  };
}

/**
 * Matchmaking band: how far apart two ratings may be.
 *
 * Widens the longer someone waits, because a perfect match nobody ever gets is
 * worse than a slightly uneven one they get in twenty seconds. Uncapped after a
 * minute so the queue always drains — an empty ladder is the real failure.
 */
export function ratingBand(waitedMs: number): number {
  if (waitedMs >= 60_000) return Number.POSITIVE_INFINITY;
  return 200 + Math.floor(waitedMs / 1000) * 25;
}

export function withinBand(a: number, b: number, waitedMs: number): boolean {
  return Math.abs(a - b) <= ratingBand(waitedMs);
}
