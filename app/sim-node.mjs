// src/sim/fixed.ts
var FP = 1024;
var fp = (tiles) => Math.round(tiles * FP);
function isqrt(n) {
  if (n < 0) return 0;
  if (n < 2) return n;
  let x = n;
  let y = Math.floor((x + 1) / 2);
  while (y < x) {
    x = y;
    y = Math.floor((x + Math.floor(n / x)) / 2);
  }
  return x;
}
function fpDist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return isqrt(dx * dx + dy * dy);
}
var clampInt = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// src/sim/rng.ts
var XorShift32 = class {
  s;
  constructor(seed) {
    this.s = seed >>> 0 || 2654435769;
  }
  next() {
    let x = this.s;
    x ^= x << 13 >>> 0;
    x ^= x >>> 17;
    x ^= x << 5 >>> 0;
    this.s = x >>> 0;
    return this.s;
  }
  // [0, n)
  nextInt(n) {
    return this.next() % n;
  }
  state() {
    return this.s;
  }
};

// src/sim/hash.ts
var FNV_OFFSET = 2166136261;
var FNV_PRIME = 16777619;
var Fnv1a = class {
  h = FNV_OFFSET;
  int(v) {
    let x = v >>> 0;
    for (let i = 0; i < 4; i++) {
      this.h ^= x & 255;
      this.h = Math.imul(this.h, FNV_PRIME) >>> 0;
      x >>>= 8;
    }
    return this;
  }
  digest() {
    return this.h >>> 0;
  }
};

// src/sim/types.ts
var TICKS_PER_SEC = 20;
var REGULATION_TICKS = 180 * TICKS_PER_SEC;
var OVERTIME_TICKS = 60 * TICKS_PER_SEC;
var DOUBLE_ELIXIR_AT = 120 * TICKS_PER_SEC;
var FORMATS = {
  standard: {
    id: "standard",
    regulationTicks: REGULATION_TICKS,
    overtimeTicks: OVERTIME_TICKS,
    doubleElixirAt: DOUBLE_ELIXIR_AT,
    elixirPerTickFP: Math.floor(1024 / (2.8 * TICKS_PER_SEC)),
    elixirCapFP: 10 * 1024,
    startElixirFP: 5 * 1024
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
    id: "rush",
    regulationTicks: 30 * TICKS_PER_SEC,
    overtimeTicks: 0,
    doubleElixirAt: Number.MAX_SAFE_INTEGER,
    // never — the whole match is fast
    elixirPerTickFP: Math.floor(1024 / (0.9 * TICKS_PER_SEC)),
    elixirCapFP: 10 * 1024,
    startElixirFP: 7 * 1024
  }
};
var HAND_SIZE = 4;
var DECK_SIZE = 8;
var ELIXIR_CAP_FP = 10 * 1024;
var ELIXIR_PER_TICK_FP = Math.floor(1024 / (2.8 * TICKS_PER_SEC));
var Archetype = {
  Tank: 0,
  Swarm: 1,
  Ranged: 2,
  Splash: 3,
  Support: 4,
  Spell: 5
};

