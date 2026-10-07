// Shared helpers for the Mempire handlers: event metadata, lazy entity
// creation with zeroed counters, and the daily / global aggregates.
import type { Coin, DailyStats, EvmOnEventContext, Player, Totals } from "envio";
import { ROSTER } from "../roster.generated.js";

export type Ctx = EvmOnEventContext;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ARCHETYPE_NAMES = ["Tank", "Swarm", "Ranged", "Splash", "Support", "Spell"] as const;
export const CARD_SOURCES = ["Mint", "MintMempire", "Starter", "Chest"] as const;
export const CHEST_TIERS = ["Silver", "Golden", "Magic", "Legendary"] as const;

/** Arena seat / claim encoding. */
export const SEAT0 = 0;
export const SEAT1 = 1;
export const TIE = 2;

export interface Meta {
  ts: number;
  block: number;
  logIndex: number;
  tx: string;
}

export function meta(event: {
  block: { number: number; timestamp: number };
  transaction: { hash: string };
  logIndex: number;
}): Meta {
  return {
    ts: Number(event.block.timestamp),
    block: event.block.number,
    logIndex: event.logIndex,
    tx: event.transaction.hash.toLowerCase(),
  };
}

export const addr = (a: string): string => a.toLowerCase();
export const logId = (m: Meta): string => `${m.tx}-${m.logIndex}`;
export const isZero = (a: string): boolean => addr(a) === ZERO_ADDRESS;
export const maxInt = (a: number, b: number): number => (a > b ? a : b);

export type CurrencyName = "MON" | "AUSD";
/** The arena only accepts native MON (address 0) or AUSD as a stake currency. */
export const currencyOf = (currency: string): CurrencyName => (isZero(currency) ? "MON" : "AUSD");

export function dayKey(ts: number): { id: string; dayStart: number } {
  const dayStart = Math.floor(ts / 86_400) * 86_400;
  return { id: new Date(dayStart * 1000).toISOString().slice(0, 10), dayStart };
}

export function chestTier(tier: bigint | number) {
  return CHEST_TIERS[Number(tier)] ?? "Silver";
}

// ───────────────────────────────────────────────────────────── generic upsert

interface Store<E> {
  get: (id: string) => Promise<E | undefined>;
  set: (entity: E) => void;
}
/** The row type of a context store, e.g. Row<typeof context.Match> = Match. */
type Row<S> = S extends Store<infer E> ? E : never;

/** Load (or create from `init`), apply `fn`, write back. Returns the new row. */
export async function upsert<S extends Store<any>>(
  store: S,
  id: string,
  init: () => Row<S>,
  fn: (e: Row<S>) => Row<S>,
): Promise<Row<S>> {
  const current: Row<S> = (await store.get(id)) ?? init();
  const next = fn(current);
  store.set(next);
  return next;
}

/** Apply `fn` to an existing row; returns undefined (and writes nothing) if it is missing. */
export async function patch<S extends Store<any>>(
  store: S,
  id: string,
  fn: (e: Row<S>) => Row<S>,
): Promise<Row<S> | undefined> {
  const current: Row<S> | undefined = await store.get(id);
  if (current === undefined) return undefined;
  const next = fn(current);
  store.set(next);
  return next;
}

// ───────────────────────────────────────────────────────────── aggregates

const newTotals = (): Totals => ({
  id: "global",
  players: 0,
  coins: 0,
  matches: 0,
  matchesSettled: 0,
  matchesVoided: 0,
  plays: 0,
  cardsMinted: 0,
  cardsBurned: 0,
  merges: 0,
  chestsOpened: 0,
  volumeMon: 0n,
  volumeAusd: 0n,
  rakeMon: 0n,
  rakeAusd: 0n,
  currentEpoch: 0n,
});

/** The protocol-wide singleton row (id "global"). */
export const totals = (ctx: Ctx, fn: (g: Totals) => Totals) => upsert(ctx.Totals, "global", newTotals, fn);

