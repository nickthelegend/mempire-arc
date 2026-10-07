import * as THREE from 'three';

/**
 * Arena textures drawn on a canvas rather than generated as images.
 *
 * A checkerboard has to be pixel-exact to read as a play grid — an AI texture
 * gives soft, irregular squares and a visible tile seam. Canvas gives crisp
 * edges, perfect tiling, and costs a few KB instead of a megabyte.
 *
 * Everything here is seeded rather than random. A board that reshuffles its
 * own grass between matches reads as unstable, and the same texture every run
 * is also the only way a screenshot of the arena is reproducible.
 */

function canvas(size: number, height = size): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return [c, ctx];
}

function finish(c: HTMLCanvasElement, repeat: [number, number]): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A small deterministic PRNG, so every texture is identical every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Checkered grass with mown stripes, blades and wildflowers.
 *
 * The old version was two flat greens and a speckle, which read as a spread-
 * sheet with a lawn colour. Three things fix that: the two checker tones are
 * pushed further apart so the grid is legible at a glance; each square gets
 * mown stripes at right angles to its neighbour, the way a real pitch is cut;
 * and a handful of flowers per tile give the eye something that is not a grid.
 */
export function grassTexture(): THREE.Texture {
  const S = 512;
  const [c, ctx] = canvas(S);
  const half = S / 2;
  const rnd = rng(1337);

  const TONES = [
    { base: '#79c94b', stripe: '#84d456' },
    { base: '#5faa39', stripe: '#68b542' },
  ];

  for (let sy = 0; sy < 2; sy++) {
    for (let sx = 0; sx < 2; sx++) {
      const tone = TONES[(sx + sy) % 2];
      const x0 = sx * half;
      const y0 = sy * half;
      ctx.fillStyle = tone.base;
      ctx.fillRect(x0, y0, half, half);

      // Mown stripes, turned 90° between neighbouring squares. This is what
      // makes a checkered pitch read as cut grass rather than as tiling.
      ctx.fillStyle = tone.stripe;
      const across = (sx + sy) % 2 === 0;
      for (let i = 0; i < 8; i += 2) {
        const o = (i / 8) * half;
        if (across) ctx.fillRect(x0, y0 + o, half, half / 8);
        else ctx.fillRect(x0 + o, y0, half / 8, half);
      }

      // blades: short strokes, denser near the square's edges
      ctx.globalAlpha = 0.22;
      for (let i = 0; i < 260; i++) {
        const x = x0 + rnd() * half;
        const y = y0 + rnd() * half;
        ctx.fillStyle = rnd() > 0.55 ? '#a8e878' : '#468c2a';
        ctx.fillRect(x, y, 1.6, 3.4);
      }
      ctx.globalAlpha = 1;

      // wildflowers — four per square, always the same four
      for (let i = 0; i < 4; i++) {
        const x = x0 + 10 + rnd() * (half - 20);
        const y = y0 + 10 + rnd() * (half - 20);
        const petal = ['#ffe27a', '#ffffff', '#ffb3e6', '#fff2b8'][i % 4];
        ctx.fillStyle = petal;
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#e0a020';
        ctx.beginPath();
        ctx.arc(x, y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // The seam between squares, drawn on all four so no square is missing one.
  ctx.strokeStyle = 'rgba(46,92,28,.34)';
  ctx.lineWidth = 2.5;
  for (let sy = 0; sy < 2; sy++) {
    for (let sx = 0; sx < 2; sx++) {
      ctx.strokeRect(sx * half + 1, sy * half + 1, half - 2, half - 2);
    }
  }

  return finish(c, [9, 16]); // one square per arena tile
}

/** Horizontal wood planks with dark seams and grain. */
export function woodTexture(repeat: [number, number] = [4, 1]): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  ctx.fillStyle = '#a9743a';
  ctx.fillRect(0, 0, S, S);

  const planks = 4;
  const h = S / planks;
  for (let i = 0; i < planks; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#b57f42' : '#9c6832';
    ctx.fillRect(0, i * h, S, h);
    ctx.strokeStyle = 'rgba(70,40,14,.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, i * h);
    ctx.lineTo(S, i * h);
    ctx.stroke();
  }

  const rnd = rng(99);
  ctx.globalAlpha = 0.2;
  ctx.strokeStyle = '#6d4519';
  ctx.lineWidth = 1;
  for (let i = 0; i < 90; i++) {
    const y = rnd() * S;
    ctx.beginPath();
    ctx.moveTo(rnd() * S, y);
    ctx.bezierCurveTo(S * 0.4, y + 3, S * 0.7, y - 3, S, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return finish(c, repeat);
}

/**
 * Water: a deep channel with a lit centre.
 *
 * The old texture was a flat cyan band with seven sine lines, which is
 * legible and completely dead. This one has depth — darker at the banks,
 * bright where the light hits mid-channel — plus wave crests at varying
 * amplitude so the surface does not read as a single repeating ripple.
 */
export function waterTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);

  // Deep at the banks, lit mid-channel. The values are darker than they look
  // on the canvas on purpose: the arena runs ambient at 2.1 and a sun at 2.3,
  // and a mid-cyan under that light comes out white.
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#05314f');
  g.addColorStop(0.16, '#08506f');
  g.addColorStop(0.5, '#0f7d9e');
  g.addColorStop(0.84, '#08506f');
  g.addColorStop(1, '#05314f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // crests, at three different frequencies so the loop is not obvious
  const rnd = rng(7);
  for (let i = 0; i < 11; i++) {
    const y = (i / 11) * S;
    const amp = 2 + rnd() * 5;
    const freq = 2 + Math.floor(rnd() * 4);
    const edge = Math.abs(y / S - 0.5) * 2; // fainter toward the banks
    ctx.strokeStyle = `rgba(190,240,255,${0.3 * (1 - edge * 0.7)})`;
    ctx.lineWidth = 1.5 + rnd() * 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= S; x += 8) {
      ctx.lineTo(x, y + Math.sin((x / S) * Math.PI * 2 * freq + i) * amp);
    }
    ctx.stroke();
  }

  return finish(c, [4, 1]);
}

/**
 * The caustics layer, laid over the water and scrolled the other way.
 *
 * One scrolling texture reads as a conveyor belt: every pixel travels at the
 * same speed in the same direction. Two layers moving differently is the
 * cheapest thing that reads as a moving surface rather than a moving image.
 */
export function causticTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  ctx.clearRect(0, 0, S, S);

  const rnd = rng(4242);
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineCap = 'round';
  for (let i = 0; i < 46; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 6 + rnd() * 18;
    ctx.lineWidth = 1 + rnd() * 2;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.3 + rnd() * 0.3), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.stroke();
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Cut stone, for the river banks and the tower platforms.
 *
 * The banks used to be a flat brown box, which is the one part of the board
 * that touches both the grass and the water and so is the seam everything
 * else is judged against.
 */
export function stoneTexture(repeat: [number, number] = [8, 1]): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  const rnd = rng(515);

  // Much darker than cut stone looks in daylight, on purpose. Ambient 2.1
  // plus a 2.3 sun multiplies everything here, and the first pass at #9aa3ae
  // came out pure white — which made the river read as a white strip with a
  // thin blue line down the middle.
  ctx.fillStyle = '#5c6672';
  ctx.fillRect(0, 0, S, S);

  const rows = 4;
  const h = S / rows;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (S / 8);
    for (let i = -1; i < 4; i++) {
      const x = offset + i * (S / 4);
      const shade = 0.82 + rnd() * 0.28;
      const v = (n: number) => Math.min(255, Math.round(n * shade));
      ctx.fillStyle = `rgb(${v(102)},${v(112)},${v(126)})`;
      ctx.fillRect(x + 2, r * h + 2, S / 4 - 4, h - 4);
      // top bevel, so each block catches the light
      ctx.fillStyle = 'rgba(255,255,255,.16)';
      ctx.fillRect(x + 2, r * h + 2, S / 4 - 4, 3);
      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.fillRect(x + 2, r * h + h - 5, S / 4 - 4, 3);
    }
  }

  // mortar
  ctx.strokeStyle = 'rgba(28,33,41,.7)';
  ctx.lineWidth = 2;
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * h);
    ctx.lineTo(S, r * h);
    ctx.stroke();
  }

  return finish(c, repeat);
}

