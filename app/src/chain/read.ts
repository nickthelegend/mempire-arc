import { erc20Abi, formatEther, formatUnits, type Abi, type Address } from 'viem';
import cardsAbi from '../shared/abi/MempireCards.json';
import arenaAbi from '../shared/abi/MempireArena.json';
import metaAbi from '../shared/abi/MarketMeta.json';
import { COINS } from '../lib/coins';
import { DEPLOYMENT, publicClient } from './provider';

/*
 * Everything the client reads from chain, in one place.
 *
 * Reads go straight to the contracts — `cardsOf`, `getMatch`, `chestsOf` all
 * return a whole answer in one call — so the game works with nothing but an
 * RPC. The Envio indexer powers the views that need history (leaderboards,
 * the live play feed); nothing that moves value depends on it.
 */

export const CARDS_ABI = cardsAbi as Abi;
export const ARENA_ABI = arenaAbi as Abi;
export const META_ABI = metaAbi as Abi;

export interface ChainConfig {
  address: string;
  treasury: string;
  mintFeeMon: number;
  rakePct: number;
  tieRakePct: number;
  matchTimeoutSecs: number;
  powerBand: number;
  nextCardId: number;
  nextMatchId: number;
  timeScale: number;
  metaEpoch: number;
}

export async function fetchConfig(): Promise<ChainConfig | null> {
  if (!DEPLOYMENT) return null;
  const c = publicClient();
  const d = DEPLOYMENT;
  const read = (address: Address, abi: Abi, functionName: string) =>
    c.readContract({ address, abi, functionName }) as Promise<unknown>;
  const [treasury, mintFee, rake, tieRake, timeout, band, nextCard, nextMatch, timeScale, epoch] = await Promise.all([
    read(d.arena, ARENA_ABI, 'treasury'),
    read(d.cards, CARDS_ABI, 'mintFee'),
    read(d.arena, ARENA_ABI, 'rakeBps'),
    read(d.arena, ARENA_ABI, 'tieRakeBps'),
    read(d.arena, ARENA_ABI, 'matchTimeout'),
    read(d.arena, ARENA_ABI, 'powerBand'),
    read(d.cards, CARDS_ABI, 'nextCardId'),
    read(d.arena, ARENA_ABI, 'nextMatchId'),
    read(d.cards, CARDS_ABI, 'timeScale'),
    read(d.marketMeta, META_ABI, 'currentEpoch'),
  ]);
  return {
    address: d.arena,
    treasury: treasury as string,
    mintFeeMon: Number(formatEther(mintFee as bigint)),
    rakePct: Number(rake) / 100,
    tieRakePct: Number(tieRake) / 100,
    matchTimeoutSecs: Number(timeout),
    powerBand: Number(band),
    nextCardId: Number(nextCard),
    nextMatchId: Number(nextMatch),
    timeScale: Number(timeScale),
    metaEpoch: Number(epoch),
  };
}

export interface ChainCoin {
  coinId: number;
  mint: string;
  archetype: number;
  active: boolean;
  ticker: string;
}

export async function fetchRegisteredCoins(): Promise<ChainCoin[]> {
  if (!DEPLOYMENT) return [];
  const rows = await publicClient().readContract({
    address: DEPLOYMENT.cards, abi: CARDS_ABI, functionName: 'roster',
  }) as { feedId: string; archetype: number; active: boolean; ticker: string }[];
  return rows.map((r, i) => ({
    coinId: i, mint: r.feedId.toLowerCase(), archetype: Number(r.archetype), active: r.active, ticker: r.ticker,
  }));
}

export interface ChainCard {
  id: number;
  owner: string;
  coinId: number;
  /** The fighter's identity (feed id) — `mint` for the rest of the client. */
  mint: string;
  archetype: number;
  level: number;
  inMatch: boolean;
  /** Match id holding it, as a string, or null. */
  lockedBy: string | null;
  mintPriceUsd: number | null;
}

export async function fetchCardsFor(owner: string): Promise<ChainCard[]> {
  if (!DEPLOYMENT) return [];
  const [ids, data, locked] = await publicClient().readContract({
    address: DEPLOYMENT.cards, abi: CARDS_ABI, functionName: 'cardsOf', args: [owner as Address],
  }) as [bigint[], { coinId: number; level: number; archetype: number; lockedBy: bigint; mintPrice: bigint; mintExpo: number }[], boolean[]];
  return ids.map((id, i) => {
    const d = data[i];
    const coin = COINS[Number(d.coinId)];
    const price = d.mintPrice !== 0n ? Number(d.mintPrice) * 10 ** Number(d.mintExpo) : null;
    return {
      id: Number(id),
      owner,
      coinId: Number(d.coinId),
      mint: coin?.mint ?? `coin:${d.coinId}`,
      archetype: Number(d.archetype),
      level: Number(d.level),
      inMatch: locked[i],
      lockedBy: locked[i] ? String(d.lockedBy) : null,
      mintPriceUsd: price,
    };
  }).sort((a, b) => a.id - b.id);
}

