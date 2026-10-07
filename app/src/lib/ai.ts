/**
 * Kimi at the bot's seat.
 *
 * The heuristic bot in `sim/bot.ts` decides every tick from rules. This module
 * hands the same seat to a model instead: every few seconds of game time it
 * summarises the board from the bot's side, asks the relay (`/api/ai/plan`,
 * which holds the Moonshot key — the browser never sees one), and turns the
 * answer into the exact `InputEvent` a card drop produces. The sim cannot tell
 * who played the card, which is the point: Kimi's choices are the opponent's
 * plays, held to the same elixir and hand rules as anyone's.
 *
 * The match must never wait on a model. While a plan is late, or the relay is
 * unreachable, the game's own classic bot plays the seat, and the HUD says
 * which brain made each move.
 */
import { create } from 'zustand';
import { apiFetch, hasApi } from './api';
import { ARCHETYPES } from '../sim/archetypes';
import { FP, fp, fpDist } from '../sim/fixed';
import { ARENA_H, ARENA_W, BRIDGE_X } from '../sim/engine';
import { ARCHETYPE_NAMES, Archetype, HAND_SIZE, INPUT_DELAY_TICKS } from '../sim/types';
import type { InputEvent, SimState, Unit } from '../sim/types';

export type AiBrain = 'classic' | 'kimi';
export type AiMode = 'kimi' | 'off';
type Lane = 'left' | 'right';
type Depth = 'back' | 'mid' | 'bridge';
type Zone = 'their_back' | 'their_bridge' | 'your_bridge' | 'your_back';

export type AiAction =
  | { type: 'deploy'; handIndex: number; lane: Lane; depth: Depth }
  | { type: 'wait' };

/** What `/api/ai/plan` answers. `fallback` is set when the relay's heuristic answered for Kimi. */
export interface AiPlan {
  mode: AiMode;
  model?: string;
  action: AiAction;
  reason: string;
  latencyMs: number;
  fallback?: string;
  cached?: boolean;
}

/** The last decision the HUD should show, from whichever brain made it. */
export interface AiLive {
  /** `relay` = Kimi answered through the relay; `local` = the classic bot covered a turn. */
  source: 'relay' | 'local';
  mode: AiMode | null;
  fallback?: string;
  reason: string;
  latencyMs?: number;
}

interface AiOpponentStore {
  /** The player's pick for bot matches. Persisted. */
  brain: AiBrain;
  /** The brain playing the current match — fixed at match start. */
  active: AiBrain;
  /** What the relay says it runs, once asked. */
  status: { mode: AiMode; model: string | null } | null;
  live: AiLive | null;
  setBrain: (b: AiBrain) => void;
}

const BRAIN_KEY = 'mempire.aiBrain';
function savedBrain(): AiBrain {
  try {
    return localStorage.getItem(BRAIN_KEY) === 'kimi' ? 'kimi' : 'classic';
  } catch {
    return 'classic';
  }
}

export const useAiOpponent = create<AiOpponentStore>((set) => ({
  brain: savedBrain(),
  active: 'classic',
  status: null,
  live: null,
  setBrain: (brain) => {
    try { localStorage.setItem(BRAIN_KEY, brain); } catch { /* private mode */ }
    set({ brain });
  },
}));

let statusAsked = false;
/** Asks the relay once per page which mode it runs, so labels are right before the first plan. */
export function loadAiStatus(): void {
  if (statusAsked || !hasApi()) return;
  statusAsked = true;
  void apiFetch('/api/ai/status').then(async (res) => {
    if (!res?.ok) { statusAsked = false; return; }
    const s = await res.json() as { mode: AiMode; model: string | null };
    useAiOpponent.setState({ status: { mode: s.mode, model: s.model } });
  }).catch(() => { statusAsked = false; });
}

/** Called by the bot flow when a match starts: fixes which brain this match is. */
export function startAiMatch(brain: AiBrain): void {
  useAiOpponent.setState({ active: brain, live: null });
  if (brain === 'kimi') loadAiStatus();
}