// src/sim/archetypes.ts
var tilesPerSec = (t) => Math.floor(t * FP / TICKS_PER_SEC);
var ARCHETYPES = {
  [Archetype.Tank]: {
    hp: 1400,
    damage: 150,
    hitTicks: 30,
    rangeFP: Math.floor(1.2 * FP),
    aggroFP: Math.floor(5.5 * FP),
    speedFP: tilesPerSec(0.9),
    elixir: 4,
    count: 1,
    splashFP: 0,
    spellDelayTicks: 0,
    auraFP: 0
  },
  [Archetype.Swarm]: {
    hp: 190,
    damage: 45,
    hitTicks: 22,
    rangeFP: Math.floor(0.9 * FP),
    aggroFP: Math.floor(5.5 * FP),
    speedFP: tilesPerSec(1.8),
    elixir: 3,
    count: 4,
    splashFP: 0,
    spellDelayTicks: 0,
    auraFP: 0
  },
  [Archetype.Ranged]: {
    hp: 320,
    damage: 110,
    hitTicks: 28,
    rangeFP: Math.floor(5 * FP),
    aggroFP: Math.floor(6 * FP),
    speedFP: tilesPerSec(1.2),
    elixir: 3,
    count: 1,
    splashFP: 0,
    spellDelayTicks: 0,
    auraFP: 0
  },
  [Archetype.Splash]: {
    hp: 520,
    damage: 140,
    hitTicks: 36,
    rangeFP: Math.floor(3.2 * FP),
    aggroFP: Math.floor(5.5 * FP),
    speedFP: tilesPerSec(1),
    elixir: 4,
    count: 1,
    splashFP: Math.floor(1.6 * FP),
    spellDelayTicks: 0,
    auraFP: 0
  },
  [Archetype.Support]: {
    hp: 450,
    damage: 55,
    hitTicks: 26,
    rangeFP: Math.floor(1.4 * FP),
    aggroFP: Math.floor(5 * FP),
    speedFP: tilesPerSec(1.1),
    elixir: 3,
    count: 1,
    splashFP: 0,
    spellDelayTicks: 0,
    auraFP: Math.floor(3 * FP)
  },
  [Archetype.Spell]: {
    hp: 0,
    damage: 320,
    hitTicks: 0,
    rangeFP: 0,
    aggroFP: 0,
    speedFP: 0,
    elixir: 4,
    count: 0,
    splashFP: Math.floor(2.5 * FP),
    spellDelayTicks: TICKS_PER_SEC,
    auraFP: 0
  }
};
var AURA_SPEED_NUM = 100;
var AURA_SPEED_DEN = 115;
var LEVEL_MULT_PM = [0, 1e3, 1200, 1283, 1346, 1400, 1447, 1490, 1529, 1566, 1600];
var scaleByLevel = (base, level) => Math.floor(base * LEVEL_MULT_PM[level] / 1e3);

// src/sim/traits.ts
var Trait = {
  Swift: 0,
  Brutal: 1,
  Stalwart: 2,
  Relentless: 3,
  Farsighted: 4,
  Ironclad: 5
};
var TRAITS = {
  [Trait.Swift]: {
    name: "Swift",
    blurb: "Crosses the bridge first. Folds if it meets anything there.",
    hpPm: 860,
    damagePm: 1e3,
    hitTicksPm: 1e3,
    speedPm: 1220,
    rangePm: 1e3
  },
  [Trait.Brutal]: {
    name: "Brutal",
    blurb: "Hits like a truck, on a truck\u2019s schedule.",
    hpPm: 1e3,
    damagePm: 1240,
    hitTicksPm: 1180,
    speedPm: 1e3,
    rangePm: 1e3
  },
  [Trait.Stalwart]: {
    name: "Stalwart",
    blurb: "Soaks a tower shot so the thing behind it does not.",
    hpPm: 1280,
    damagePm: 880,
    hitTicksPm: 1e3,
    speedPm: 1e3,
    rangePm: 1e3
  },
  [Trait.Relentless]: {
    name: "Relentless",
    blurb: "Never stops swinging. Never swings hard.",
    hpPm: 1e3,
    damagePm: 870,
    hitTicksPm: 800,
    speedPm: 1e3,
    rangePm: 1e3
  },
  [Trait.Farsighted]: {
    name: "Farsighted",
    blurb: "Opens fire before it is noticed. Dies if it is.",
    hpPm: 850,
    damagePm: 1e3,
    hitTicksPm: 1e3,
    speedPm: 1e3,
    rangePm: 1220
  },
  [Trait.Ironclad]: {
    name: "Ironclad",
    blurb: "Heavier in every sense, including the walk.",
    hpPm: 1120,
    damagePm: 1100,
    hitTicksPm: 1e3,
    speedPm: 830,
    rangePm: 1e3
  }
};
function traitForMint(mint) {
  let h = 2166136261;
  for (let i = 0; i < mint.length; i++) {
    h ^= mint.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 625341585) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) % 6;
}
var applyPm = (base, pm) => Math.floor(base * pm / 1e3);
var traitAppliesTo = (archetype) => archetype !== Archetype.Spell;
function effectiveDef(def, trait, archetype) {
  if (!traitAppliesTo(archetype)) return def;
  const t = TRAITS[trait];
  return {
    ...def,
    hp: applyPm(def.hp, t.hpPm),
    damage: applyPm(def.damage, t.damagePm),
    // Ticks between hits: lower is faster, so a "faster" trait is a pm below
    // 1000. Guarded at 1 — a zero here would be an attack every tick.
    hitTicks: Math.max(1, applyPm(def.hitTicks, t.hitTicksPm)),
    speedFP: applyPm(def.speedFP, t.speedPm),
    rangeFP: applyPm(def.rangeFP, t.rangePm)
  };
}

