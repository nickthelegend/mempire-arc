/**
 * Capture real gameplay footage for marketing.
 *
 * Two things here are not the obvious choice, and both were paid for:
 *
 * 1. **Headless, not a screenshot of a visible tab.** A browser halts
 *    `requestAnimationFrame` while its document is hidden, so frames grabbed
 *    from a background pane came back as an empty navy rectangle with the HUD
 *    floating on it — the WebGL arena had never drawn. A headless run keeps the
 *    page foregrounded for its whole life.
 *
 * 2. **CDP screencast, not Playwright's `recordVideo`.** `recordVideo` fits the
 *    page into a fixed video size, and every time layout settles it emits a
 *    handful of frames with the page drawn at ~40% scale in the top-left on a
 *    grey field. Roughly one frame in seven was ruined, scattered across the
 *    clip. `Page.startScreencast` streams the real compositor output at device
 *    resolution and stamps each frame, so timing is reconstructed from the
 *    stamps rather than assumed.
 *
 * It plays the game rather than posing it: guest in, practice match, a card
 * dropped every second or so — an arena with nothing on it is a photo of a lawn.
 *
 * Usage:  node capture-gameplay.mjs [devServerUrl] [outDir]
 */
import { chromium } from 'playwright';
import { resolveChrome } from './capture-chrome.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const URL = process.argv[2] ?? 'http://localhost:49401';
const OUT = process.argv[3] ?? './capture';
/** Portrait. At deviceScaleFactor 2 the screencast lands at 860x1760. */
const VIEWPORT = { width: 430, height: 880 };
const SCALE = 2;
const PLAY_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Clicks the first button whose label matches. Returns whether it found one. */
async function tap(page, re, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const hit = await page.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      const b = [...document.querySelectorAll('button')].find((x) => rx.test(x.textContent || ''));
      if (b) { b.click(); return true; }
      return false;
    }, re.source);
    if (hit) return true;
    await sleep(200);
  }
  return false;
}

const main = async () => {
  const framesDir = join(OUT, 'frames');
  await mkdir(framesDir, { recursive: true });

  // Headed, on the real GPU. Forcing SwiftShader kept WebGL alive on a
  // headless shell but rendered in software, and the compositor only managed
  // ~4 frames a second — the screencast can never be smoother than the frames
  // the page actually produces. Metal via ANGLE holds 30.
  // resolveChrome() picks a build that actually launches; see that file for
  // why the pinned one cannot be trusted to exist.
  const browser = await chromium.launch({
    executablePath: resolveChrome(),
    headless: false,
    args: ['--use-gl=angle', '--use-angle=metal', '--hide-scrollbars', '--mute-audio'],
  });
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await sleep(1200);
  await tap(page, /connect/);
  await sleep(400);
  await tap(page, /guest/);
  await sleep(1400);
  await tap(page, /^\s*skip\s*$/);
  await sleep(600);
  await page.screenshot({ path: join(OUT, 'arena.png') });

  if (!await tap(page, /practice/)) {
    console.error('could not start a practice match');
    await browser.close();
    process.exit(1);
  }
  // Let the arena finish its entrance before the recorder starts, so the clip
  // opens on a settled board rather than a transition.
  await sleep(3000);

  const drew = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
    return { canvas: !!c, gl: !!gl, lost: gl ? gl.isContextLost() : null, vis: document.visibilityState };
  });
  console.log('renderer:', JSON.stringify(drew));

  // ── record ────────────────────────────────────────────────────────────────
  const client = await page.context().newCDPSession(page);
  const frames = [];
  client.on('Page.screencastFrame', async (f) => {
    frames.push({ ts: f.metadata.timestamp, data: f.data });
    // Every frame must be acked or the stream stalls after a few frames.
    try { await client.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* closed */ }
  });
  await client.send('Page.startScreencast', {
    format: 'png', maxWidth: VIEWPORT.width * SCALE, maxHeight: VIEWPORT.height * SCALE, everyNthFrame: 1,
  });

  const box = page.viewportSize();
  const hand = [0.14, 0.36, 0.58, 0.80].map((f) => Math.round(box.width * f));
  const handY = Math.round(box.height * 0.895);
  const drops = [
    [0.30, 0.62], [0.68, 0.60], [0.22, 0.68], [0.78, 0.66],
    [0.45, 0.58], [0.55, 0.70], [0.35, 0.64], [0.62, 0.63],
  ];

  const until = Date.now() + PLAY_MS;
  let beat = 0;
  while (Date.now() < until) {
    const slot = hand[beat % hand.length];
    const [dx, dy] = drops[beat % drops.length];
    try {
      await page.mouse.click(slot, handY);
      await sleep(110);
      await page.mouse.click(Math.round(box.width * dx), Math.round(box.height * dy));
    } catch { /* full hand or empty elixir: no unit this beat */ }
    beat += 1;
    await sleep(1500);
  }

  await client.send('Page.stopScreencast');
  await sleep(300);

  // ── write ─────────────────────────────────────────────────────────────────
  // Real inter-frame gaps, from the compositor's own stamps, so ffmpeg rebuilds
  // true timing instead of assuming a constant rate the screencast never had.
  const t0 = frames.length ? frames[0].ts : 0;
  let list = '';
  for (let i = 0; i < frames.length; i += 1) {
    const name = `f_${String(i).padStart(5, '0')}.png`;
    await writeFile(join(framesDir, name), Buffer.from(frames[i].data, 'base64'));
    const next = i + 1 < frames.length ? frames[i + 1].ts : frames[i].ts + 0.033;
    list += `file '${name}'\nduration ${Math.max(0.008, next - frames[i].ts).toFixed(4)}\n`;
  }
  if (frames.length) list += `file 'f_${String(frames.length - 1).padStart(5, '0')}.png'\n`;
  await writeFile(join(framesDir, 'frames.txt'), list);

  if (errors.length) {
    console.log(`\n${errors.length} page error(s):`);
    for (const e of [...new Set(errors)].slice(0, 5)) console.log('  ' + e.slice(0, 160));
  }
  const span = frames.length ? (frames[frames.length - 1].ts - t0).toFixed(1) : 0;
  console.log(`\n${frames.length} screencast frames over ${span}s → ${framesDir}`);
  await browser.close();
};

main().catch((e) => { console.error(e); process.exit(1); });
