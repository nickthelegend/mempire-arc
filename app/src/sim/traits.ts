import type { ArchetypeDef } from './archetypes';
import { Archetype } from './types';

/**
 * Card traits — the thing that makes $BTC and $DOGE not the same knight.
 *
 * Six archetypes across sixty-four cards means a tank is a tank is a tank. In
 * the game this borrows from, no two cards feel alike, and that is most of why
 * a deck feels like *yours*. A trait is the cheapest honest way to get there:
 * one modifier pair per card, applied on top of its archetype.
 *
 * # Derived, never stored
 *
 * A trait comes from the mint address by the same rule archetype does — FNV-1a
 * over the base58 string — so it is global, permanent, and identical for
 * everyone. Nobody rerolls, nobody's $BTC is faster than anybody else's, and
 * the chain does not have to store a byte for it. It is a *property of the
 * coin*, the same way its archetype is.
 *
 * The hash is reused with a different mixing constant rather than re-derived
 * from a different string. Taking `h % 6` for archetype and `(h / 6) % 6` for
 * trait would correlate the two — some archetypes could never roll some traits.
 * A second avalanche breaks that.
 *
 * # Every trait costs something
 *
 * Each one trades a stat for another, in per-mille integers so the simulation
 * stays integer-only and deterministic. There is no strictly-best trait, which
 * is what keeps sixty-four cards worth choosing between rather than ranking.
 */

export const Trait = {
  Swift: 0,
  Brutal: 1,
  Stalwart: 2,
  Relentless: 3,
  Farsighted: 4,
  Ironclad: 5,
} as const;
export type Trait = (typeof Trait)[keyof typeof Trait];

export interface TraitDef {
  name: string;
  /** One line, for the card sheet. Says the cost as plainly as the benefit. */
  blurb: string;
  /** Per-mille multipliers. 1000 = unchanged. */
  hpPm: number;
  damagePm: number;
  /** Lower is faster: applied to the archetype's ticks-between-hits. */
  hitTicksPm: number;
  speedPm: number;
  rangePm: number;
}

export const TRAITS: Record<Trait, TraitDef> = {
  [Trait.Swift]: {
    name: 'Swift',
    blurb: 'Crosses the bridge first. Folds if it meets anything there.',
    hpPm: 860, damagePm: 1000, hitTicksPm: 1000, speedPm: 1220, rangePm: 1000,
  },
  [Trait.Brutal]: {
    name: 'Brutal',
    blurb: 'Hits like a truck, on a truck’s schedule.',
    hpPm: 1000, damagePm: 1240, hitTicksPm: 1180, speedPm: 1000, rangePm: 1000,
  },
  [Trait.Stalwart]: {
    name: 'Stalwart',
    blurb: 'Soaks a tower shot so the thing behind it does not.',
    hpPm: 1280, damagePm: 880, hitTicksPm: 1000, speedPm: 1000, rangePm: 1000,
  },
  [Trait.Relentless]: {
    name: 'Relentless',
    blurb: 'Never stops swinging. Never swings hard.',
    hpPm: 1000, damagePm: 870, hitTicksPm: 800, speedPm: 1000, rangePm: 1000,
  },
  [Trait.Farsighted]: {
    name: 'Farsighted',
    blurb: 'Opens fire before it is noticed. Dies if it is.',
    hpPm: 850, damagePm: 1000, hitTicksPm: 1000, speedPm: 1000, rangePm: 1220,
  },
  [Trait.Ironclad]: {
    name: 'Ironclad',
    blurb: 'Heavier in every sense, including the walk.',
    hpPm: 1120, damagePm: 1100, hitTicksPm: 1000, speedPm: 830, rangePm: 1000,
  },
};

export const TRAIT_NAMES = ['Swift', 'Brutal', 'Stalwart', 'Relentless', 'Farsighted', 'Ironclad'] as const;

/**
 * Deterministic coin → trait. Must match the onchain `trait_for_mint`.
 *
 * The extra avalanche is load-bearing: without it the trait would be a function
 * of the same six-way split the archetype already took, and the two would be
 * correlated rather than independent.
 */
export function traitForMint(mint: string): Trait {
  let h = 0x811c9dc5;
  for (let i = 0; i < mint.length; i++) {
    h ^= mint.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // xorshift finaliser, so trait and archetype read different bits.
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13;
  return ((h >>> 0) % 6) as Trait;
}

/** `base * pm / 1000`, floored — the sim's one scaling rule. */
export const applyPm = (base: number, pm: number): number =>
  Math.floor((base * pm) / 1000);

/**
 * A trait's effect on a spell is deliberately nothing.
 *
 * Spells have no hit points, no walk and no attack rate; four of the six
 * modifiers would be meaningless and the remaining two would quietly make some
 * spell coins strictly better than others. A spell is its archetype.
 */
export const traitAppliesTo = (archetype: Archetype): boolean =>
  archetype !== Archetype.Spell;

/**
 * An archetype's stats with a card's trait folded in.
 *
 * Returned as a fresh object rather than mutating `ARCHETYPES`, which is shared
 * and must stay the untouched baseline — a trait that leaked into the table
 * would apply to every card of that archetype and desync the two clients the
 * moment one of them computed it in a different order.
 *
 * Order matters and is fixed: trait first, then level. Levelling a trait-boosted
 * stat and trait-boosting a levelled one differ by a floor, and a one-point
 * divergence in hit points is a divergent state hash.
 */
export function effectiveDef(def: ArchetypeDef, trait: Trait, archetype: Archetype): ArchetypeDef {
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
    rangeFP: applyPm(def.rangeFP, t.rangePm),
  };
}
