import { FP, fp, fpDist, clampInt } from './fixed';
import { XorShift32 } from './rng';
import { Fnv1a } from './hash';
import {
  ARCHETYPES, AURA_SPEED_DEN, AURA_SPEED_NUM, scaleByLevel, scaleStat,
} from './archetypes';
import { effectiveDef, traitForMint } from './traits';
import {
  Archetype, DECK_SIZE, FORMATS, HAND_SIZE, type Format,
} from './types';
import type {
  InputEvent, MatchCard, PendingSpell, PlayerSim, SimState, Tower, Unit,
} from './types';

// ── Arena ────────────────────────────────────────────────────────────────────
export const ARENA_W = fp(18);
export const ARENA_H = fp(32);
export const RIVER_TOP = fp(15); // river band: y ∈ [15, 17] tiles
export const RIVER_BOT = fp(17);
export const RIVER_MID = fp(16);
export const BRIDGE_X: [number, number] = [fp(3.5), fp(14.5)];
export const BRIDGE_HALF_W = fp(0.9);
const UNIT_RADIUS = fp(0.35);
const TOWER_RADIUS: Record<string, number> = { princess: fp(1.0), king: fp(1.4) };

const PRINCESS = { hp: 1500, damage: 95, hitTicks: 16, rangeFP: fp(7.0) };
const KING = { hp: 2400, damage: 105, hitTicks: 20, rangeFP: fp(7.0) };
const SPELL_TOWER_DAMAGE_PCT = 40; // spells hit towers at reduced effect

// Deterministic spawn ring for multi-unit cards.
const SPAWN_OFFSETS = [
  [0, 0], [fp(0.6), 0], [-fp(0.6), 0], [0, fp(0.6)], [0, -fp(0.6)],
] as const;

// ── Setup ────────────────────────────────────────────────────────────────────
function towerLevel(deck: MatchCard[]): number {
  let sum = 0;
  for (const c of deck) sum += c.level;
  return clampInt(Math.floor(sum / deck.length), 1, 10);
}

function makeTowers(deckA: MatchCard[], deckB: MatchCard[]): Tower[] {
  const mk = (
    owner: 0 | 1, kind: 'princess' | 'king', lane: 0 | 1 | -1,
    x: number, y: number, lvl: number,
  ): Tower => {
    const base = kind === 'princess' ? PRINCESS : KING;
    const hp = scaleByLevel(base.hp, lvl);
    return {
      owner, kind, lane, x, y: y, hp, maxHp: hp, cooldown: 0, awake: kind === 'princess',
    };
  };
  const la = towerLevel(deckA);
  const lb = towerLevel(deckB);
  const mirror = (y: number) => ARENA_H - y;
  return [
    mk(0, 'princess', 0, BRIDGE_X[0], fp(6), la),
    mk(0, 'princess', 1, BRIDGE_X[1], fp(6), la),
    mk(0, 'king', -1, fp(9), fp(2.5), la),
    mk(1, 'princess', 0, BRIDGE_X[0], mirror(fp(6)), lb),
    mk(1, 'princess', 1, BRIDGE_X[1], mirror(fp(6)), lb),
    mk(1, 'king', -1, fp(9), mirror(fp(2.5)), lb),
  ];
}

function shuffledCycle(rng: XorShift32): number[] {
  const c = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = c.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const t = c[i]; c[i] = c[j]; c[j] = t;
  }
  return c;
}

export function createMatch(
  seed: number,
  decks: [MatchCard[], MatchCard[]],
  format: Format = FORMATS.standard,
): SimState {
  if (decks[0].length !== DECK_SIZE || decks[1].length !== DECK_SIZE) {
    throw new Error('decks must have exactly 8 cards');
  }
  // A trait is a pure function of the mint, so derive any that is missing here
  // rather than trusting eight call sites to remember. A card that reached a
  // spawn without one used to throw mid-match; worse, a caller that filled it
  // in differently would desync the two clients silently. Deriving it once, at
  // the only door into a match, removes both.
  const withTraits = (deck: MatchCard[]): MatchCard[] => deck.map((c) => (
    c.trait === undefined ? { ...c, trait: traitForMint(c.coinId) } : c
  ));
  const rng = new XorShift32(seed);
  const players: [PlayerSim, PlayerSim] = [
    { elixirFP: format.startElixirFP, deck: withTraits(decks[0]), cycle: shuffledCycle(rng) },
    { elixirFP: format.startElixirFP, deck: withTraits(decks[1]), cycle: shuffledCycle(rng) },
  ];
  return {
    tick: 0,
    format,
    phase: 'regulation',
    winner: -1,
    units: [],
    towers: makeTowers(decks[0], decks[1]),
    spells: [],
    players,
    nextUnitId: 1,
    rngState: rng.state(),
  };
}

