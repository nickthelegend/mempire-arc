/**
 * Trophy ladder math — the server's authoritative copy.
 *
 * Deliberately duplicated from `app/src/lib/ranking.ts` rather than imported:
 * the client is a Vite/TS bundle and this is plain ESM Node, and a build-time
 * dependency between them would couple two deploy targets for ~40 lines. The
 * contract is that these stay identical; the integration test asserts a shared
 * vector so a drift fails loudly instead of silently splitting the ladder.
 */
const K = 32;
const ELO_SCALE = 400;

export const LEAGUES = [
  { name: 'Paper Hands', at: 0, floor: 0 },
  { name: 'Bag Holder', at: 400, floor: 400 },
  { name: 'Diamond Hands', at: 900, floor: 900 },
  { name: 'Whale Watcher', at: 1500, floor: 1500 },
  { name: 'Degen Duke', at: 2200, floor: 2200 },
  { name: 'Meme Lord', at: 3000, floor: 3000 },
  { name: 'Mempire', at: 4000, floor: 4000 },
];

export function leagueFor(trophies) {
  const t = Math.max(0, Math.floor(trophies || 0));
  let found = LEAGUES[0];
  for (const l of LEAGUES) if (t >= l.at) found = l;
  return found;
}

export function expectedScore(mine, theirs) {
  return 1 / (1 + 10 ** ((theirs - mine) / ELO_SCALE));
}

/** Returns { delta, after, floored }. Mirrors applyMatch on the client. */
export function applyMatch(mine, theirs, outcome) {
  const before = Math.max(0, Math.floor(mine || 0));
  const opp = Math.max(0, Math.floor(theirs || 0));
  const score = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
  const raw = Math.round(K * (score - expectedScore(before, opp)));
  const delta = outcome === 'draw' ? raw
    : outcome === 'win' ? Math.max(1, raw)
      : Math.min(-1, raw);
  const floor = leagueFor(before).floor;
  const uncapped = before + delta;
  return { delta, after: Math.max(floor, uncapped), floored: uncapped < floor };
}
