// FNV-1a 32-bit over the sim's integer fields. Checkpointed on chain by
// MempireArena.checkpoint; a mismatch between clients voids the match.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export class Fnv1a {
  private h = FNV_OFFSET;

  int(v: number): this {
    // mix 32 bits, byte by byte
    let x = v >>> 0;
    for (let i = 0; i < 4; i++) {
      this.h ^= x & 0xff;
      this.h = Math.imul(this.h, FNV_PRIME) >>> 0;
      x >>>= 8;
    }
    return this;
  }

  digest(): number {
    return this.h >>> 0;
  }
}