// ── Input application ────────────────────────────────────────────────────────
function ownHalfClamp(player: 0 | 1, xIn: number, yIn: number): [number, number] {
  const x = clampInt(xIn, fp(0.5), ARENA_W - fp(0.5));
  const y = player === 0
    ? clampInt(yIn, fp(0.5), RIVER_TOP - fp(0.5))
    : clampInt(yIn, RIVER_BOT + fp(0.5), ARENA_H - fp(0.5));
  return [x, y];
}

function applyInput(state: SimState, ev: InputEvent): void {
  const p = state.players[ev.player];
  const deckIdx = ev.deckIndex;
  if (deckIdx < 0 || deckIdx >= DECK_SIZE) return;
  // the card must actually be in hand right now — stale inputs are dropped
  if (p.cycle.indexOf(deckIdx) >= HAND_SIZE) return;
  const card = p.deck[deckIdx];
  // Trait folded in once, at spawn. Everything downstream reads these numbers,
  // so a trait can never be applied twice or forgotten on one code path.
  const def = effectiveDef(ARCHETYPES[card.archetype], card.trait, card.archetype);
  const cost = def.elixir * FP;
  if (p.elixirFP < cost) return; // stale input: not enough elixir → drop
  const [x, y] = card.archetype === Archetype.Spell
    ? [clampInt(ev.x, fp(0.5), ARENA_W - fp(0.5)), clampInt(ev.y, fp(0.5), ARENA_H - fp(0.5))]
    : ownHalfClamp(ev.player, ev.x, ev.y);

  p.elixirFP -= cost;
  // cycle: played card goes to the back
  p.cycle.splice(p.cycle.indexOf(deckIdx), 1);
  p.cycle.push(deckIdx);

  if (card.archetype === Archetype.Spell) {
    state.spells.push({
      owner: ev.player, x, y,
      explodeTick: state.tick + def.spellDelayTicks,
      level: card.level, cardIndex: deckIdx, metaBps: card.metaBps ?? 0,
    });
    return;
  }
  for (let i = 0; i < def.count; i++) {
    const [ox, oy] = SPAWN_OFFSETS[i % SPAWN_OFFSETS.length];
    const hp = scaleStat(def.hp, card.level, card.metaBps ?? 0);
    state.units.push({
      id: state.nextUnitId++,
      owner: ev.player,
      archetype: card.archetype,
      level: card.level,
      x: clampInt(x + ox, fp(0.5), ARENA_W - fp(0.5)),
      y: clampInt(y + oy, fp(0.5), ARENA_H - fp(0.5)),
      hp, maxHp: hp,
      cooldown: 0,
      targetUnit: -1,
      targetTower: -1,
      state: 'advance',
      trait: card.trait,
      cardIndex: deckIdx,
      metaBps: card.metaBps ?? 0,
    });
  }
}

// Full deterministic input order within a tick.
export function sortInputs(inputs: InputEvent[]): InputEvent[] {
  return [...inputs].sort((a, b) =>
    a.player - b.player || a.deckIndex - b.deckIndex || a.x - b.x || a.y - b.y);
}

// ── Targeting & movement ─────────────────────────────────────────────────────
function nearestEnemyUnit(state: SimState, u: Unit, radius: number): number {
  let best = -1;
  let bestD = radius + 1;
  for (const e of state.units) {
    if (e.owner === u.owner || e.hp <= 0) continue;
    const d = fpDist(u.x, u.y, e.x, e.y);
    if (d < bestD || (d === bestD && best !== -1 && e.id < best)) {
      bestD = d;
      best = e.id;
    }
  }
  return best;
}

function towerAlive(state: SimState, idx: number): boolean {
  return state.towers[idx].hp > 0;
}