export interface ChainMatch {
  address: string;
  id: number;
  tier: number;
  /** Stake in whole units of the match currency (MON or AUSD). */
  stake: number;
  stakeRaw: bigint;
  currency: 'MON' | 'AUSD';
  currencyAddress: Address;
  players: [string, string];
  sessions: [string, string];
  /** 0 none · 1 open · 2 active · 3 settled */
  state: number;
  createdAt: number;
  deadline: number;
  winner: number;
  claims: [number, number];
  decks: [string, string];
  powers: [number, number];
  metaEpoch: number;
  plays: [number, number];
}

export const MATCH_STATE_OPEN = 1;
export const MATCH_STATE_ACTIVE = 2;
export const MATCH_STATE_SETTLED = 3;
export const NO_CLAIM = 3;

const ZERO = '0x0000000000000000000000000000000000000000';

export async function fetchMatchById(id: number): Promise<ChainMatch | null> {
  if (!DEPLOYMENT) return null;
  const m = await publicClient().readContract({
    address: DEPLOYMENT.arena, abi: ARENA_ABI, functionName: 'getMatch', args: [BigInt(id)],
  }) as Record<string, unknown>;
  if (Number(m.state) === 0) return null;
  const currencyAddress = m.currency as Address;
  const isMon = currencyAddress.toLowerCase() === ZERO;
  const stakeRaw = BigInt(m.stake as bigint);
  return {
    address: `${DEPLOYMENT.arena}#${id}`,
    id,
    tier: Number(m.tier),
    stake: Number(isMon ? formatEther(stakeRaw) : formatUnits(stakeRaw, 6)),
    stakeRaw,
    currency: isMon ? 'MON' : 'AUSD',
    currencyAddress,
    players: [m.p0 as string, m.p1 as string],
    sessions: [m.s0 as string, m.s1 as string],
    state: Number(m.state),
    createdAt: Number(m.createdAt),
    deadline: Number(m.deadline),
    winner: Number(m.winner),
    claims: [Number(m.claim0), Number(m.claim1)],
    decks: [m.deck0 as string, m.deck1 as string],
    powers: [Number(m.power0), Number(m.power1)],
    metaEpoch: Number(m.metaEpoch),
    plays: [Number(m.plays0), Number(m.plays1)],
  };
}

/** `fetchMatch` took an account address on the old chain; here it takes `arena#id` or an id. */
export async function fetchMatch(ref: string | number): Promise<ChainMatch | null> {
  const id = typeof ref === 'number' ? ref : Number(String(ref).split('#').pop());
  return Number.isFinite(id) && id > 0 ? fetchMatchById(id) : null;
}
export const fetchMatchByAddress = fetchMatch;

export async function fetchSeed(id: number): Promise<number> {
  if (!DEPLOYMENT) return 0;
  return Number(await publicClient().readContract({
    address: DEPLOYMENT.arena, abi: ARENA_ABI, functionName: 'seedOf', args: [BigInt(id)],
  }));
}

/**
 * Recent matches, newest first, read by walking ids backwards.
 *
 * Bounded on purpose: this is the "what just happened" strip, not history.
 * History is the indexer's job.
 */
export async function fetchRecentMatches(limit = 24): Promise<ChainMatch[]> {
  if (!DEPLOYMENT) return [];
  const next = Number(await publicClient().readContract({
    address: DEPLOYMENT.arena, abi: ARENA_ABI, functionName: 'nextMatchId',
  }));
  const ids: number[] = [];
  for (let id = next - 1; id > 0 && ids.length < limit; id -= 1) ids.push(id);
  const all = await Promise.all(ids.map((id) => fetchMatchById(id).catch(() => null)));
  return all.filter((m): m is ChainMatch => m !== null);
}

export async function fetchOpenMatches(): Promise<ChainMatch[]> {
  return (await fetchRecentMatches(40)).filter((m) => m.state === MATCH_STATE_OPEN);
}

export async function fetchStrandedMatches(owner: string): Promise<ChainMatch[]> {
  const me = owner.toLowerCase();
  return (await fetchRecentMatches(60)).filter((m) => m.state !== MATCH_STATE_SETTLED
    && m.players.some((p) => p.toLowerCase() === me));
}

export async function fetchRecentSettlements(limit = 12): Promise<ChainMatch[]> {
  return (await fetchRecentMatches(limit * 3))
    .filter((m) => m.state === MATCH_STATE_SETTLED && m.winner <= 2)
    .slice(0, limit);
}

export async function fetchMonBalance(owner: string): Promise<number> {
  const wei = await publicClient().getBalance({ address: owner as Address });
  return Number(formatEther(wei));
}