/** The HUD label: Kimi only when the relay actually runs Kimi. */
export function brainLabel(active: AiBrain, mode: AiMode | null | undefined): string {
  if (active === 'classic') return 'Classic bot';
  return mode === 'kimi' ? 'Kimi' : 'Kimi (not configured)';
}

/**
 * The brain a new match actually gets: Kimi only if the relay reports Kimi.
 * Without a Moonshot key the choice is the classic bot, never a stand-in.
 */
export function effectiveBrain(): AiBrain {
  const { brain, status } = useAiOpponent.getState();
  return brain === 'kimi' && status?.mode === 'kimi' ? 'kimi' : 'classic';
}

// ── The board, from a seat ───────────────────────────────────────────────────

const pct = (hp: number, max: number) => Math.max(0, Math.min(100, Math.round((hp / max) * 100)));
const laneOf = (x: number): 0 | 1 => (x < ARENA_W / 2 ? 0 : 1);
const LANE_NAMES: [Lane, Lane] = ['left', 'right'];
/** Distance from this seat's back edge: the one number that un-mirrors seat 1. */
const fromBack = (seat: 0 | 1, y: number) => (seat === 0 ? y : ARENA_H - y);

function zoneOf(seat: 0 | 1, y: number): Zone {
  const d = fromBack(seat, y);
  if (d < fp(8)) return 'your_back';
  if (d < fp(16)) return 'your_bridge';
  if (d < fp(24)) return 'their_bridge';
  return 'their_back';
}

function groups(sim: SimState, seat: 0 | 1, owner: 0 | 1) {
  const by = new Map<string, { lane: Lane; zone: Zone; archetype: string; count: number; hp: number; max: number }>();
  for (const u of sim.units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    const lane = LANE_NAMES[laneOf(u.x)];
    const zone = zoneOf(seat, u.y);
    const archetype = ARCHETYPE_NAMES[u.archetype];
    const k = `${lane}|${zone}|${archetype}`;
    const g = by.get(k) ?? { lane, zone, archetype, count: 0, hp: 0, max: 0 };
    g.count += 1; g.hp += u.hp; g.max += u.maxHp;
    by.set(k, g);
  }
  return [...by.values()].map(({ hp, max, ...g }) => ({ ...g, hpPct: pct(hp, max) }));
}

function metaOf(deck: SimState['players'][0]['deck']) {
  const seen = new Set<string>();
  return deck.flatMap((c) => {
    if (seen.has(c.name)) return [];
    seen.add(c.name);
    return [{ ticker: c.name, archetype: ARCHETYPE_NAMES[c.archetype], metaBps: c.metaBps ?? 0 }];
  });
}

/**
 * The compact board the relay prompts with, plus the deck indices the hand
 * held when it was taken. A plan names a *hand position*; the cycle rotates
 * on every play, so the position is resolved against this snapshot rather
 * than against whatever the hand is when the answer lands.
 */
export function summarize(sim: SimState, seat: 0 | 1) {
  const me = sim.players[seat];
  const them = sim.players[(1 - seat) as 0 | 1];
  const handDeck = me.cycle.slice(0, HAND_SIZE);
  const towers = (owner: 0 | 1) => {
    const [l, r, k] = sim.towers.slice(owner * 3, owner * 3 + 3);
    return { left: pct(l.hp, l.maxHp), right: pct(r.hp, r.maxHp), king: pct(k.hp, k.maxHp) };
  };
  const fmt = sim.format;
  const remaining = sim.phase === 'overtime'
    ? fmt.regulationTicks + fmt.overtimeTicks - sim.tick
    : fmt.regulationTicks - sim.tick;
  const state = {
    tick: sim.tick,
    secondsLeft: Math.max(0, Math.round(remaining / 20)),
    doubleElixir: sim.phase === 'overtime' || sim.tick >= fmt.doubleElixirAt,
    elixir: { you: Math.round((me.elixirFP / FP) * 10) / 10, them: Math.round((them.elixirFP / FP) * 10) / 10 },
    towers: { yours: towers(seat), theirs: towers((1 - seat) as 0 | 1) },
    hand: handDeck.map((di) => {
      const c = me.deck[di];
      return {
        ticker: c.name, archetype: ARCHETYPE_NAMES[c.archetype], level: c.level,
        metaBps: c.metaBps ?? 0, cost: ARCHETYPES[c.archetype].elixir,
      };
    }),
    enemyUnits: groups(sim, seat, (1 - seat) as 0 | 1),
    yourUnits: groups(sim, seat, seat),
    meta: { yours: metaOf(me.deck), theirs: metaOf(them.deck) },
  };
  return { state, handDeck };
}

