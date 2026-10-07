/**
 * Tiny audio bus. Preloads a small pool per sound so rapid-fire hits don't
 * cut each other off, respects a persisted mute, and never throws when the
 * browser blocks autoplay before the first gesture.
 */
export type Sfx =
  | 'deploy' | 'hit' | 'tower' | 'victory' | 'defeat' | 'coin'
  | 'click' | 'chestOpen' | 'reward' | 'error';

const FILES: Record<Sfx, string> = {
  deploy: '/sfx/sfx_deploy.mp3',
  hit: '/sfx/sfx_hit.mp3',
  tower: '/sfx/sfx_tower.mp3',
  victory: '/sfx/sfx_victory.mp3',
  defeat: '/sfx/sfx_defeat.mp3',
  coin: '/sfx/sfx_coin.mp3',
  click: '/sfx/sfx_click.mp3',
  chestOpen: '/sfx/sfx_chest.mp3',
  reward: '/sfx/sfx_reward.mp3',
  error: '/sfx/sfx_error.mp3',
};

const VOLUME: Record<Sfx, number> = {
  deploy: 0.5, hit: 0.28, tower: 0.6, victory: 0.65, defeat: 0.55, coin: 0.45,
  click: 0.3, chestOpen: 0.6, reward: 0.6, error: 0.35,
};

const POOL_SIZE = 3;
const STORAGE_KEY = 'mempire.muted';

const pools = new Map<Sfx, HTMLAudioElement[]>();
const cursor = new Map<Sfx, number>();
let music: HTMLAudioElement | null = null;
let muted = false;
let ready = false;

try {
  muted = localStorage.getItem(STORAGE_KEY) === '1';
} catch { /* private mode — default to unmuted */ }

export const isMuted = (): boolean => muted;

export function setMuted(next: boolean): void {
  muted = next;
  try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  if (music) music.muted = next;
}

/** Build the pools once, lazily — cheap, and keeps first paint clean. */
export function initAudio(): void {
  if (ready) return;
  ready = true;
  (Object.keys(FILES) as Sfx[]).forEach((k) => {
    // Only the first voice preloads.
    //
    // Every voice used to set preload='auto', so each sound fired POOL_SIZE
    // simultaneous requests for the same file — before any of them had
    // returned, so none could serve the others from cache. The browser
    // cancelled the losers: ~34 aborted requests a session on desktop and 48
    // on mobile, each one a wasted MP3 round trip on the connection least able
    // to afford it.
    //
    // The rest load on first play, by which time voice zero has populated the
    // HTTP cache and they cost nothing. A pool exists so overlapping hits do
    // not cut each other off, not so the file arrives N times.
    const pool = Array.from({ length: POOL_SIZE }, (_, i) => {
      const a = new Audio(FILES[k]);
      a.preload = i === 0 ? 'auto' : 'none';
      a.volume = VOLUME[k];
      return a;
    });
    pools.set(k, pool);
    cursor.set(k, 0);
  });
}

export function play(name: Sfx): void {
  if (muted) return;
  initAudio();
  const pool = pools.get(name);
  if (!pool) return;
  const i = cursor.get(name) ?? 0;
  cursor.set(name, (i + 1) % pool.length);
  const el = pool[i];
  try {
    el.currentTime = 0;
    void el.play().catch(() => { /* autoplay blocked until first gesture */ });
  } catch { /* element busy — skip this hit rather than throw */ }
}

/**
 * UI click. Separate export because it is called from dozens of handlers and
 * reads better than play('click') at every call site. Also the gesture that
 * unblocks autoplay, so menu music is kicked off from here.
 */
export function click(): void {
  play('click');
  if (!music && !muted) startMenuMusic();
}

let currentTrack: string | null = null;

function startTrack(src: string, volume: number, loop = true): void {
  if (currentTrack === src && music) return; // already playing this one
  stopMusic();
  const a = new Audio(src);
  a.loop = loop;
  a.volume = volume;
  a.muted = muted;
  music = a;
  currentTrack = src;
  void a.play().catch(() => { /* blocked until a gesture; click() retries */ });
}

export function startMenuMusic(): void {
  startTrack('/sfx/music_menu.m4a', 0.16);
}

export function startMusic(src = '/sfx/music_battle.m4a', volume = 0.22): void {
  startTrack(src, volume);
}

export function stopMusic(): void {
  if (!music) return;
  music.pause();
  music.currentTime = 0;
  music = null;
  currentTrack = null;
}

/**
 * Has this document seen a real user gesture yet?
 *
 * Browsers refuse `navigator.vibrate` until the user has tapped, and refusing
 * it is not an exception — it is a console *intervention*, which a try/catch
 * cannot suppress. So a buzz fired by anything other than a tap (a match
 * starting, a chest landing, a card being dealt) printed an error nobody could
 * act on, once per call. Asking permission of the document is the fix; the
 * listeners retire themselves the first time they fire.
 */
let gestured = false;
if (typeof window !== 'undefined') {
  const seen = () => { gestured = true; };
  window.addEventListener('pointerdown', seen, { once: true, passive: true });
  window.addEventListener('keydown', seen, { once: true });
  window.addEventListener('touchend', seen, { once: true, passive: true });
}

/**
 * Short haptic tap on supported mobile browsers. Paired with click() at the
 * call sites that matter (deploy, collect, buy) rather than every button, so it
 * stays a signal instead of noise.
 */
export function buzz(ms = 12): void {
  if (muted || !gestured) return;
  try {
    navigator.vibrate?.(ms);
  } catch { /* unsupported */ }
}