/** $MEMPIRE and AUSD balances, keyed by token address (lowercase). */
export async function fetchTokenBalances(owner: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!DEPLOYMENT) return out;
  const c = publicClient();
  const [mem, ausd] = await Promise.all([
    c.readContract({ address: DEPLOYMENT.token, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Address] }),
    c.readContract({ address: DEPLOYMENT.ausd, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Address] })
      .catch(() => 0n),
  ]);
  out.set(DEPLOYMENT.token.toLowerCase(), Number(formatEther(mem)));
  out.set(DEPLOYMENT.ausd.toLowerCase(), Number(formatUnits(ausd as bigint, 6)));
  return out;
}

export interface ChainChest {
  id: number;
  tier: number;
  /** 1 idle · 2 unlocking · 3 revealing · 4 opened */
  state: number;
  readyAt: number;
  revealBlock: number;
}

export async function fetchChests(owner: string): Promise<ChainChest[]> {
  if (!DEPLOYMENT) return [];
  const [ids, data] = await publicClient().readContract({
    address: DEPLOYMENT.cards, abi: CARDS_ABI, functionName: 'chestsOf', args: [owner as Address],
  }) as [bigint[], { tier: number; state: number; readyAt: number; revealBlock: bigint }[]];
  return ids.map((id, i) => ({
    id: Number(id),
    tier: Number(data[i].tier),
    state: Number(data[i].state),
    readyAt: Number(data[i].readyAt),
    revealBlock: Number(data[i].revealBlock),
  })).sort((a, b) => a.id - b.id);
}

/** The current market epoch and every fighter's modifier in it. */
export async function fetchMarketMeta(): Promise<{ epoch: number; bps: Map<number, number> }> {
  const bps = new Map<number, number>();
  if (!DEPLOYMENT) return { epoch: 0, bps };
  const epoch = Number(await publicClient().readContract({
    address: DEPLOYMENT.marketMeta, abi: META_ABI, functionName: 'currentEpoch',
  }));
  if (epoch === 0) return { epoch, bps };
  return { epoch, bps: await fetchModifiers(epoch, COINS.map((c) => c.coinId)) };
}

/** The modifiers a specific match uses — its own epoch, not today's. */
export async function fetchModifiers(epoch: number, coinIds: number[]): Promise<Map<number, number>> {
  const bps = new Map<number, number>();
  if (!DEPLOYMENT || epoch === 0) return bps;
  const out = await publicClient().readContract({
    address: DEPLOYMENT.marketMeta, abi: META_ABI, functionName: 'modifiersFor',
    args: [BigInt(epoch), coinIds],
  }) as number[];
  coinIds.forEach((id, i) => bps.set(id, Number(out[i])));
  return bps;
}

export async function fetchStarterClaimed(owner: string): Promise<boolean> {
  if (!DEPLOYMENT) return false;
  return await publicClient().readContract({
    address: DEPLOYMENT.cards, abi: CARDS_ABI, functionName: 'starterClaimed', args: [owner as Address],
  }) as boolean;
}

/**
 * The cards a seat locked into a match, in deck order, resolved to fighter and
 * level.
 *
 * Read from the MatchCreated / MatchJoined event, which carries the card ids.
 * Public RPCs bound `eth_getLogs` ranges, so this walks back from the head in
 * small windows — the match being checked was opened seconds ago.
 */
export async function fetchDeckCards(matchId: number, seat: 0 | 1): Promise<ChainCard[] | null> {
  if (!DEPLOYMENT) return null;
  const client = publicClient();
  const eventName = seat === 0 ? 'MatchCreated' : 'MatchJoined';
  const event = (ARENA_ABI as unknown as { type: string; name: string }[])
    .find((e) => e.type === 'event' && e.name === eventName);
  if (!event) return null;
  const head = await client.getBlockNumber();
  const WINDOW = 99n;
  let ids: bigint[] | null = null;
  for (let i = 0n; i < 30n && !ids; i += 1n) {
    const toBlock = head - i * (WINDOW + 1n);
    const fromBlock = toBlock > WINDOW ? toBlock - WINDOW : 0n;
    if (toBlock < BigInt(DEPLOYMENT.startBlock ?? 0)) break;
    const logs = await client.getLogs({
      address: DEPLOYMENT.arena,
      event: event as never,
      args: { matchId: BigInt(matchId) } as never,
      fromBlock,
      toBlock,
    });
    const hit = logs[0] as unknown as { args?: { cardIds?: bigint[] } } | undefined;
    if (hit?.args?.cardIds) ids = hit.args.cardIds;
  }
  if (!ids) return null;
  const cards = await Promise.all(ids.map(async (id) => {
    const d = await client.readContract({
      address: DEPLOYMENT!.cards, abi: CARDS_ABI, functionName: 'card', args: [id],
    }) as { coinId: number; level: number; archetype: number };
    const coin = COINS[Number(d.coinId)];
    return {
      id: Number(id), owner: '', coinId: Number(d.coinId), mint: coin?.mint ?? '',
      archetype: Number(d.archetype), level: Number(d.level), inMatch: true,
      lockedBy: String(matchId), mintPriceUsd: null,
    } satisfies ChainCard;
  }));
  return cards;
}