/**
 * The meadow the arena stands in.
 *
 * Deliberately duller and darker than the playing field. The board is where
 * every decision happens and it has to stay the brightest thing on screen —
 * surrounding it with grass of the same saturation would put the arena and the
 * scenery in competition, and the scenery would win by area.
 *
 * No checker: the grid means "this is where units walk", and repeating it
 * outside the frame says the opposite of what the frame says.
 */
export function meadowTexture(): THREE.Texture {
  const S = 512;
  const [c, ctx] = canvas(S);
  const rnd = rng(8081);

  ctx.fillStyle = '#3d7a2c';
  ctx.fillRect(0, 0, S, S);

  // broad patches, so the ground is not one flat colour at distance
  for (let i = 0; i < 26; i++) {
    ctx.globalAlpha = 0.16 + rnd() * 0.16;
    ctx.fillStyle = rnd() > 0.5 ? '#4a8f34' : '#2f6323';
    ctx.beginPath();
    ctx.ellipse(rnd() * S, rnd() * S, 40 + rnd() * 90, 26 + rnd() * 60, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // blades
  ctx.globalAlpha = 0.2;
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = rnd() > 0.5 ? '#61a944' : '#27541c';
    ctx.fillRect(rnd() * S, rnd() * S, 2, 4);
  }
  ctx.globalAlpha = 1;

  return finish(c, [26, 26]);
}

/**
 * The sky, as a gradient rather than a flat clear colour.
 *
 * A single background colour gives the board nothing to sit against — the
 * horizon does not exist, so the arena and everything around it float in a
 * void. A vertical ramp with a pale band at the bottom reads as distance, and
 * the fog is set to that same band so the ground fades into the sky instead of
 * ending at a hard line.
 */
export const HORIZON = '#cfe9ff';

export function skyTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(4, S);
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#1d63b8');    // zenith
  g.addColorStop(0.42, '#3f8fd8');
  g.addColorStop(0.74, '#8cc4ee');
  g.addColorStop(1, HORIZON);      // haze, matched to the fog
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, S);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // Clamped, not repeated: a wrapped gradient puts a hard seam at the zenith.
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** A soft round cloud, drawn once and billboarded. */
export function cloudTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S, S / 2);
  const rnd = rng(606);

  // Overlapping soft discs. A cloud is a silhouette, not a shape with edges.
  for (let i = 0; i < 14; i++) {
    const x = 30 + rnd() * (S - 60);
    const y = S / 4 + (rnd() - 0.5) * 34;
    const r = 22 + rnd() * 34;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,.95)');
    g.addColorStop(0.6, 'rgba(255,255,255,.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Weathered arena sand, for the floor between the board and the stands.
 *
 * Pale and low-contrast: it is the largest surface in the bowl after the
 * board itself, and anything with pattern in it competes with the play grid.
 */
export function sandTexture(): THREE.Texture {
  const S = 512;
  const [c, ctx] = canvas(S);
  const rnd = rng(3131);

  // Darker than sand looks in daylight. It sits directly against the board's
  // bright green and a true sand value reads as a glare beside it.
  ctx.fillStyle = '#8a7148';
  ctx.fillRect(0, 0, S, S);

  for (let i = 0; i < 30; i++) {
    ctx.globalAlpha = 0.1 + rnd() * 0.12;
    ctx.fillStyle = rnd() > 0.5 ? '#9b8055' : '#6f5a38';
    ctx.beginPath();
    ctx.ellipse(rnd() * S, rnd() * S, 30 + rnd() * 80, 20 + rnd() * 50, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 2200; i++) {
    ctx.fillStyle = rnd() > 0.5 ? '#a68a5c' : '#665233';
    ctx.fillRect(rnd() * S, rnd() * S, 2, 2);
  }
  ctx.globalAlpha = 1;
  return finish(c, [10, 10]);
}

/**
 * Colosseum masonry: big weathered blocks with deep joints.
 *
 * Coarser than the river's cut stone — these are structural blocks seen from
 * across an arena, and a fine course reads as noise at that distance. Kept
 * dark for the same reason everything else here is: ambient plus sun puts a
 * lit face well over 1.0, and pale limestone comes back as white.
 */
export function masonryTexture(repeat: [number, number] = [6, 2]): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S);
  const rnd = rng(777);

  ctx.fillStyle = '#4a4238';
  ctx.fillRect(0, 0, S, S);

  const rows = 5;
  const h = S / rows;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (S / 6);
    for (let i = -1; i < 4; i++) {
      const x = offset + i * (S / 3);
      const shade = 0.84 + rnd() * 0.3;
      const v = (n: number) => Math.min(255, Math.round(n * shade));
      ctx.fillStyle = `rgb(${v(88)},${v(79)},${v(66)})`;
      ctx.fillRect(x + 2, r * h + 2, S / 3 - 4, h - 4);
      ctx.fillStyle = 'rgba(255,246,220,.1)';
      ctx.fillRect(x + 2, r * h + 2, S / 3 - 4, 3);
      ctx.fillStyle = 'rgba(0,0,0,.34)';
      ctx.fillRect(x + 2, r * h + h - 5, S / 3 - 4, 3);
      // a few blocks are cracked or stained — an unweathered ruin is a model
      if (rnd() > 0.72) {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = '#3a3227';
        ctx.fillRect(x + 6 + rnd() * 30, r * h + 6, 3, h - 14);
        ctx.globalAlpha = 1;
      }
    }
  }

  ctx.strokeStyle = 'rgba(30,26,20,.6)';
  ctx.lineWidth = 3;
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * h);
    ctx.lineTo(S, r * h);
    ctx.stroke();
  }
  return finish(c, repeat);
}
