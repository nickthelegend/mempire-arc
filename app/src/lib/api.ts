/**
 * Where the backend lives — resolved once, for every caller.
 *
 * The four API clients each used to default to `http://localhost:8787`. That is
 * right in development and actively wrong anywhere else: on a deployed HTTPS
 * page, `localhost` is the *visitor's* machine, so every leaderboard poll,
 * clan fetch, save and matchmaking socket opened a connection to a port on
 * their laptop. Browsers block the mixed content, the console fills with
 * failures, and the WebSocket retries forever against a host that will never
 * answer.
 *
 * So the fallback is deliberately narrow: use the configured URL; use localhost
 * only when the page is itself served from localhost; otherwise report that
 * there is no backend and let callers skip the request entirely. Every online
 * feature already degrades to local-only, so "no backend" is a supported state
 * rather than an error — this just stops the app pretending otherwise.
 */

const configured = (import.meta.env.VITE_API_URL as string | undefined)?.trim();

const onLocalhost = typeof window !== 'undefined'
  && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

/** The API origin, or null when this build has no backend to talk to. */
import { signAction } from './identity';

export const API_BASE: string | null = configured
  || (onLocalhost ? 'http://localhost:8787' : null);

/** True when online features (ladder, clans, sync, PvP) can work at all. */
export const hasApi = (): boolean => API_BASE !== null;

/**
 * `fetch` that resolves to null instead of throwing when there is no backend.
 *
 * Callers already treat a failed request as "stay local", so folding the
 * no-backend case into the same shape keeps every call site to one path.
 */
export async function apiFetch(
  path: string, init?: RequestInit,
): Promise<Response | null> {
  if (!API_BASE) return null;
  try {
    return await fetch(`${API_BASE}${path}`, init);
  } catch {
    return null;
  }
}

/**
 * A signed write.
 *
 * Every mutating route on the API demands an ed25519 signature over a
 * timestamped, per-action message — `action` here must match the one the route
 * is registered with, or the signature verifies against different bytes and
 * the server returns 401.
 *
 * Returns null both when there is no backend and when this identity cannot
 * sign, so a caller's existing "stay local" path covers both without a second
 * branch. It deliberately does NOT fall back to sending unsigned: that is a
 * guaranteed 401, and a silent 401 looks to a player like the game quietly
 * forgot their progress.
 */
export async function apiPost(
  path: string,
  action: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PUT' | 'PATCH' = 'POST',
): Promise<Response | null> {
  if (!API_BASE) return null;
  const { useWallet } = await import('../state/wallet');
  const w = useWallet.getState();
  if (!w.address) return null;
  const signed = await signAction(w.address, action);
  if (!signed) return null;
  return apiFetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, ...signed }),
  });
}

/** The matchmaker socket URL, or null when there is no backend. */
export function wsUrl(): string | null {
  if (!API_BASE) return null;
  return `${API_BASE.replace(/^http/, 'ws')}/ws`;
}
