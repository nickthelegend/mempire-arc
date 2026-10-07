import { FP, fp, fpDist, clampInt } from './fixed';
import { ARCHETYPES } from './archetypes';
import { ARENA_H, BRIDGE_X, RIVER_BOT, RIVER_TOP } from './engine';
import { Archetype, HAND_SIZE, INPUT_DELAY_TICKS } from './types';
import type { InputEvent, SimState, Unit } from './types';

export type BotDifficulty = 'easy' | 'normal' | 'hard';

const DIFF = {
  easy: { actEvery: 56, saveTo: 9 * FP },
  normal: { actEvery: 24, saveTo: 7 * FP },
  hard: { actEvery: 8, saveTo: 5 * FP },
} as const;

/** Preference order per situation; picks the first affordable card in hand. */
const DEFEND_PREF = [Archetype.Splash, Archetype.Ranged, Archetype.Swarm, Archetype.Tank, Archetype.Support];
const ATTACK_PREF = [Archetype.Tank, Archetype.Support, Archetype.Ranged, Archetype.Splash, Archetype.Swarm];

function handOf(state: SimState, player: 0 | 1): { deckIndex: number; arch: Archetype; cost: number }[] {
  const p = state.players[player];
  const out = [];
  for (let i = 0; i < HAND_SIZE; i++) {
    const deckIndex = p.cycle[i];
    const card = p.deck[deckIndex];
    out.push({ deckIndex, arch: card.archetype, cost: ARCHETYPES[card.archetype].elixir * FP });
  }
  return out;
}

function pickByPref(
  hand: ReturnType<typeof handOf>, pref: Archetype[], elixir: number,
): { deckIndex: number; arch: Archetype } | null {
  for (const a of pref) {
    const c = hand.find((h) => h.arch === a && h.cost <= elixir);
    if (c) return c;
  }
  return null;
}

function enemyThreats(state: SimState, player: 0 | 1): Unit[] {
  // enemy units on our half, sorted by how deep they are
  const onOurHalf = (u: Unit) => (player === 0 ? u.y < RIVER_TOP : u.y > RIVER_BOT);
  return state.units
    .filter((u) => u.owner !== player && u.hp > 0 && onOurHalf(u))
    .sort((a, b) => (player === 0 ? a.y - b.y : b.y - a.y) || a.id - b.id);
}

/** Cluster check for spell value: ≥3 enemies within 2.5 tiles of one of them. */
function spellTarget(state: SimState, player: 0 | 1): { x: number; y: number } | null {
  const enemies = state.units.filter((u) => u.owner !== player && u.hp > 0);
  for (const c of enemies) {
    const near = enemies.filter((e) => fpDist(c.x, c.y, e.x, e.y) <= fp(2.5));
    if (near.length >= 3) {
      let sx = 0; let sy = 0;
      for (const e of near) { sx += e.x; sy += e.y; }
      return { x: Math.floor(sx / near.length), y: Math.floor(sy / near.length) };
    }
  }
  return null;
}

/**
 * Deterministic bot. Call once per tick; returns an input scheduled with the
 * same lockstep delay a human's input gets, or null.
 */
export function decideBot(
  state: SimState, player: 0 | 1, difficulty: BotDifficulty = 'normal',
): InputEvent | null {
  const cfg = DIFF[difficulty];
  if (state.phase === 'ended' || state.tick % cfg.actEvery !== 0) return null;
  const me = state.players[player];
  const hand = handOf(state, player);
  const mkEvent = (deckIndex: number, x: number, y: number): InputEvent => ({
    tick: state.tick + INPUT_DELAY_TICKS,
    player,
    deckIndex,
    x,
    y,
  });

  // 1. spell on a fat cluster
  const spellCard = hand.find((h) => h.arch === Archetype.Spell && h.cost <= me.elixirFP);
  if (spellCard) {
    const t = spellTarget(state, player);
    if (t) return mkEvent(spellCard.deckIndex, t.x, t.y);
  }

  // 2. defend if invaded
  const threats = enemyThreats(state, player);
  if (threats.length > 0) {
    const threat = threats[0];
    const pick = pickByPref(hand, DEFEND_PREF, me.elixirFP);
    if (pick) {
      // drop between the threat and our king, a bit toward home
      const homeY = player === 0 ? fp(2.5) : ARENA_H - fp(2.5);
      const y = clampInt(
        threat.y + (homeY > threat.y ? fp(1.5) : -fp(1.5)),
        fp(0.5), ARENA_H - fp(0.5),
      );
      return mkEvent(pick.deckIndex, threat.x, y);
    }
    return null;
  }

  // 3. reinforce an active push: if we already have attackers heading out,
  // keep feeding the same lane instead of saving (state-derived, deterministic)
  const pushers = state.units.filter((u) => {
    if (u.owner !== player || u.hp <= 0) return false;
    return player === 0 ? u.y > RIVER_TOP - fp(5) : u.y < RIVER_BOT + fp(5);
  });
  const enemyBase = player === 0 ? 3 : 0;
  const left = state.towers[enemyBase];
  const right = state.towers[enemyBase + 1];
  const stageY = player === 0 ? RIVER_TOP - fp(2) : RIVER_BOT + fp(2);
  const back = player === 0 ? -fp(2) : fp(2);

  if (pushers.length > 0) {
    const pushLane = pushers[0].x < fp(9) ? 0 : 1;
    const pick = pickByPref(hand, ATTACK_PREF, me.elixirFP);
    if (pick) return mkEvent(pick.deckIndex, BRIDGE_X[pushLane], stageY + back);
    return null;
  }

  // 4. open a fresh push once we've saved up
  if (me.elixirFP < cfg.saveTo) return null;
  const lane = left.hp <= 0 ? 0 : right.hp <= 0 ? 1 : left.hp <= right.hp ? 0 : 1;
  const pick = pickByPref(hand, ATTACK_PREF, me.elixirFP);
  if (!pick) return null;
  const y = pick.arch === Archetype.Tank ? stageY : stageY + back;
  return mkEvent(pick.deckIndex, BRIDGE_X[lane], y);
}