// ── A plan, as an input ──────────────────────────────────────────────────────

/** Spawn depth for units, in tiles from the seat's back edge. Own half ends at 14.5. */
const DEPTH_TILES: Record<Depth, number> = { back: 4, mid: 10, bridge: 14.5 };

/** The biggest enemy group in a lane; their tower in that lane if it is empty. */
function spellTarget(sim: SimState, seat: 0 | 1, lane: 0 | 1): { x: number; y: number } {
  const enemies = sim.units.filter((u) => u.owner !== seat && u.hp > 0 && laneOf(u.x) === lane);
  let best: Unit[] = [];
  for (const c of enemies) {
    const near = enemies.filter((e) => fpDist(c.x, c.y, e.x, e.y) <= fp(2.5));
    if (near.length > best.length) best = near;
  }
  if (best.length) {
    let sx = 0; let sy = 0;
    for (const e of best) { sx += e.x; sy += e.y; }
    return { x: Math.floor(sx / best.length), y: Math.floor(sy / best.length) };
  }
  const base = (1 - seat) * 3;
  const tower = sim.towers[base + lane].hp > 0 ? sim.towers[base + lane] : sim.towers[base + 2];
  return { x: tower.x, y: tower.y };
}

type Resolved = { kind: 'play'; input: InputEvent } | { kind: 'wait' } | { kind: 'hold' } | { kind: 'drop' };

/**
 * Turns a plan into an input on the board as it is now. `hold` means the card
 * is still in hand but not yet affordable — the heuristic may have spent
 * elixir while the plan was in flight — so it is kept and retried next tick.
 */
export function resolvePlan(sim: SimState, seat: 0 | 1, plan: AiPlan, handDeck: number[]): Resolved {
  const a = plan.action;
  if (a.type === 'wait') return { kind: 'wait' };
  const deckIndex = handDeck[a.handIndex];
  const p = sim.players[seat];
  const at = deckIndex === undefined ? -1 : p.cycle.indexOf(deckIndex);
  if (at < 0 || at >= HAND_SIZE) return { kind: 'drop' };
  const card = p.deck[deckIndex];
  if (p.elixirFP < ARCHETYPES[card.archetype].elixir * FP) return { kind: 'hold' };
  const lane = a.lane === 'left' ? 0 : 1;
  const { x, y } = card.archetype === Archetype.Spell
    ? spellTarget(sim, seat, lane)
    : { x: BRIDGE_X[lane], y: seat === 0 ? fp(DEPTH_TILES[a.depth]) : ARENA_H - fp(DEPTH_TILES[a.depth]) };
  return { kind: 'play', input: { tick: sim.tick + INPUT_DELAY_TICKS, player: seat, deckIndex, x, y } };
}

// ── The pilot ────────────────────────────────────────────────────────────────

/** ~3.5 s of game time between questions. */
const ASK_EVERY_TICKS = 70;
/** A plan this many ticks late hands the turn to the heuristic until it lands. */
const LATE_AFTER_TICKS = 60;
/** A deploy still unaffordable after this long was planned for a board that is gone. */
const PLAN_MAX_AGE_TICKS = 240;
const FIRST_ASK_TICK = 10;