// src/sim/engine.ts
var ARENA_W = fp(18);
var ARENA_H = fp(32);
var RIVER_TOP = fp(15);
var RIVER_BOT = fp(17);
var RIVER_MID = fp(16);
var BRIDGE_X = [fp(3.5), fp(14.5)];
var BRIDGE_HALF_W = fp(0.9);
var UNIT_RADIUS = fp(0.35);
var TOWER_RADIUS = { princess: fp(1), king: fp(1.4) };
var PRINCESS = { hp: 1500, damage: 95, hitTicks: 16, rangeFP: fp(7) };
var KING = { hp: 2400, damage: 105, hitTicks: 20, rangeFP: fp(7) };
var SPELL_TOWER_DAMAGE_PCT = 40;
var SPAWN_OFFSETS = [
  [0, 0],
  [fp(0.6), 0],
  [-fp(0.6), 0],
  [0, fp(0.6)],
  [0, -fp(0.6)]
];
function towerLevel(deck) {
  let sum = 0;
  for (const c of deck) sum += c.level;
  return clampInt(Math.floor(sum / deck.length), 1, 10);
}
function makeTowers(deckA, deckB) {
  const mk = (owner, kind, lane, x, y, lvl) => {
    const base = kind === "princess" ? PRINCESS : KING;
    const hp = scaleByLevel(base.hp, lvl);
    return {
      owner,
      kind,
      lane,
      x,
      y,
      hp,
      maxHp: hp,
      cooldown: 0,
      awake: kind === "princess"
    };
  };
  const la = towerLevel(deckA);
  const lb = towerLevel(deckB);
  const mirror = (y) => ARENA_H - y;
  return [
    mk(0, "princess", 0, BRIDGE_X[0], fp(6), la),
    mk(0, "princess", 1, BRIDGE_X[1], fp(6), la),
    mk(0, "king", -1, fp(9), fp(2.5), la),
    mk(1, "princess", 0, BRIDGE_X[0], mirror(fp(6)), lb),
    mk(1, "princess", 1, BRIDGE_X[1], mirror(fp(6)), lb),
    mk(1, "king", -1, fp(9), mirror(fp(2.5)), lb)
  ];
}
function shuffledCycle(rng) {
  const c = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = c.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const t = c[i];
    c[i] = c[j];
    c[j] = t;
  }
  return c;
}
function createMatch(seed, decks, format = FORMATS.standard) {
  if (decks[0].length !== DECK_SIZE || decks[1].length !== DECK_SIZE) {
    throw new Error("decks must have exactly 8 cards");
  }
  const withTraits = (deck) => deck.map((c) => c.trait === void 0 ? { ...c, trait: traitForMint(c.coinId) } : c);
  const rng = new XorShift32(seed);
  const players = [
    { elixirFP: format.startElixirFP, deck: withTraits(decks[0]), cycle: shuffledCycle(rng) },
    { elixirFP: format.startElixirFP, deck: withTraits(decks[1]), cycle: shuffledCycle(rng) }
  ];
  return {
    tick: 0,
    format,
    phase: "regulation",
    winner: -1,
    units: [],
    towers: makeTowers(decks[0], decks[1]),
    spells: [],
    players,
    nextUnitId: 1,
    rngState: rng.state()
  };
}
function ownHalfClamp(player, xIn, yIn) {
  const x = clampInt(xIn, fp(0.5), ARENA_W - fp(0.5));
  const y = player === 0 ? clampInt(yIn, fp(0.5), RIVER_TOP - fp(0.5)) : clampInt(yIn, RIVER_BOT + fp(0.5), ARENA_H - fp(0.5));
  return [x, y];
}
function applyInput(state, ev) {
  const p = state.players[ev.player];
  const deckIdx = ev.deckIndex;
  if (deckIdx < 0 || deckIdx >= DECK_SIZE) return;
  if (p.cycle.indexOf(deckIdx) >= HAND_SIZE) return;
  const card = p.deck[deckIdx];
  const def = effectiveDef(ARCHETYPES[card.archetype], card.trait, card.archetype);
  const cost = def.elixir * FP;
  if (p.elixirFP < cost) return;
  const [x, y] = card.archetype === Archetype.Spell ? [clampInt(ev.x, fp(0.5), ARENA_W - fp(0.5)), clampInt(ev.y, fp(0.5), ARENA_H - fp(0.5))] : ownHalfClamp(ev.player, ev.x, ev.y);
  p.elixirFP -= cost;
  p.cycle.splice(p.cycle.indexOf(deckIdx), 1);
  p.cycle.push(deckIdx);
  if (card.archetype === Archetype.Spell) {
    state.spells.push({
      owner: ev.player,
      x,
      y,
      explodeTick: state.tick + def.spellDelayTicks,
      level: card.level,
      cardIndex: deckIdx
    });
    return;
  }
  for (let i = 0; i < def.count; i++) {
    const [ox, oy] = SPAWN_OFFSETS[i % SPAWN_OFFSETS.length];
    const hp = scaleByLevel(def.hp, card.level);
    state.units.push({
      id: state.nextUnitId++,
      owner: ev.player,
      archetype: card.archetype,
      level: card.level,
      x: clampInt(x + ox, fp(0.5), ARENA_W - fp(0.5)),
      y: clampInt(y + oy, fp(0.5), ARENA_H - fp(0.5)),
      hp,
      maxHp: hp,
      cooldown: 0,
      targetUnit: -1,
      targetTower: -1,
      state: "advance",
      trait: card.trait,
      cardIndex: deckIdx
    });
  }
}
function sortInputs(inputs) {
  return [...inputs].sort((a, b) => a.player - b.player || a.deckIndex - b.deckIndex || a.x - b.x || a.y - b.y);
}
function nearestEnemyUnit(state, u, radius) {
  let best = -1;
  let bestD = radius + 1;
  for (const e of state.units) {
    if (e.owner === u.owner || e.hp <= 0) continue;
    const d = fpDist(u.x, u.y, e.x, e.y);
    if (d < bestD || d === bestD && best !== -1 && e.id < best) {
      bestD = d;
      best = e.id;
    }
  }
  return best;
}
function towerAlive(state, idx) {
  return state.towers[idx].hp > 0;
}
function pickTargetTower(state, u) {
  const enemyBase = u.owner === 0 ? 3 : 0;
  const lane = u.x < fp(9) ? 0 : 1;
  const princessIdx = enemyBase + lane;
  if (towerAlive(state, princessIdx)) return princessIdx;
  const kingIdx = enemyBase + 2;
  if (towerAlive(state, kingIdx)) return kingIdx;
  const otherPrincess = enemyBase + (1 - lane);
  return towerAlive(state, otherPrincess) ? otherPrincess : kingIdx;
}
function needsBridge(u, targetY) {
  return u.owner === 0 ? u.y < RIVER_TOP && targetY > RIVER_TOP : u.y > RIVER_BOT && targetY < RIVER_BOT;
}
function moveToward(u, txIn, tyIn, speed) {
  let tx = txIn;
  let ty = tyIn;
  if (needsBridge(u, tyIn)) {
    const lane = u.x < fp(9) ? 0 : 1;
    tx = BRIDGE_X[lane];
    ty = RIVER_MID;
  }
  if (u.y >= RIVER_TOP && u.y <= RIVER_BOT) {
    const lane = u.x < fp(9) ? 0 : 1;
    u.x = clampInt(u.x, BRIDGE_X[lane] - BRIDGE_HALF_W, BRIDGE_X[lane] + BRIDGE_HALF_W);
  }
  const d = fpDist(u.x, u.y, tx, ty);
  if (d === 0) return;
  const step = Math.min(speed, d);
  u.x += Math.floor(step * (tx - u.x) / d);
  u.y += Math.floor(step * (ty - u.y) / d);
}
function hasSupportAura(state, u) {
  for (const s of state.units) {
    if (s.owner !== u.owner || s.hp <= 0 || s.archetype !== Archetype.Support || s.id === u.id) continue;
    const def = ARCHETYPES[Archetype.Support];
    if (fpDist(u.x, u.y, s.x, s.y) <= def.auraFP) return true;
  }
  return false;
}
function dealSplash(state, owner, cx, cy, radius, damage) {
  for (const e of state.units) {
    if (e.owner === owner || e.hp <= 0) continue;
    if (fpDist(cx, cy, e.x, e.y) <= radius + UNIT_RADIUS) e.hp -= damage;
  }
}
function wakeKing(state, owner) {
  const king = state.towers[owner === 0 ? 2 : 5];
  king.awake = true;
}
function damageTower(state, idx, dmg) {
  const t = state.towers[idx];
  if (t.hp <= 0) return;
  t.hp -= dmg;
  if (t.kind === "king") t.awake = true;
  if (t.hp <= 0) {
    t.hp = 0;
    if (t.kind === "princess") wakeKing(state, t.owner);
  }
}
function stepUnits(state) {
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    const def = effectiveDef(ARCHETYPES[u.archetype], u.trait, u.archetype);
    if (u.cooldown > 0) u.cooldown--;
    let target;
    if (u.targetUnit !== -1) {
      target = state.units.find((e) => e.id === u.targetUnit && e.hp > 0);
      if (target && fpDist(u.x, u.y, target.x, target.y) > def.aggroFP + fp(1)) target = void 0;
    }
    if (!target) {
      const id = nearestEnemyUnit(state, u, def.aggroFP);
      target = id === -1 ? void 0 : state.units.find((e) => e.id === id);
      u.targetUnit = target ? target.id : -1;
    }
    if (target) {
      const d2 = fpDist(u.x, u.y, target.x, target.y);
      if (d2 <= def.rangeFP + 2 * UNIT_RADIUS) {
        u.state = "attack";
        if (u.cooldown === 0) {
          const dmg = scaleByLevel(def.damage, u.level);
          if (def.splashFP > 0) dealSplash(state, u.owner, target.x, target.y, def.splashFP, dmg);
          else target.hp -= dmg;
          const buffed = hasSupportAura(state, u);
          u.cooldown = buffed ? Math.floor(def.hitTicks * AURA_SPEED_NUM / AURA_SPEED_DEN) : def.hitTicks;
        }
      } else {
        u.state = "advance";
        moveToward(u, target.x, target.y, def.speedFP);
      }
      continue;
    }
    const ti = pickTargetTower(state, u);
    u.targetTower = ti;
    const t = state.towers[ti];
    const d = fpDist(u.x, u.y, t.x, t.y);
    if (d <= def.rangeFP + TOWER_RADIUS[t.kind] + UNIT_RADIUS) {
      u.state = "attack";
      if (u.cooldown === 0) {
        damageTower(state, ti, scaleByLevel(def.damage, u.level));
        const buffed = hasSupportAura(state, u);
        u.cooldown = buffed ? Math.floor(def.hitTicks * AURA_SPEED_NUM / AURA_SPEED_DEN) : def.hitTicks;
      }
    } else {
      u.state = "advance";
      moveToward(u, t.x, t.y, def.speedFP);
    }
  }
}
function stepTowers(state) {
  for (const t of state.towers) {
    if (t.hp <= 0) continue;
    if (t.cooldown > 0) t.cooldown--;
    if (t.kind === "king" && !t.awake) continue;
    const base = t.kind === "princess" ? PRINCESS : KING;
    let best;
    let bestD = base.rangeFP + UNIT_RADIUS + 1;
    for (const e of state.units) {
      if (e.owner === t.owner || e.hp <= 0) continue;
      const d = fpDist(t.x, t.y, e.x, e.y);
      if (d < bestD || d === bestD && best && e.id < best.id) {
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
function towerLevelOf(state, t) {
  return towerLevel(state.players[t.owner].deck);
}
function stepSpells(state) {
  const remaining = [];
  for (const s of state.spells) {
    if (state.tick < s.explodeTick) {
      remaining.push(s);
      continue;
    }
    const def = ARCHETYPES[Archetype.Spell];
    const dmg = scaleByLevel(def.damage, s.level);
    dealSplash(state, s.owner, s.x, s.y, def.splashFP, dmg);
    const towerDmg = Math.floor(dmg * SPELL_TOWER_DAMAGE_PCT / 100);
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
function aliveTowerCount(state, owner) {
  let n = 0;
  for (const t of state.towers) if (t.owner === owner && t.hp > 0) n++;
  return n;
}
function totalTowerHp(state, owner) {
  let n = 0;
  for (const t of state.towers) if (t.owner === owner) n += t.hp;
  return n;
}
function checkEnd(state, towersBefore) {
  if (state.towers[2].hp <= 0) {
    state.phase = "ended";
    state.winner = 1;
    return;
  }
  if (state.towers[5].hp <= 0) {
    state.phase = "ended";
    state.winner = 0;
    return;
  }
  if (state.phase === "overtime") {
    const a = aliveTowerCount(state, 0);
    const b = aliveTowerCount(state, 1);
    if (a < towersBefore[0]) {
      state.phase = "ended";
      state.winner = 1;
      return;
    }
    if (b < towersBefore[1]) {
      state.phase = "ended";
      state.winner = 0;
      return;
    }
    if (state.tick >= state.format.regulationTicks + state.format.overtimeTicks) {
      const hpA = totalTowerHp(state, 0);
      const hpB = totalTowerHp(state, 1);
      state.phase = "ended";
      state.winner = hpA === hpB ? -2 : hpA > hpB ? 0 : 1;
    }
    return;
  }
  if (state.tick >= state.format.regulationTicks) {
    const a = aliveTowerCount(state, 0);
    const b = aliveTowerCount(state, 1);
    if (a !== b) {
      state.phase = "ended";
      state.winner = a > b ? 0 : 1;
    } else if (state.format.overtimeTicks > 0) {
      state.phase = "overtime";
    } else {
      const hpA = totalTowerHp(state, 0);
      const hpB = totalTowerHp(state, 1);
      state.phase = "ended";
      state.winner = hpA === hpB ? -2 : hpA > hpB ? 0 : 1;
    }
  }
}
function doubleElixirActive(state) {
  return state.phase === "overtime" || state.tick >= state.format.doubleElixirAt;
}
function stepSim(state, inputs) {
  if (state.phase === "ended") return;
  const towersBefore = [aliveTowerCount(state, 0), aliveTowerCount(state, 1)];
  const gain = doubleElixirActive(state) ? state.format.elixirPerTickFP * 2 : state.format.elixirPerTickFP;
  for (const p of state.players) {
    p.elixirFP = Math.min(state.format.elixirCapFP, p.elixirFP + gain);
  }
  for (const ev of sortInputs(inputs)) {
    if (ev.tick === state.tick) applyInput(state, ev);
  }
  stepSpells(state);
  stepUnits(state);
  stepTowers(state);
  if (state.units.some((u) => u.hp <= 0)) {
    state.units = state.units.filter((u) => u.hp > 0);
  }
  checkEnd(state, towersBefore);
  state.tick++;
}
function hashState(state) {
  const h = new Fnv1a();
  h.int(state.tick).int(state.rngState).int(state.winner + 3);
  h.int(state.phase === "regulation" ? 0 : state.phase === "overtime" ? 1 : 2);
  h.int(state.nextUnitId);
  for (const p of state.players) {
    h.int(p.elixirFP);
    for (const c of p.cycle) h.int(c);
  }
  for (const u of state.units) {
    h.int(u.id).int(u.owner).int(u.archetype).int(u.x).int(u.y).int(u.hp).int(u.cooldown).int(u.maxHp).int(u.level).int(u.trait).int(u.targetUnit).int(u.targetTower).int(u.state === "advance" ? 0 : 1);
  }
  for (const t of state.towers) {
    h.int(t.hp).int(t.cooldown).int(t.awake ? 1 : 0);
  }
  for (const s of state.spells) {
    h.int(s.owner).int(s.x).int(s.y).int(s.explodeTick).int(s.level);
  }
  return h.digest();
}
export {
  FORMATS,
  createMatch,
  hashState,
  stepSim
};
