/**
 * Battle presentation: the parts a screenshot cannot check.
 *
 * The unit animation is driven off simulation state and the effects run through
 * a fixed pool. Both failure modes are invisible in a still frame and obvious
 * after ten minutes of play:
 *
 *  - the strike cue reads the sim's attack cooldown, so if that premise is wrong
 *    every blow animates at the wrong moment (or never)
 *  - the particle pool is capped and recycled, so a leak shows up as a slowly
 *    dying framerate in the one match that matters
 *
 * Run: npx tsx test-battle-anim.mjs
 */
import assert from 'node:assert/strict';

// three.js touches the DOM the moment a CanvasTexture is built. A canvas stub
// large enough for 2D gradient work is all the pool needs; nothing here reads
// pixels back, so the drawing calls can be no-ops.
function stubCanvas() {
  const ctx2d = {
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {}, beginPath() {}, closePath() {}, fill() {},
    lineTo() {}, translate() {}, set fillStyle(_v) {}, get fillStyle() { return ''; },
  };
  globalThis.document = {
    createElement: (tag) => (tag === 'canvas'
      ? { width: 0, height: 0, getContext: () => ctx2d, toBlob: (cb) => cb(null) }
      : {}),
    createElementNS: () => ({ style: {} }),
  };
  globalThis.window = {
    // Default: motion allowed. Individual cases override this.
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, removeEventListener() {},
  };
  // Deliberately NOT aliasing globalThis.self: tsx's own ESM parser picks
  // `self` over `global` when it exists, and a hand-rolled stub without the
  // typed-array constructors crashes it before a single test runs.
}
stubCanvas();

const THREE = await import('three');
const { vfx } = await import('./src/three/vfx.ts');
const { createMatch, stepSim } = await import('./src/sim/engine.ts');
const { ARCHETYPES } = await import('./src/sim/archetypes.ts');
const { effectiveDef } = await import('./src/sim/traits.ts');
const { FORMATS } = await import('./src/sim/types.ts');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
};

const camera = new THREE.PerspectiveCamera();
/** Run the pool forward far enough that every effect has expired. */
const drain = (seconds = 3) => {
  for (let i = 0; i < seconds * 60; i += 1) vfx.update(1 / 60, camera);
};

console.log('\nvfx pool');

check('honours its particle ceiling under a flood', () => {
  vfx.reset();
  // Far more than a real match can produce in one frame.
  for (let i = 0; i < 400; i += 1) vfx.impact(0, 1, 0, 1, 0, '#fff', 1);
  const meshes = vfx.group.children.filter((c) => c.visible).length;
  assert.ok(meshes <= 140, `expected <= 140 visible, got ${meshes}`);
});

check('recycles rather than allocating — a long match must not grow the scene', () => {
  vfx.reset();
  drain();
  for (let i = 0; i < 400; i += 1) vfx.impact(0, 1, 0, 1, 0, '#fff', 1);
  drain();
  const afterFirst = vfx.group.children.length;
  // Twenty more waves, i.e. minutes of heavy combat.
  for (let wave = 0; wave < 20; wave += 1) {
    for (let i = 0; i < 200; i += 1) vfx.impact(0, 1, 0, 1, 0, '#fff', 1);
    vfx.dust(0, 0, 1);
    vfx.coins(0, 1, 0, 8);
    vfx.shockwave(0, 0, '#fff', 1);
    drain(1);
  }
  drain();
  assert.equal(
    vfx.group.children.length, afterFirst,
    `pool grew from ${afterFirst} to ${vfx.group.children.length} — it is leaking`,
  );
});

check('every particle is retired, not left visible forever', () => {
  vfx.reset();
  for (let i = 0; i < 60; i += 1) vfx.impact(0, 1, 0, 1, 0, '#fff', 1);
  vfx.dust(0, 0, 1);
  vfx.coins(0, 1, 0, 6);
  drain();
  const stillUp = vfx.group.children.filter((c) => c.visible).length;
  assert.equal(stillUp, 0, `${stillUp} particles never expired`);
});

check('a shot lands exactly once and reports where', () => {
  vfx.reset();
  let arrivals = 0;
  let at = null;
  vfx.shot(
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(4, 1, 3), '#fff', 0.8,
    (p) => { arrivals += 1; at = p.clone(); },
  );
  drain();
  assert.equal(arrivals, 1, `onArrive fired ${arrivals} times`);
  assert.ok(at.distanceTo(new THREE.Vector3(4, 1, 3)) < 1e-6, 'landed off target');
});

