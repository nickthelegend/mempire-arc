// xorshift32 — the deterministic match RNG.
//
// The seed is derived by the matchmaker from the match id XOR both players'
// deck hashes, so it is order-independent and neither client picks it alone.
//
// It is NOT commit-reveal, and this comment used to say it was. The difference
// matters: the server sees both deck hashes and chooses the match id, so a
// dishonest matchmaker could grind ids for a seed it likes. Every client-facing
// guarantee here rests on the lockstep hash check rather than on this seed —
// a divergence voids the match and refunds both stakes — but the seed itself is
// server-trusted until a real commit-reveal round replaces it.
export class XorShift32 {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let x = this.s;
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    this.s = x >>> 0;
    return this.s;
  }

  // [0, n)
  nextInt(n: number): number {
    return this.next() % n;
  }

  state(): number {
    return this.s;
  }
}
