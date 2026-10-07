import { apiPost } from './api';

/**
 * Send an analytics event.
 *
 * # Why the client sends any at all
 *
 * Most of what the funnel wants to know happens *on chain*, driven from here:
 * a card is minted, a stake is escrowed. The server never sees those — they go
 * straight from the browser to Monad — so a purely server-side trail would
 * have a hole exactly where the interesting steps are. The dashboard shipped
 * with a five-step funnel of which three steps nothing emitted, which is worse
 * than four honest steps.
 *
 * # Rules it follows
 *
 * - **Never blocks.** Fire-and-forget, errors swallowed. A dropped event is a
 *   gap in a chart; a failed mint because analytics timed out is a lost player.
 * - **Never carries anything private.** The wallet address comes from the
 *   signature the API already requires; props are counts and enums only.
 * - **Batched.** Events queue for a moment and go together, so a burst of eight
 *   card mints is one request rather than eight.
 */

interface Event {
  type: string;
  props?: Record<string, unknown>;
}

let queue: Event[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** How long to hold events before sending. Long enough to batch a deck mint. */
const FLUSH_MS = 1500;

function flush(): void {
  timer = null;
  if (!queue.length) return;
  const batch = queue.slice(0, 20);
  queue = queue.slice(20);
  void apiPost('/api/events', 'events', { events: batch }).catch(() => {
    /* analytics is never allowed to surface to a player */
  });
  if (queue.length) timer = setTimeout(flush, FLUSH_MS);
}

export function track(type: string, props?: Record<string, unknown>): void {
  // A runaway caller must not grow this without bound; the tail is the least
  // interesting part of a burst anyway.
  if (queue.length > 50) return;
  queue.push({ type, props });
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

/**
 * Send whatever is queued right now.
 *
 * Called when the page is being hidden: the batching window is long enough
 * that a player who mints and immediately closes the tab would otherwise lose
 * the event that proves they got that far.
 */
export function flushNow(): void {
  if (timer) clearTimeout(timer);
  flush();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
}