interface Pending { plan: AiPlan; handDeck: number[]; askedAt: number }

export class KimiPilot {
  private readonly seat: 0 | 1;
  private inflightSince: number | null = null;
  private ready: Pending | null = null;
  private held: Pending | null = null;
  private nextAsk = FIRST_ASK_TICK;
  /** The last request failed outright: the heuristic plays until one succeeds. */
  private offline = !hasApi();
  private disposed = false;

  constructor(seat: 0 | 1) {
    this.seat = seat;
  }

  dispose(): void { this.disposed = true; }

  /**
   * One tick at the seat. Returns the input to schedule, or null. `heuristic`
   * is the classic bot's decision for this tick, consulted only when Kimi has
   * nothing to say in time.
   */
  decide(sim: SimState, heuristic: () => InputEvent | null): InputEvent | null {
    if (sim.phase === 'ended') return null;
    // Asked on a cadence, one question at a time. An offline relay is still
    // asked on the same cadence: it may come back, and the heuristic covers
    // the seat until it does.
    if (this.inflightSince === null && sim.tick >= this.nextAsk && hasApi()) this.ask(sim);

    if (this.ready) { this.held = this.ready; this.ready = null; }
    if (this.held) {
      const r = resolvePlan(sim, this.seat, this.held.plan, this.held.handDeck);
      if (r.kind === 'hold') {
        if (sim.tick - this.held.askedAt > PLAN_MAX_AGE_TICKS) this.held = null;
        return null;
      }
      this.held = null;
      if (r.kind === 'play') return r.input;
      return null; // a wait is a decision too; a dropped plan waits for the next one
    }

    const late = this.inflightSince !== null && sim.tick - this.inflightSince > LATE_AFTER_TICKS;
    if (!this.offline && !late) return null;
    const ev = heuristic();
    if (ev) {
      const live = useAiOpponent.getState().live;
      useAiOpponent.setState({
        live: {
          source: 'local',
          mode: live?.mode ?? null,
          fallback: this.offline ? 'offline' : 'late',
          reason: this.offline ? 'relay unreachable, classic bot covering' : 'plan late, classic bot covering',
        },
      });
    }
    return ev;
  }

  private ask(sim: SimState): void {
    const { state, handDeck } = summarize(sim, this.seat);
    const askedAt = sim.tick;
    this.inflightSince = askedAt;
    this.nextAsk = askedAt + ASK_EVERY_TICKS;
    void apiFetch('/api/ai/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(15_000),
    }).then(async (res) => {
      if (!res?.ok) throw new Error(`plan ${res?.status ?? 'unreachable'}`);
      const plan = await res.json() as AiPlan;
      if (this.disposed) return;
      this.offline = false;
      this.ready = { plan, handDeck, askedAt };
      useAiOpponent.setState({
        live: {
          source: 'relay', mode: plan.mode, fallback: plan.fallback, reason: plan.reason, latencyMs: plan.latencyMs,
        },
      });
    }).catch(() => {
      if (!this.disposed) this.offline = true;
    }).finally(() => {
      if (!this.disposed) this.inflightSince = null;
    });
  }
}

// ── Commentary ───────────────────────────────────────────────────────────────

export type CommentaryEvent = {
  kind: 'tower_down' | 'spell' | 'elixir_lead' | 'buffed' | 'nerfed' | 'swarm' | 'double_elixir' | 'overtime' | 'kickoff';
  side: 'you' | 'ai';
  ticker?: string;
  lane?: Lane;
  amount?: number;
  bps?: number;
};

export async function requestCommentary(
  events: CommentaryEvent[], aiName: string,
): Promise<{ mode: AiMode; line: string; fallback?: string } | null> {
  const res = await apiFetch('/api/ai/commentary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events, aiName }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res?.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export { LANE_NAMES, laneOf };
