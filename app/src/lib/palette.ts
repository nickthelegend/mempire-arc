/**
 * The design tokens as literals, for consumers that cannot read CSS custom
 * properties — Three.js materials and canvas work. Values must stay identical
 * to `src/styles/tokens.css`; DESIGN.md is the authority for both.
 */
export const PALETTE = {
  void: '#08060f',
  surface: '#110d1c',
  raised: '#191327',
  border: '#2a2140',
  purple: '#9945ff',
  teal: '#14f195',
  gold: '#f0b90b',
  goldHi: '#ffd75e',
  goldDeep: '#8a6a06',
  red: '#ff4d6d',
  text: '#f4f1fb',
  dim: '#8e85a8',
} as const;

/** Arena-only material colours, derived from the world above. */
export const ARENA = {
  ground: '#221a3e',
  grid: '#332757',
  river: '#0b3f38',
  bridge: '#7a5f33',
  towerOwn: '#4a3d85',
  towerEnemy: '#6d3558',
  hpTrack: '#0a0812',
  tintOwn: '#b088ff',
  tintEnemy: '#ff7a8a',
} as const;
