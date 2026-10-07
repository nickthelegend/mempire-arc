/*
 * The Envio indexer, read over GraphQL.
 *
 * Everything that needs history comes from here: who has won the most, the
 * last fifty card plays across every match on Monad, which fighters win when
 * the market has buffed them. None of it moves value — the game's money paths
 * read the contracts directly — so an indexer that is down costs the views
 * below, never a match.
 */

const URL = (import.meta.env.VITE_INDEXER_URL as string | undefined)?.trim() || null;

export const hasIndexer = (): boolean => URL !== null;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  if (!URL) return null;
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return null;
    const body = await res.json() as { data?: T; errors?: unknown };
    return body.data ?? null;
  } catch {
    return null;
  }
}

export interface PlayRow {
  id: string;
  match_id: string;
  seat: number;
  player_id: string;
  tick: number;
  blockNumber: string;
  timestamp: string;
  txHash: string;
  coin: { ticker: string; archetypeName: string; currentModifierBps: number } | null;
  card: { id: string; level: number } | null;
}

export async function latestPlays(limit = 30): Promise<PlayRow[]> {
  const d = await gql<{ Play: PlayRow[] }>(`query LatestPlays($limit: Int!) {
    Play(order_by: [{ blockNumber: desc }, { logIndex: desc }], limit: $limit) {
      id match_id seat player_id tick blockNumber timestamp txHash
      coin { ticker archetypeName currentModifierBps }
      card { id level }
    }
  }`, { limit });
  return d?.Play ?? [];
}

export interface LeaderRowIdx {
  id: string;
  wins: number;
  losses: number;
  ties: number;
  matches: number;
  netMon: string;
  netAusd: string;
  highestLevel: number;
}

export async function leaderboard(limit = 10): Promise<LeaderRowIdx[]> {
  const d = await gql<{ Player: LeaderRowIdx[] }>(`query Leaders($limit: Int!) {
    Player(where: { matches: { _gt: 0 } }, order_by: [{ wins: desc }, { netAusd: desc }], limit: $limit) {
      id wins losses ties matches netMon netAusd highestLevel
    }
  }`, { limit });
  return d?.Player ?? [];
}

export interface CoinStat {
  id: string;
  ticker: string;
  fielded: number;
  wins: number;
  losses: number;
  winRateBps: number;
  currentModifierBps: number;
  winsBuffed: number;
  lossesBuffed: number;
  winsNerfed: number;
  lossesNerfed: number;
}

export async function coinWinRates(): Promise<CoinStat[]> {
  const d = await gql<{ Coin: CoinStat[] }>(`query CoinWinRates {
    Coin(where: { registered: { _eq: true } }, order_by: [{ winRateBps: desc }, { fielded: desc }]) {
      id ticker fielded wins losses winRateBps currentModifierBps winsBuffed lossesBuffed winsNerfed lossesNerfed
    }
  }`);
  return d?.Coin ?? [];
}

export interface Totals {
  players: number;
  matches: number;
  matchesSettled: number;
  plays: number;
  cardsMinted: number;
  merges: number;
  volumeMon: string;
  volumeAusd: string;
  currentEpoch: string;
}

export async function totals(): Promise<Totals | null> {
  const d = await gql<{ Totals_by_pk: Totals | null }>(`query Overview {
    Totals_by_pk(id: "global") { players matches matchesSettled plays cardsMinted merges volumeMon volumeAusd currentEpoch }
  }`);
  return d?.Totals_by_pk ?? null;
}