/** Lane princess first; fallback king; fallback nearest alive tower. */
function pickTargetTower(state: SimState, u: Unit): number {
  const enemyBase = u.owner === 0 ? 3 : 0;
  const lane = u.x < fp(9) ? 0 : 1;
  const princessIdx = enemyBase + lane;
  if (towerAlive(state, princessIdx)) return princessIdx;
  const kingIdx = enemyBase + 2;
  if (towerAlive(state, kingIdx)) return kingIdx;
  const otherPrincess = enemyBase + (1 - lane);
  return towerAlive(state, otherPrincess) ? otherPrincess : kingIdx;
}

function needsBridge(u: Unit, targetY: number): boolean {
  return u.owner === 0 ? u.y < RIVER_TOP && targetY > RIVER_TOP
    : u.y > RIVER_BOT && targetY < RIVER_BOT;
}

function moveToward(u: Unit, txIn: number, tyIn: number, speed: number): void {
  let tx = txIn;
  let ty = tyIn;
  if (needsBridge(u, tyIn)) {
    const lane = u.x < fp(9) ? 0 : 1;
    tx = BRIDGE_X[lane];
    ty = RIVER_MID;
  }
  // inside the river band, stay on the bridge span
  if (u.y >= RIVER_TOP && u.y <= RIVER_BOT) {
    const lane = u.x < fp(9) ? 0 : 1;
    u.x = clampInt(u.x, BRIDGE_X[lane] - BRIDGE_HALF_W, BRIDGE_X[lane] + BRIDGE_HALF_W);
  }
  const d = fpDist(u.x, u.y, tx, ty);
  if (d === 0) return;
  const step = Math.min(speed, d);
  u.x += Math.floor((step * (tx - u.x)) / d);
  u.y += Math.floor((step * (ty - u.y)) / d);
}

function hasSupportAura(state: SimState, u: Unit): boolean {
  for (const s of state.units) {
    if (s.owner !== u.owner || s.hp <= 0 || s.archetype !== Archetype.Support || s.id === u.id) continue;
    const def = ARCHETYPES[Archetype.Support];
    if (fpDist(u.x, u.y, s.x, s.y) <= def.auraFP) return true;
  }
  return false;
}

function dealSplash(
  state: SimState, owner: 0 | 1, cx: number, cy: number, radius: number, damage: number,
): void {
  for (const e of state.units) {
    if (e.owner === owner || e.hp <= 0) continue;
    if (fpDist(cx, cy, e.x, e.y) <= radius + UNIT_RADIUS) e.hp -= damage;
  }
}

function wakeKing(state: SimState, owner: 0 | 1): void {
  const king = state.towers[owner === 0 ? 2 : 5];
  king.awake = true;
}

function damageTower(state: SimState, idx: number, dmg: number): void {
  const t = state.towers[idx];
  if (t.hp <= 0) return;
  t.hp -= dmg;
  if (t.kind === 'king') t.awake = true;
  if (t.hp <= 0) {
    t.hp = 0;
    if (t.kind === 'princess') wakeKing(state, t.owner);
  }
}