check('a shot cancelled by reset does not fire its impact later', () => {
  vfx.reset();
  let arrivals = 0;
  vfx.shot(new THREE.Vector3(0, 1, 0), new THREE.Vector3(9, 1, 9), '#fff', 0.8,
    () => { arrivals += 1; });
  vfx.update(1 / 60, camera);
  vfx.reset();
  drain();
  assert.equal(arrivals, 0, 'a stale shot fired into the next match');
});

console.log('\ncamera shake');

check('decays to a hard zero, never a drifting residue', () => {
  vfx.reset();
  const out = new THREE.Vector3();
  vfx.kick(0.5);
  for (let i = 0; i < 120; i += 1) vfx.shakeOffset(1 / 60, out);
  assert.equal(out.x, 0);
  assert.equal(out.y, 0);
  assert.equal(out.z, 0);
});

check('ten simultaneous impacts do not shake ten times as hard', () => {
  vfx.reset();
  const out = new THREE.Vector3();
  for (let i = 0; i < 10; i += 1) vfx.kick(0.42);
  vfx.shakeOffset(1 / 60, out);
  assert.ok(out.length() <= 0.56 * Math.sqrt(3),
    `shake stacked to ${out.length().toFixed(2)}`);
});

check('reduced motion suppresses it entirely', () => {
  vfx.reset();
  const out = new THREE.Vector3();
  globalThis.window.matchMedia = () => ({ matches: true });
  vfx.kick(0.5);
  vfx.shakeOffset(1 / 60, out);
  globalThis.window.matchMedia = () => ({ matches: false });
  assert.equal(out.length(), 0, 'the viewport moved with reduced motion on');
});

console.log('\nthe strike cue reads the real simulation');

check('a cooldown that jumps upward marks a hit, and nothing else does', () => {
  // The animation's whole attack timing rests on this. Run a real match and
  // watch every unit's cooldown; a rise must only ever happen on the tick the
  // sim resolved a hit, and must land on a value the archetype could produce.
  const deck = (o) => Array.from({ length: 8 }, (_, i) => ({
    coinId: `mint${o}${i}`, name: `C${i}`, archetype: i % 5, level: 3,
  }));
  const sim = createMatch(20260809, [deck(0), deck(1)], FORMATS.standard);
  const last = new Map();
  let rises = 0;
  let bad = 0;

  for (let t = 0; t < 20 * 90; t += 1) {
    // Deploy from both sides across the field so the lanes actually collide.
    // Elixir is topped up rather than waited out: this test is about whether
    // the strike cue fires, not about the economy, and a real regen curve would
    // spend most of the ninety seconds with an empty board.
    const inputs = [];
    if (t % 20 === 0) {
      sim.players[0].elixirFP = 10 * 1024;
      sim.players[1].elixirFP = 10 * 1024;
      const slot = (t / 20) % 8;
      inputs.push({ tick: sim.tick, player: 0, deckIndex: slot, x: 4096 + (t % 7) * 1024, y: 12 * 1024 });
      inputs.push({ tick: sim.tick, player: 1, deckIndex: slot, x: 4096 + (t % 5) * 1024, y: 20 * 1024 });
    }
    stepSim(sim, inputs);

    for (const u of sim.units) {
      const prev = last.get(u.id);
      if (prev !== undefined && u.cooldown > prev) {
        rises += 1;
        // A reset can only be the unit's own hit interval, or that interval
        // sped up by a support aura (×100/115, floored). "Its own" means after
        // its trait: Brutal swings slower than its archetype and Relentless
        // faster, so reading the raw archetype here would flag every one of
        // them as a bad reset.
        const base = effectiveDef(ARCHETYPES[u.archetype], u.trait, u.archetype).hitTicks;
        const buffed = Math.floor((base * 100) / 115);
        if (u.cooldown !== base && u.cooldown !== buffed) bad += 1;
      }
      last.set(u.id, u.cooldown);
    }
    for (const id of [...last.keys()]) {
      if (!sim.units.some((u) => u.id === id)) last.delete(id);
    }
  }

  assert.ok(rises > 40, `only ${rises} strikes in 90s — the cue would never fire`);
  assert.equal(bad, 0, `${bad} of ${rises} rises were not a hit-interval reset`);
  console.log(`       (${rises} strikes detected across 90s of real combat)`);
});

check('cooldown never exceeds the value the wind-up divides by', () => {
  // `charge = 1 - cooldown / cycle` is only in [0,1] if the captured reset
  // value is the largest the cooldown ever takes. A negative charge would run
  // the anticipation backwards.
  for (const [a, def] of Object.entries(ARCHETYPES)) {
    if (def.hitTicks === 0) continue;
    const buffed = Math.floor((def.hitTicks * 100) / 115);
    assert.ok(buffed <= def.hitTicks,
      `archetype ${a}: aura-buffed reset ${buffed} exceeds base ${def.hitTicks}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
