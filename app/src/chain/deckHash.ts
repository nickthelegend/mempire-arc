/**
 * The deck commitment stored in the match account.
 *
 * Both players commit a hash of their deck before either sees the other's, which
 * is what stops a deck being swapped after the matchup is known. The program
 * stores it opaquely — it cannot recompute sha256 cheaply — so the commitment is
 * only worth anything if the client derives it the same way every time and the
 * reveal is checked against it at settlement.
 *
 * Card ids are hashed in deck order, because deck order is part of what is being
 * committed: the sim's opening cycle depends on it.
 */

const enc = new TextEncoder();

/** Hex, for logging and for the reveal payload sent to the API. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * sha256 over `mempire:v1|<id>,<id>,…|<salt>`.
 *
 * The salt is the player's address: without it, two players running the same
 * deck would publish an identical commitment and leak the matchup.
 */
export async function deckCommitment(cardIds: number[], salt: string): Promise<Uint8Array> {
  const payload = `mempire:v1|${cardIds.join(',')}|${salt}`;
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(payload));
  return new Uint8Array(digest);
}

/** Verifies a revealed deck against a stored commitment. */
export async function verifyCommitment(
  commitment: Uint8Array, cardIds: number[], salt: string,
): Promise<boolean> {
  const expected = await deckCommitment(cardIds, salt);
  if (expected.length !== commitment.length) return false;
  // constant-time-ish: compare every byte regardless of early mismatch
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ commitment[i];
  return diff === 0;
}

/**
 * The match seed both clients derive from the two commitments.
 *
 * XOR is order-independent on purpose — neither player's commitment gets to be
 * "first", so neither can grind a favourable seed by choosing when to join.
 */
export function seedFromCommitments(a: Uint8Array, b: Uint8Array): number {
  let seed = 0;
  for (let i = 0; i < 4; i += 1) {
    seed = ((seed << 8) | ((a[i] ^ b[i]) & 0xff)) >>> 0;
  }
  // xorshift32 stalls permanently on a zero state
  return seed === 0 ? 0x9e3779b9 : seed;
}
