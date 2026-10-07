// Staked USD (snapshotted) → card level 1–10 on a diminishing curve.
// Mirrors the onchain thresholds exactly.
export const LEVEL_THRESHOLDS_USD = [0, 10, 25, 50, 100, 200, 400, 800, 1600, 3200];

export function levelForUsd(usd: number): number {
  let lvl = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS_USD.length; i++) {
    if (usd >= LEVEL_THRESHOLDS_USD[i]) lvl = i + 1;
  }
  return Math.min(lvl, 10);
}

export function nextLevelAt(usd: number): { level: number; usd: number } | null {
  const lvl = levelForUsd(usd);
  if (lvl >= 10) return null;
  return { level: lvl + 1, usd: LEVEL_THRESHOLDS_USD[lvl] };
}

// Same table the sim uses — stat multiplier per level, per-mille.
export const LEVEL_MULT_PM = [0, 1000, 1200, 1283, 1346, 1400, 1447, 1490, 1529, 1566, 1600];
