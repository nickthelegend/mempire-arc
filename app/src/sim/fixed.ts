// Fixed-point math for the lockstep sim. 1 tile = FP units. Integer-only:
// identical results on every JS engine, hashable, and cheap to verify onchain.
export const FP = 1024;

export const fp = (tiles: number): number => Math.round(tiles * FP);

export const fpMul = (a: number, b: number): number => Math.floor((a * b) / FP);

export const fpDiv = (a: number, b: number): number => Math.floor((a * FP) / b);

// Integer sqrt (Newton). Input/output plain ints.
export function isqrt(n: number): number {
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

// Distance between two fp points, result in fp units.
export function fpDist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return isqrt(dx * dx + dy * dy);
}

export const clampInt = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
