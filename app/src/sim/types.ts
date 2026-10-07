import type { Trait } from './traits';
export const TICKS_PER_SEC = 20;
export const REGULATION_TICKS = 180 * TICKS_PER_SEC; // 3 min
export const OVERTIME_TICKS = 60 * TICKS_PER_SEC; // +60 s
export const DOUBLE_ELIXIR_AT = 120 * TICKS_PER_SEC; // final 60 s of regulation

/**
 * Per-format timing and economy.
 *
 * Carried on the sim state rather than read from module constants, because Rush
 * changes the length *and* the elixir curve — and both clients must agree on
 * every one of these values or the lockstep sim desyncs on tick one. Making the
 * format part of the state means it travels with the match instead of depending
 * on two clients having been built from the same constants.
 */
export interface Format {
  id: 'standard' | 'rush';
  regulationTicks: number;
  overtimeTicks: number;
  /** Tick at which elixir doubles. Set beyond the match length to disable. */
  doubleElixirAt: number;
  elixirPerTickFP: number;
  elixirCapFP: number;
  startElixirFP: number;
}

export const FORMATS: Record<Format['id'], Format> = {
  standard: {
    id: 'standard',
    regulationTicks: REGULATION_TICKS,
    overtimeTicks: OVERTIME_TICKS,
    doubleElixirAt: DOUBLE_ELIXIR_AT,
    elixirPerTickFP: Math.floor(1024 / (2.8 * TICKS_PER_SEC)),
    elixirCapFP: 10 * 1024,
    startElixirFP: 5 * 1024,
  },
  /**
   * Rush: 30 seconds, no overtime, most crowns wins.
   *
   * The elixir curve is the whole design problem. At the standard rate you earn
   * ~10 elixir in 30 seconds — two or three cards, which is a coin flip, not a
   * game. Rush starts you near full and regenerates ~3x faster, so a match is
   * roughly nine plays: fast enough to be a rush, long enough for skill to show.
   */
  rush: {
    id: 'rush',
    regulationTicks: 30 * TICKS_PER_SEC,
    overtimeTicks: 0,
    doubleElixirAt: Number.MAX_SAFE_INTEGER, // never — the whole match is fast
    elixirPerTickFP: Math.floor(1024 / (0.9 * TICKS_PER_SEC)),
    elixirCapFP: 10 * 1024,
    startElixirFP: 7 * 1024,
  },
};
export const INPUT_DELAY_TICKS = 2; // 100 ms lockstep buffer
export const HASH_EVERY_TICKS = 40;
export const HAND_SIZE = 4;
export const DECK_SIZE = 8;
export const ELIXIR_CAP_FP = 10 * 1024;
// 1 elixir per 2.8 s → per-tick fp gain (floor keeps it integer-exact)
export const ELIXIR_PER_TICK_FP = Math.floor(1024 / (2.8 * TICKS_PER_SEC));

// erasable-syntax-safe "enum"
export const Archetype = {
  Tank: 0, Swarm: 1, Ranged: 2, Splash: 3, Support: 4, Spell: 5,
} as const;
export type Archetype = (typeof Archetype)[keyof typeof Archetype];

export const ARCHETYPE_NAMES = ['Tank', 'Swarm', 'Ranged', 'Splash', 'Support', 'Spell'] as const;

/** A deck card as it enters a match: identity + level resolved from staked USD. */
export interface MatchCard {
  coinId: string; // the roster coin id
  name: string; // coin ticker, e.g. DOGGO
  archetype: Archetype; // hash(mint) % 6, global and permanent
  /**
   * Derived from the same mint, by the same discipline as `archetype`: global,
   * permanent, and identical for everyone holding that coin. Carried on the
   * card rather than recomputed per tick so the hot loop never hashes.
   */
  trait: Trait;
  level: number; // 1–10, earned by merging duplicates
  /**
   * The fighter's market modifier for this match, in basis points (±1500),
   * from MarketMeta at the match's epoch. Absent means 0. Both seats compute
   * it for both decks from the same epoch — it is never taken from the relay.
   */
  metaBps?: number;
}

export type UnitState = 'advance' | 'attack';

export interface Unit {
  id: number;
  owner: 0 | 1;
  archetype: Archetype;
  level: number;
  x: number; // fp tiles
  y: number;
  hp: number;
  maxHp: number;
  cooldown: number; // ticks until next hit
  targetUnit: number; // unit id or -1
  targetTower: number; // tower index or -1
  state: UnitState;
  /** Copied from the card that spawned it; drives its effective stats. */
  trait: Trait;
  cardIndex: number; // which deck slot spawned it (render: coin skin)
  /** Market modifier copied from its card (bps). Damage scales by it. */
  metaBps: number;
}

export type TowerKind = 'princess' | 'king';

export interface Tower {
  owner: 0 | 1;
  kind: TowerKind;
  lane: 0 | 1 | -1; // princess: 0 left, 1 right; king: -1
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  cooldown: number;
  awake: boolean; // king sleeps until damaged or a princess falls
}

export interface PendingSpell {
  owner: 0 | 1;
  x: number;
  y: number;
  explodeTick: number;
  level: number;
  cardIndex: number;
  metaBps: number;
}

export interface PlayerSim {
  elixirFP: number;
  deck: MatchCard[]; // 8, fixed order = deck slots
  cycle: number[]; // rotation of deck indices; first HAND_SIZE are the hand
}

export type Phase = 'regulation' | 'overtime' | 'ended';

export interface SimState {
  tick: number;
  phase: Phase;
  /** Timing + elixir rules for this match. Travels with the state, so both
      clients step identically even if one was built from older constants. */
  format: Format;
  winner: 0 | 1 | -1 | -2; // -1 undecided, -2 draw
  units: Unit[];
  towers: Tower[]; // 6: [p0 L, p0 R, p0 king, p1 L, p1 R, p1 king]
  spells: PendingSpell[];
  players: [PlayerSim, PlayerSim];
  nextUnitId: number;
  rngState: number;
}

/**
 * One committed player action. This exact shape goes into the ER input log.
 *
 * `deckIndex` (not the hand slot) is what travels: the cycle rotates on every
 * play, so a hand position resolved at execution time can select a different
 * card than the one the player dragged when two plays land inside the same
 * input-delay window.
 */
export interface InputEvent {
  tick: number; // tick it executes on (sender adds INPUT_DELAY_TICKS)
  player: 0 | 1;
  deckIndex: number; // 0..7 slot in the player's deck
  x: number; // fp tiles
  y: number;
}