export function daily(ctx: Ctx, ts: number, fn: (d: DailyStats) => DailyStats) {
  const { id, dayStart } = dayKey(ts);
  return upsert(
    ctx.DailyStats,
    id,
    (): DailyStats => ({
      id,
      dayStart,
      matchesCreated: 0,
      matchesStarted: 0,
      matchesSettled: 0,
      matchesVoided: 0,
      matchesCancelled: 0,
      ties: 0,
      volumeMon: 0n,
      volumeAusd: 0n,
      rakeMon: 0n,
      rakeAusd: 0n,
      plays: 0,
      checkpoints: 0,
      cardsMinted: 0,
      merges: 0,
      chestsGranted: 0,
      chestsOpened: 0,
      rewardsMempire: 0n,
      uniquePlayers: 0,
      newPlayers: 0,
    }),
    fn,
  );
}

// ───────────────────────────────────────────────────────────── players

function newPlayer(id: string, ts: number): Player {
  return {
    id,
    firstSeen: ts,
    lastActive: ts,
    matches: 0,
    matchesCreated: 0,
    matchesCancelled: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    voids: 0,
    winsByTimeout: 0,
    plays: 0,
    netMon: 0n,
    netAusd: 0n,
    wageredMon: 0n,
    wageredAusd: 0n,
    heldMon: 0n,
    heldAusd: 0n,
    cardsOwned: 0,
    cardsMinted: 0,
    highestLevel: 0,
    merges: 0,
    mergeSpent: 0n,
    chestsEarned: 0,
    chestsBought: 0,
    chestsForfeited: 0,
    chestsOpened: 0,
    rewardedWins: 0,
    rewardsMempire: 0n,
  };
}

/**
 * Update a player, creating it on first sight. `active` marks the player as
 * having acted in this event: it bumps lastActive and counts them once in the
 * day's unique players. Passive updates (receiving a card, the other seat of a
 * settlement) leave both alone.
 */
export async function updatePlayer(
  ctx: Ctx,
  address: string,
  m: Meta,
  fn: (p: Player) => Player,
  active = true,
): Promise<Player> {
  const id = addr(address);
  const existing = await ctx.Player.get(id);
  if (existing === undefined) {
    await totals(ctx, (g) => ({ ...g, players: g.players + 1 }));
    await daily(ctx, m.ts, (d) => ({ ...d, newPlayers: d.newPlayers + 1 }));
  }
  let next = fn(existing ?? newPlayer(id, m.ts));
  if (active) {
    next = { ...next, lastActive: maxInt(next.lastActive, m.ts) };
    const dayId = `${dayKey(m.ts).id}-${id}`;
    if ((await ctx.PlayerDay.get(dayId)) === undefined) {
      ctx.PlayerDay.set({ id: dayId });
      await daily(ctx, m.ts, (d) => ({ ...d, uniquePlayers: d.uniquePlayers + 1 }));
    }
  }
  ctx.Player.set(next);
  return next;
}

// ───────────────────────────────────────────────────────────── coins

export function rosterFor(coinId: number, feedId?: string) {
  const byFeed = feedId ? ROSTER.find((c) => c.feedId === feedId.toLowerCase()) : undefined;
  return byFeed ?? ROSTER.find((c) => c.coinId === coinId);
}

/** A coin row, from the chain once CoinRegistered has been seen, else from the roster. */
export function newCoin(coinId: number): Coin {
  const r = rosterFor(coinId);
  return {
    id: String(coinId),
    coinId,
    ticker: r?.ticker ?? `#${coinId}`,
    name: r?.name ?? `Coin ${coinId}`,
    kind: r?.kind ?? "unknown",
    feedId: r?.feedId ?? "",
    archetype: 0,
    archetypeName: ARCHETYPE_NAMES[0],
    registered: false,
    active: false,
    cardsMinted: 0,
    cardsBurned: 0,
    liveSupply: 0,
    maxLevel: 0,
    merges: 0,
    deckAppearances: 0,
    fielded: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    winRateBps: 0,
    timesPlayed: 0,
    winsBuffed: 0,
    lossesBuffed: 0,
    winsNerfed: 0,
    lossesNerfed: 0,
    currentModifierBps: 0,
    modifierEpoch: 0n,
  };
}

export const updateCoin = (ctx: Ctx, coinId: string | number, fn: (c: Coin) => Coin) =>
  upsert(ctx.Coin, String(coinId), () => newCoin(Number(coinId)), fn);

export const winRateBps = (wins: number, losses: number): number =>
  wins + losses === 0 ? 0 : Math.floor((wins * 10_000) / (wins + losses));
