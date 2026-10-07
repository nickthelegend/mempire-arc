/**
 * The Android shell, when there is one.
 *
 * The same build serves the browser and the WebView inside the Android app, so
 * everything here is a no-op unless the shell planted `window.MempireNative`.
 * Nothing calls this expecting it to work — a browser genuinely cannot wake
 * itself when a chest finishes, and pretending otherwise would mean a promise
 * the web version silently breaks.
 */

interface NativeBridge {
  platform: 'android';
  version: number;
  notify(title: string, body: string, afterSeconds: number, tag?: string): void;
  cancelNotification(tag: string): void;
  ready(): void;
}

declare global {
  interface Window { MempireNative?: NativeBridge }
}

/** Whether this session is running inside the Android app. */
export const isNative = (): boolean => typeof window !== 'undefined' && !!window.MempireNative;

/**
 * Ask to be reminded, later, about something that is not ready yet.
 *
 * `tag` is required rather than optional so every reminder can be cancelled:
 * a chest that is opened early must not still ring an hour later, and a
 * notification you cannot withdraw is worse than one you never scheduled.
 */
export function remind(tag: string, title: string, body: string, afterSeconds: number): void {
  if (!window.MempireNative || afterSeconds <= 0) return;
  try {
    window.MempireNative.notify(title, body, Math.round(afterSeconds), tag);
  } catch { /* the shell is not a dependency */ }
}

/** Withdraw a reminder that is no longer true. */
export function forget(tag: string): void {
  try { window.MempireNative?.cancelNotification(tag); } catch { /* as above */ }
}

/**
 * Tell the shell the game has painted.
 *
 * The splash sits over a black WebView until this fires. The shell has its own
 * timeout so a failure here cannot strand it, but that fallback shows the
 * splash for longer than it needs to be — this is the fast path.
 */
export function signalReady(): void {
  try { window.MempireNative?.ready(); } catch { /* as above */ }
}
