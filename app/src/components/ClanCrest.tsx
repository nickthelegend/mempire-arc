/**
 * Clan crests, composed rather than uploaded.
 *
 * Four small integers (shape, emblem, hue, tone) give 6 × 12 × 360 × 3 ≈ 78,000
 * distinct crests. That beats generated bitmaps on every axis that matters here:
 * infinite variety, nothing to store or upload, no moderation queue for images,
 * and crisp at 22px in a list or 96px in a header. The server stores the same
 * four integers, so a crest is four bytes of state rather than an asset.
 *
 * Drawn as inline SVG so the crest inherits the page's own gold and ink tokens
 * and stays sharp on any display.
 */

export interface Crest {
  shape: number;
  emblem: number;
  hue: number;
  tone: number;
}

/** Shield outlines — the silhouette a clan is recognised by across the app. */
const SHAPES = [
  // heater
  'M50 4 L92 18 C92 58 78 84 50 96 C22 84 8 58 8 18 Z',
  // rounded
  'M50 4 C78 4 92 12 92 12 L92 54 C92 78 72 92 50 96 C28 92 8 78 8 54 L8 12 C8 12 22 4 50 4 Z',
  // pointed banner
  'M10 6 H90 V64 L50 96 L10 64 Z',
  // hex
  'M50 4 L88 24 V72 L50 96 L12 72 V24 Z',
  // square-cut
  'M12 8 H88 V70 C88 84 70 94 50 96 C30 94 12 84 12 70 Z',
  // spade
  'M50 4 C74 20 92 36 92 58 C92 80 72 96 50 96 C28 96 8 80 8 58 C8 36 26 20 50 4 Z',
];

/**
 * Emblems as compact paths on a 100×100 field, centred on the shield face.
 * Deliberately blunt silhouettes — at 22px in a roster row, detail is noise.
 */
const EMBLEMS = [
  // crown
  'M28 62 L24 36 L37 46 L50 30 L63 46 L76 36 L72 62 Z',
  // skull
  'M50 26 C64 26 74 36 74 50 C74 58 70 63 66 66 L66 74 H34 V66 C30 63 26 58 26 50 C26 36 36 26 50 26 Z M39 48 A5 5 0 1 0 39 47.9 M61 48 A5 5 0 1 0 61 47.9',
  // crossed swords
  'M26 30 L34 26 L74 66 L70 74 Z M74 30 L66 26 L26 66 L30 74 Z',
  // rocket
  'M50 24 C58 34 62 46 62 56 L62 70 H38 V56 C38 46 42 34 50 24 Z M32 62 L38 52 V72 Z M68 62 L62 52 V72 Z',
  // coin stack
  'M28 60 A22 8 0 1 0 72 60 A22 8 0 1 0 28 60 Z M28 48 A22 8 0 1 0 72 48 A22 8 0 1 0 28 48 Z M28 36 A22 8 0 1 0 72 36 A22 8 0 1 0 28 36 Z',
  // flame
  'M50 22 C58 38 70 44 70 58 C70 71 61 78 50 78 C39 78 30 71 30 58 C30 44 42 38 50 22 Z',
  // fang
  'M30 28 H70 L62 54 L50 76 L38 54 Z',
  // eye
  'M20 50 C32 34 68 34 80 50 C68 66 32 66 20 50 Z M50 42 A8 8 0 1 0 50 41.9',
  // bolt
  'M56 22 L34 54 H48 L44 78 L68 44 H52 Z',
  // anchor / diamond
  'M50 24 L70 50 L50 76 L30 50 Z',
  // paw
  'M50 46 A12 12 0 1 0 50 45.9 M30 38 A7 7 0 1 0 30 37.9 M70 38 A7 7 0 1 0 70 37.9 M38 66 A9 9 0 1 0 38 65.9 M62 66 A9 9 0 1 0 62 65.9',
  // tower
  'M34 34 H42 V40 H50 V34 H58 V40 H66 V74 H34 Z',
];

export const CREST_SHAPES = SHAPES.length;
export const CREST_EMBLEMS = EMBLEMS.length;

/** Tone shifts the face's lightness so two same-hue clans still differ. */
const TONES = [
  { top: 52, bottom: 30 },
  { top: 66, bottom: 42 },
  { top: 38, bottom: 20 },
];

export const DEFAULT_CREST: Crest = { shape: 0, emblem: 0, hue: 212, tone: 0 };

/** Keeps a crest from the server inside the ranges the renderer expects. */
export function safeCrest(c?: Partial<Crest> | null): Crest {
  const n = (v: unknown, mod: number, fallback: number) => {
    const i = Number(v);
    return Number.isFinite(i) && i >= 0 ? Math.floor(i) % mod : fallback;
  };
  return {
    shape: n(c?.shape, CREST_SHAPES, 0),
    emblem: n(c?.emblem, CREST_EMBLEMS, 0),
    hue: n(c?.hue, 360, DEFAULT_CREST.hue),
    tone: n(c?.tone, TONES.length, 0),
  };
}

export function ClanCrest({
  crest, size = 40, title,
}: { crest?: Partial<Crest> | null; size?: number; title?: string }) {
  const c = safeCrest(crest);
  const tone = TONES[c.tone];
  // Unique gradient ids per crest, or two crests on one screen share a fill.
  const gid = `cg_${c.shape}_${c.hue}_${c.tone}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ display: 'block', flexShrink: 0, filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.5))' }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`hsl(${c.hue} 62% ${tone.top}%)`} />
          <stop offset="100%" stopColor={`hsl(${c.hue} 58% ${tone.bottom}%)`} />
        </linearGradient>
        <linearGradient id={`${gid}_g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffe38a" />
          <stop offset="55%" stopColor="#ffc422" />
          <stop offset="100%" stopColor="#c58a06" />
        </linearGradient>
      </defs>

      {/* gold rim, then the face inset inside it */}
      <path d={SHAPES[c.shape]} fill={`url(#${gid}_g)`} stroke="#10203f" strokeWidth={5} />
      <path
        d={SHAPES[c.shape]}
        fill={`url(#${gid})`}
        stroke="rgba(0,0,0,.35)"
        strokeWidth={2}
        transform="translate(50 50) scale(0.82) translate(-50 -50)"
      />
      {/* top-edge sheen: the same bevel language as the buttons */}
      <path
        d={SHAPES[c.shape]}
        fill="none"
        stroke="rgba(255,255,255,.28)"
        strokeWidth={3}
        transform="translate(50 50) scale(0.74) translate(-50 -50)"
      />
      <path
        d={EMBLEMS[c.emblem]}
        fill={`url(#${gid}_g)`}
        stroke="#10203f"
        strokeWidth={3.5}
        strokeLinejoin="round"
        transform="translate(50 52) scale(0.72) translate(-50 -50)"
      />
    </svg>
  );
}
