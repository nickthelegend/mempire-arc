/**
 * Turns a flat-background character render into a cut-out.
 *
 * Card art is generated on a solid chroma key (magenta — a colour that appears
 * nowhere in these palettes, so it can never be mistaken for part of a
 * character). One generation then serves two very different jobs:
 *
 *  - the **card frame** wants the character over its own coloured well
 *  - the **battlefield** wants a character standing on grass, with no rectangle
 *
 * Both need the background gone, so it is removed once here and cached.
 *
 * Keying runs on a flood fill from the borders rather than "delete every magenta
 * pixel". A global colour test punches holes through anything magenta *inside*
 * the character — a cape, a gem, a $POPKAT — and those holes are exactly the
 * artefact that makes AI-cut sprites look cheap. Only background connected to
 * the edge is removed.
 */

const cache = new Map<string, Promise<HTMLCanvasElement | null>>();

/** Distance in RGB space below which a pixel counts as the key colour. */
const TOLERANCE = 78;

/** The key: pure magenta. Absent from every palette in the prompt pack. */
const KEY = { r: 255, g: 0, b: 255 };

function isKey(d: Uint8ClampedArray, i: number): boolean {
  const dr = d[i] - KEY.r;
  const dg = d[i + 1] - KEY.g;
  const db = d[i + 2] - KEY.b;
  return dr * dr + dg * dg + db * db < TOLERANCE * TOLERANCE;
}

/**
 * Removes the keyed background, feathers the resulting edge, and returns a
 * canvas — or null when the image is not keyed at all, so callers can fall back
 * to using it unmodified.
 */
async function key(url: string): Promise<HTMLCanvasElement | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const loaded = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
  if (!loaded) return null;

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);

  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;

  // If the corners are not the key colour this render was not made for keying
  // (an older asset, or the round coin badge). Leave it exactly as it is.
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
  if (!corners.every((i) => isKey(d, i))) return null;

  // Flood fill inward from every border pixel. Anything the fill cannot reach
  // is interior and stays, holes in the character included.
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * w + x;
    if (seen[p]) return;
    if (!isKey(d, p * 4)) return;
    seen[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x += 1) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += 1) { push(0, y); push(w - 1, y); }

  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    d[p * 4 + 3] = 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  // Feather: any surviving pixel touching a cleared one gets partial alpha and
  // its key-coloured fringe pulled out. Without this the cut edge is a hard
  // stair-step and picks up a magenta halo at small sizes.
  const alpha = new Uint8ClampedArray(w * h);
  for (let p = 0; p < w * h; p += 1) alpha[p] = d[p * 4 + 3];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (alpha[p] === 0) continue;
      let cleared = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (alpha[ny * w + nx] === 0) cleared += 1;
        }
      }
      if (cleared > 0) {
        d[p * 4 + 3] = Math.round(255 * (1 - cleared / 9));
        // de-fringe: bias the edge pixel away from the key colour
        d[p * 4 + 1] = Math.max(d[p * 4 + 1], Math.min(d[p * 4], d[p * 4 + 2]) - 6);
      }
    }
  }

  ctx.putImageData(id, 0, 0);
  return c;
}

/** Keyed canvas for a URL, or null if it needs no keying. Cached per URL. */
export function keyedCanvas(url: string): Promise<HTMLCanvasElement | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = key(url).catch(() => null);
  cache.set(url, p);
  return p;
}

/** Keyed image as a blob URL, for DOM image elements that cannot take a canvas. */
const urlCache = new Map<string, Promise<string | null>>();

export function keyedUrl(src: string): Promise<string | null> {
  const hit = urlCache.get(src);
  if (hit) return hit;
  const p = keyedCanvas(src).then((c) => (
    c ? new Promise<string | null>((resolve) => {
      c.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null), 'image/png');
    }) : null
  )).catch(() => null);
  urlCache.set(src, p);
  return p;
}