// ── Tick ─────────────────────────────────────────────────────────────────────
function stepUnits(state: SimState): void {
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    const def = effectiveDef(ARCHETYPES[u.archetype], u.trait, u.archetype);
    if (u.cooldown > 0) u.cooldown--;

    // sticky unit target if still valid, else re-acquire
    let target: Unit | undefined;
    if (u.targetUnit !== -1) {
      target = state.units.find((e) => e.id === u.targetUnit && e.hp > 0);
      if (target && fpDist(u.x, u.y, target.x, target.y) > def.aggroFP + fp(1)) target = undefined;
    }
    if (!target) {
      const id = nearestEnemyUnit(state, u, def.aggroFP);
      target = id === -1 ? undefined : state.units.find((e) => e.id === id);
      u.targetUnit = target ? target.id : -1;
    }

    if (target) {
      const d = fpDist(u.x, u.y, target.x, target.y);
      if (d <= def.rangeFP + 2 * UNIT_RADIUS) {
        u.state = 'attack';
        if (u.cooldown === 0) {
          const dmg = scaleStat(def.damage, u.level, u.metaBps);
          if (def.splashFP > 0) dealSplash(state, u.owner, target.x, target.y, def.splashFP, dmg);
          else target.hp -= dmg;
          const buffed = hasSupportAura(state, u);
          u.cooldown = buffed
            ? Math.floor((def.hitTicks * AURA_SPEED_NUM) / AURA_SPEED_DEN)
            : def.hitTicks;
        }
      } else {
        u.state = 'advance';
        moveToward(u, target.x, target.y, def.speedFP);
      }
      continue;
    }

    // no unit target → push the tower
    const ti = pickTargetTower(state, u);
    u.targetTower = ti;
    const t = state.towers[ti];
    const d = fpDist(u.x, u.y, t.x, t.y);
    if (d <= def.rangeFP + TOWER_RADIUS[t.kind] + UNIT_RADIUS) {
      u.state = 'attack';
      if (u.cooldown === 0) {
        damageTower(state, ti, scaleStat(def.damage, u.level, u.metaBps));
        const buffed = hasSupportAura(state, u);
        u.cooldown = buffed
          ? Math.floor((def.hitTicks * AURA_SPEED_NUM) / AURA_SPEED_DEN)
          : def.hitTicks;
      }
    } else {
      u.state = 'advance';
      moveToward(u, t.x, t.y, def.speedFP);
    }
  }
}

function stepTowers(state: SimState): void {
  for (const t of state.towers) {
    if (t.hp <= 0) continue;
    if (t.cooldown > 0) t.cooldown--;
    if (t.kind === 'king' && !t.awake) continue;
    const base = t.kind === 'princess' ? PRINCESS : KING;
    let best: Unit | undefined;
    let bestD = base.rangeFP + UNIT_RADIUS + 1;
    for (const e of state.units) {
      if (e.owner === t.owner || e.hp <= 0) continue;
      const d = fpDist(t.x, t.y, e.x, e.y);
      if (d < bestD || (d === bestD && best && e.id < best.id)) {
        bestD = d;
        best = e;
      }
    }
    if (best && t.cooldown === 0) {
      const lvl = towerLevelOf(state, t);
      best.hp -= scaleByLevel(base.damage, lvl);
      t.cooldown = base.hitTicks;
    }
  }
}

function towerLevelOf(state: SimState, t: Tower): number {
  return towerLevel(state.players[t.owner].deck);
}

function stepSpells(state: SimState): void {
  const remaining: PendingSpell[] = [];
  for (const s of state.spells) {
    if (state.tick < s.explodeTick) {
      remaining.push(s);
      continue;
    }
    const def = ARCHETYPES[Archetype.Spell];
    const dmg = scaleStat(def.damage, s.level, s.metaBps);
    dealSplash(state, s.owner, s.x, s.y, def.splashFP, dmg);
    const towerDmg = Math.floor((dmg * SPELL_TOWER_DAMAGE_PCT) / 100);
    for (let i = 0; i < state.towers.length; i++) {
      const t = state.towers[i];
      if (t.owner === s.owner || t.hp <= 0) continue;
      if (fpDist(s.x, s.y, t.x, t.y) <= def.splashFP + TOWER_RADIUS[t.kind]) {
        damageTower(state, i, towerDmg);
      }
    }
  }
  state.spells = remaining;
}

function aliveTowerCount(state: SimState, owner: 0 | 1): number {
  let n = 0;
  for (const t of state.towers) if (t.owner === owner && t.hp > 0) n++;
  return n;
}

function totalTowerHp(state: SimState, owner: 0 | 1): number {
  let n = 0;
  for (const t of state.towers) if (t.owner === owner) n += t.hp;
  return n;
}

