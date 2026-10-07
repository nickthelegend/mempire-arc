/**
 * Card traits: deterministic, independent of archetype, and none of them free.
 *
 * Three claims worth checking, none of them visible by playing:
 *
 *  1. **Deterministic.** A trait is a function of the mint and nothing else, so
 *     two clients simulating the same match agree. If this drifts, every match
 *     between two players desyncs and voids.
 *  2. **Independent of archetype.** Both come from the same hash. Derived
 *     carelessly they correlate, and some archetypes could never roll some
 *     traits — sixty-four cards collapsing back toward six.
 *  3. **No trait is strictly best.** Every one trades a stat away. A trait with
 *     only upside makes the other five dead weight.
 *
 * Run: npx tsx test-traits.mjs
 */
import assert from 'node:assert/strict';

const {
  TRAITS, Trait, TRAIT_NAMES, traitForMint, effectiveDef, applyPm, traitAppliesTo,
} = await import('./src/sim/traits.ts');
const { ARCHETYPES } = await import('./src/sim/archetypes.ts');
const { archetypeForMint } = await import('./src/sim/archetypes.ts');
const { Archetype } = await import('./src/sim/types.ts');
const { COINS } = await import('./src/lib/coins.ts');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('\ndetermination');

check('the same mint always gives the same trait', () => {
  for (const c of COINS) {
    const a = traitForMint(c.mint);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(traitForMint(c.mint), a, `${c.ticker} drifted`);
    }
  }
});

check('every one of the 64 registry coins resolves to a real trait', () => {
  for (const c of COINS) {
    const t = traitForMint(c.mint);
    assert.ok(t >= 0 && t <= 5, `${c.ticker} got trait ${t}`);
    assert.ok(TRAITS[t], `${c.ticker} has no trait definition`);
  }
});

check('trait is not a function of archetype', () => {
  // If the two were correlated, some (archetype, trait) pairs would never
  // occur. Across the registry the pairing should be spread, not banded.
  const pairs = new Set();
  for (const c of COINS) {
    pairs.add(`${archetypeForMint(c.mint)}:${traitForMint(c.mint)}`);
  }
  assert.ok(pairs.size >= 20,
    `only ${pairs.size} distinct archetype/trait pairs across ${COINS.length} coins`);
  console.log(`       (${pairs.size} distinct archetype×trait pairings across ${COINS.length} coins)`);
});

check('the distribution across the registry is not lopsided', () => {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const c of COINS) counts[traitForMint(c.mint)] += 1;
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  // 64 coins over 6 traits averages ~10.7. A perfectly flat split is not
  // expected from a hash; a trait nobody has would be a bug.
  assert.ok(min > 0, `a trait never occurs: ${counts.join(',')}`);
  assert.ok(max <= 24, `one trait dominates: ${counts.join(',')}`);
  console.log(`       (${TRAIT_NAMES.map((n, i) => `${n} ${counts[i]}`).join(', ')})`);
});

console.log('\nbalance');

check('no trait is strictly better than baseline', () => {
  // Every trait must give something up. A trait whose every modifier is >= 1000
  // (or, for hitTicks where lower is better, <= 1000) is free power.
  for (const [key, t] of Object.entries(TRAITS)) {
    const gains = [
      t.hpPm > 1000, t.damagePm > 1000, t.speedPm > 1000, t.rangePm > 1000,
      t.hitTicksPm < 1000,
    ];
    const losses = [
      t.hpPm < 1000, t.damagePm < 1000, t.speedPm < 1000, t.rangePm < 1000,
      t.hitTicksPm > 1000,
    ];
    assert.ok(gains.some(Boolean), `${t.name} has no upside`);
    assert.ok(losses.some(Boolean), `${t.name} (${key}) has no downside — it is free power`);
  }
});

check('no modifier is extreme enough to break an archetype', () => {
  for (const t of Object.values(TRAITS)) {
    for (const [k, v] of Object.entries(t)) {
      if (!k.endsWith('Pm')) continue;
      assert.ok(v >= 750 && v <= 1300,
        `${t.name}.${k} = ${v}; outside the 0.75–1.30 band a trait stops being a flavour`);
    }
  }
});

console.log('\napplication');

check('effectiveDef changes the stats it should and nothing else', () => {
  const base = ARCHETYPES[Archetype.Tank];
  const eff = effectiveDef(base, Trait.Swift, Archetype.Tank);
  assert.ok(eff.speedFP > base.speedFP, 'Swift did not speed it up');
  assert.ok(eff.hp < base.hp, 'Swift did not cost hit points');
  // Untouched fields must survive verbatim, or a trait silently rewrites cost.
  assert.equal(eff.elixir, base.elixir, 'a trait changed the elixir cost');
  assert.equal(eff.count, base.count, 'a trait changed the spawn count');
});

check('it never mutates the shared archetype table', () => {
  const before = JSON.stringify(ARCHETYPES[Archetype.Swarm]);
  effectiveDef(ARCHETYPES[Archetype.Swarm], Trait.Ironclad, Archetype.Swarm);
  assert.equal(JSON.stringify(ARCHETYPES[Archetype.Swarm]), before,
    'the baseline table was mutated — every card of this archetype would inherit it');
});

check('hitTicks can never reach zero', () => {
  // Zero would be an attack every single tick, which is not a fast unit, it is
  // a division-by-tick-rate bug wearing one.
  for (const a of [Archetype.Tank, Archetype.Swarm, Archetype.Ranged, Archetype.Splash, Archetype.Support]) {
    for (const t of Object.values(Trait)) {
      const eff = effectiveDef(ARCHETYPES[a], t, a);
      assert.ok(eff.hitTicks >= 1, `archetype ${a} trait ${t} gave hitTicks ${eff.hitTicks}`);
    }
  }
});

check('a spell is unaffected by its trait', () => {
  const base = ARCHETYPES[Archetype.Spell];
  assert.equal(traitAppliesTo(Archetype.Spell), false);
  for (const t of Object.values(Trait)) {
    assert.deepEqual(effectiveDef(base, t, Archetype.Spell), base,
      `trait ${t} altered a spell`);
  }
});

check('every stat stays an integer — the sim has no floats', () => {
  for (const a of [Archetype.Tank, Archetype.Swarm, Archetype.Ranged, Archetype.Splash, Archetype.Support]) {
    for (const t of Object.values(Trait)) {
      const eff = effectiveDef(ARCHETYPES[a], t, a);
      for (const [k, v] of Object.entries(eff)) {
        assert.ok(Number.isInteger(v), `${k} = ${v} is not an integer (archetype ${a}, trait ${t})`);
      }
    }
  }
});

check('applyPm floors, and floors the same way every time', () => {
  assert.equal(applyPm(1400, 1280), 1792);
  assert.equal(applyPm(7, 870), 6);      // 6.09 floors to 6
  assert.equal(applyPm(1, 830), 0);      // and small values can floor to zero
  assert.equal(applyPm(0, 1220), 0);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
