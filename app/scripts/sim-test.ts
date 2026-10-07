// Determinism + completeness harness for the lockstep sim.
// Run: npx tsx scripts/sim-test.ts
import { createMatch, hashState, stepSim } from '../src/sim/engine';
import { archetypeForMint, ARCHETYPES } from '../src/sim/archetypes';
import { decideBot } from '../src/sim/bot';
import { traitForMint } from '../src/sim/traits';
import {
  HASH_EVERY_TICKS, InputEvent, MatchCard, OVERTIME_TICKS, REGULATION_TICKS,
} from '../src/sim/types';

// The real roster: identity is the Pyth feed id, exactly as on chain.
import roster from '../../shared/roster.json';
const COINS: string[] = roster.coins.map((c: { feedId: string }) => c.feedId.toLowerCase());

function deck(offset: number, levels: number[], meta: number[] = []): MatchCard[] {
  return Array.from({ length: 8 }, (_, i) => {
    const mint = COINS[(i + offset) % COINS.length];
    return {
      coinId: mint,
      name: mint.slice(2, 8).toUpperCase(),
      archetype: archetypeForMint(mint),
      trait: traitForMint(mint),
      level: levels[i % levels.length],
      metaBps: meta.length ? meta[i % meta.length] : 0,
    };
  });
}

function runMatch(seed: number, meta: number[] = []): { hashes: number[]; winner: number; ticks: number; peak: number } {
  const state = createMatch(seed, [deck(0, [3, 5, 2, 8], meta), deck(4, [4, 4, 6, 3], meta.map((m) => -m))]);
  const pending = new Map<number, InputEvent[]>();
  const hashes: number[] = [];
  let peak = 0;
  const cap = REGULATION_TICKS + OVERTIME_TICKS + 10;
  while (state.phase !== 'ended' && state.tick < cap) {
    for (const player of [0, 1] as const) {
      const ev = decideBot(state, player, player === 0 ? 'normal' : 'hard');
      if (ev) {
        const list = pending.get(ev.tick) ?? [];
        list.push(ev);
        pending.set(ev.tick, list);
      }
    }
    stepSim(state, pending.get(state.tick) ?? []);
    pending.delete(state.tick - 1);
    peak = Math.max(peak, state.units.length);
    if (state.tick % HASH_EVERY_TICKS === 0) hashes.push(hashState(state));
  }
  return { hashes, winner: state.winner, ticks: state.tick, peak };
}

// archetype coverage sanity
const archs = COINS.map((c) => archetypeForMint(c));
console.log('archetype spread:', archs.join(','));
if (new Set(archs).size < 4) console.log('WARN: low archetype variety in seeds');
for (const [k, v] of Object.entries(ARCHETYPES)) {
  if (v.elixir <= 0) throw new Error(`archetype ${k} has no cost`);
}

const a = runMatch(0xdeadbeef);
const b = runMatch(0xdeadbeef);
const c = runMatch(0x12345678);

const identical = a.hashes.length === b.hashes.length && a.hashes.every((h, i) => h === b.hashes[i]);
console.log(`run A: winner=${a.winner} ticks=${a.ticks} peakUnits=${a.peak} hashes=${a.hashes.length}`);
console.log(`run B identical: ${identical}`);
console.log(`run C (different seed): winner=${c.winner} ticks=${c.ticks} finalHash ${c.hashes.at(-1)} vs ${a.hashes.at(-1)}`);

if (!identical) {
  const i = a.hashes.findIndex((h, idx) => h !== b.hashes[idx]);
  throw new Error(`DESYNC at hash checkpoint ${i} (tick ~${i * HASH_EVERY_TICKS})`);
}
if (a.winner === -1) throw new Error('match did not resolve');
if (a.peak === 0) throw new Error('bots never spawned units');
// The market meta: deterministic, and it actually changes the game.
const m1 = runMatch(0xdeadbeef, [800, -1200, 1500, 0]);
const m2 = runMatch(0xdeadbeef, [800, -1200, 1500, 0]);
const metaSame = m1.hashes.length === m2.hashes.length && m1.hashes.every((h, i) => h === m2.hashes[i]);
if (!metaSame) throw new Error('DESYNC with market modifiers applied');
if (m1.hashes.every((h, i) => h === a.hashes[i])) throw new Error('market modifiers had no effect on the sim');
console.log(`run M (with meta): winner=${m1.winner} ticks=${m1.ticks} — deterministic, diverges from the neutral run as it should`);
console.log('SIM OK: deterministic, resolves, bots play, market meta applies.');