function checkEnd(state: SimState, towersBefore: [number, number]): void {
  // king dead → instant win
  if (state.towers[2].hp <= 0) { state.phase = 'ended'; state.winner = 1; return; }
  if (state.towers[5].hp <= 0) { state.phase = 'ended'; state.winner = 0; return; }

  if (state.phase === 'overtime') {
    // first tower falls in overtime wins
    const a = aliveTowerCount(state, 0);
    const b = aliveTowerCount(state, 1);
    if (a < towersBefore[0]) { state.phase = 'ended'; state.winner = 1; return; }
    if (b < towersBefore[1]) { state.phase = 'ended'; state.winner = 0; return; }
    if (state.tick >= state.format.regulationTicks + state.format.overtimeTicks) {
      const hpA = totalTowerHp(state, 0);
      const hpB = totalTowerHp(state, 1);
      state.phase = 'ended';
      state.winner = hpA === hpB ? -2 : hpA > hpB ? 0 : 1;
    }
    return;
  }

  if (state.tick >= state.format.regulationTicks) {
    const a = aliveTowerCount(state, 0);
    const b = aliveTowerCount(state, 1);
    if (a !== b) {
      state.phase = 'ended';
      state.winner = a > b ? 0 : 1;
    } else if (state.format.overtimeTicks > 0) {
      state.phase = 'overtime';
    } else {
      // Rush has no overtime: level towers at the bell is an honest draw.
      const hpA = totalTowerHp(state, 0);
      const hpB = totalTowerHp(state, 1);
      state.phase = 'ended';
      state.winner = hpA === hpB ? -2 : hpA > hpB ? 0 : 1;
    }
  }
}

function doubleElixirActive(state: SimState): boolean {
  return state.phase === 'overtime' || state.tick >= state.format.doubleElixirAt;
}

/**
 * Advance one tick. `inputs` must be exactly the events scheduled for
 * state.tick (caller filters); order inside the tick is normalized here.
 */
export function stepSim(state: SimState, inputs: InputEvent[]): void {
  if (state.phase === 'ended') return;

  const towersBefore: [number, number] = [aliveTowerCount(state, 0), aliveTowerCount(state, 1)];

  // 1. elixir
  const gain = doubleElixirActive(state)
    ? state.format.elixirPerTickFP * 2
    : state.format.elixirPerTickFP;
  for (const p of state.players) {
    p.elixirFP = Math.min(state.format.elixirCapFP, p.elixirFP + gain);
  }

  // 2. inputs (normalized order)
  for (const ev of sortInputs(inputs)) {
    if (ev.tick === state.tick) applyInput(state, ev);
  }

  // 3. simulation passes
  stepSpells(state);
  stepUnits(state);
  stepTowers(state);

  // 4. cleanup
  if (state.units.some((u) => u.hp <= 0)) {
    state.units = state.units.filter((u) => u.hp > 0);
  }

  // 5. end conditions
  checkEnd(state, towersBefore);
  state.tick++;
}

// ── Hash & clone ─────────────────────────────────────────────────────────────
export function hashState(state: SimState): number {
  const h = new Fnv1a();
  // `phase` and `nextUnitId` were both omitted. Two clients in different
  // phases — one in overtime, one not — agreed on the hash until the
  // difference happened to move a unit, which can be dozens of ticks later.
  // `nextUnitId` is the cheapest possible canary: it diverges the instant the
  // two sides have spawned a different number of units, whatever the reason.
  h.int(state.tick).int(state.rngState).int(state.winner + 3);
  h.int(state.phase === 'regulation' ? 0 : state.phase === 'overtime' ? 1 : 2);
  h.int(state.nextUnitId);
  for (const p of state.players) {
    h.int(p.elixirFP);
    for (const c of p.cycle) h.int(c);
  }
  for (const u of state.units) {
    // Targets and state were omitted, so two clients could have the same units
    // in the same places attacking different things — sticky targeting means
    // that stays invisible until the damage lands somewhere different.
    // `level`, `trait` and `maxHp` are what every stat is derived from: if
    // they ever disagree the two sims are not running the same game at all,
    // and that is worth catching on the first checkpoint rather than the
    // first death.
    h.int(u.id).int(u.owner).int(u.archetype).int(u.x).int(u.y).int(u.hp)
      .int(u.cooldown).int(u.maxHp).int(u.level).int(u.trait).int(u.metaBps)
      .int(u.targetUnit).int(u.targetTower).int(u.state === 'advance' ? 0 : 1);
  }
  for (const t of state.towers) {
    h.int(t.hp).int(t.cooldown).int(t.awake ? 1 : 0);
  }
  for (const s of state.spells) {
    h.int(s.owner).int(s.x).int(s.y).int(s.explodeTick).int(s.level).int(s.metaBps);
  }
  return h.digest();
}

export function cloneState(state: SimState): SimState {
  return JSON.parse(JSON.stringify(state)) as SimState;
}

export { towerLevel };
