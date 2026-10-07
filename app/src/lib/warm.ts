import { coinByMint } from './coins';

/**
 * Pull the battle chunk in before the battle needs it.
 *
 * `Battle` is lazily imported, and it carries three.js — 918 KB that does not
 * begin downloading until the route commits, which is the same instant the
 * match clock starts. On a cold cache the canvas element does not even exist
 * for several seconds while that chunk arrives and parses, so the player
 * watches a dark rectangle and a running timer.
 *
 * Queueing already spends up to twenty seconds waiting for an opponent. The
 * chunk is going to be fetched either way; fetching it there costs nothing and
 * means the scene mounts on the frame the match starts.
 *
 * Fire-and-forget: this is a warm-up, and a failed prefetch must not stop a
 * match. The lazy import runs again on navigation and will surface any real
 * error there, where there is a boundary to catch it.
 */
export function warmBattleChunk(): void {
  void import('../screens/Battle').catch(() => { /* the route import retries */ });
}

/**
 * Pull a match's card art into cache before the match needs it.
 *
 * # Why this exists
 *
 * The arena used to spend fifteen to twenty-five seconds of a three-minute
 * match clock building itself. Not the textures — those are canvas-drawn and
 * total under 3ms — but the fighter art: sixteen images (both decks), fetched
 * and decoded on the main thread at the exact moment the simulation started
 * ticking. The clock cannot wait for them, because both clients run the same
 * lockstep sim from a server-set start, so the cost came straight out of play.
 *
 * Queueing is dead time that already exists — twenty seconds of it before the
 * bot fallback fires. Spending it on the fetch that was going to happen anyway
 * is free.
 *
 * `decode()` rather than just `new Image().src`: setting `src` gets the bytes,
 * but the *decode* is the expensive half and it would otherwise still land on
 * the first frame. Awaiting decode moves it off that frame entirely.
 *
 * Deliberately silent and deliberately not awaited by callers. A warm cache is
 * an optimisation, and an optimisation that can fail a match is a bug — a
 * missing file, a decode error or an offline cache all end here as a shrug,
 * and the scene falls back to the round badge exactly as it did before.
 */
export function warmMatchArt(mints: readonly string[]): void {
  const urls = new Set<string>();
  for (const mint of mints) {
    const coin = coinByMint(mint);
    if (coin?.cardArt) urls.add(coin.cardArt);
    if (coin?.logoUrl) urls.add(coin.logoUrl);
  }

  for (const url of urls) {
    try {
      const img = new Image();
      // Same-origin art, but stating it keeps the cached entry usable from the
      // WebGL texture upload rather than tainting it.
      img.crossOrigin = 'anonymous';
      img.src = url;
      void img.decode().catch(() => { /* the badge fallback covers this */ });
    } catch { /* no Image in this environment — nothing to warm */ }
  }
}
