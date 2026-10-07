/**
 * Capture a tour of the collection side of the game.
 *
 * The battle capture (`capture-gameplay.mjs`) shows the arena. This shows
 * where the cards in that arena come from — the collection, one card's own
 * page, the deck, and the swap. Same recording technique and the same reasons
 * for it, written up in that file: headed on the real GPU so the compositor
 * actually produces frames, and CDP screencast rather than Playwright's
 * `recordVideo`, which mangles frames whenever layout settles.
 *
 * It moves deliberately slowly. A tour that flicks between screens faster than
 * a viewer can read them is a screensaver.
 *
 * Usage:  node capture-tour.mjs [devServerUrl] [outDir]
 */
import { chromium } from 'playwright';
import { resolveChrome } from './capture-chrome.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const URL = process.argv[2] ?? 'http://localhost:65491';
const OUT = process.argv[3] ?? './tour';
const VIEWPORT = { width: 430, height: 880 };
const SCALE = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Smooth scroll to an absolute offset — a jump cut reads as a glitch. */
async function glide(page, to, ms = 900) {
  await page.evaluate(([target, dur]) => new Promise((done) => {
    const from = window.scrollY;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      window.scrollTo(0, from + (target - from) * e);
      k < 1 ? requestAnimationFrame(step) : done();
    };
    requestAnimationFrame(step);
  }), [to, ms]);
}

const main = async () => {
  const framesDir = join(OUT, 'frames');
  await mkdir(framesDir, { recursive: true });

  // resolveChrome() picks a build that actually launches; see that file for
  // why the pinned one cannot be trusted to exist.
  const browser = await chromium.launch({
    executablePath: resolveChrome(),
    headless: false,
    args: ['--use-gl=angle', '--use-angle=metal', '--hide-scrollbars', '--mute-audio'],
  });
  const page = await browser.newPage({
    viewport: VIEWPORT, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true,
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await sleep(1200);
  await tap(page, /connect/);
  await sleep(400);
  await tap(page, /guest/);
  await sleep(1500);
  await tap(page, /^\s*skip\s*$/);
  await sleep(700);

  // ── record ────────────────────────────────────────────────────────────────
  const client = await page.context().newCDPSession(page);
  const frames = [];
  client.on('Page.screencastFrame', async (f) => {
    frames.push({ ts: f.metadata.timestamp, data: f.data });
    try { await client.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* closed */ }
  });
  await client.send('Page.startScreencast', {
    format: 'png', maxWidth: VIEWPORT.width * SCALE, maxHeight: VIEWPORT.height * SCALE, everyNthFrame: 1,
  });

  const goto = async (hash, settle = 1100) => {
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    await sleep(settle);
  };

  // 1. the collection
  await goto('#/cards', 1500);
  await glide(page, 620, 1100);
  await sleep(1100);
  await glide(page, 1180, 1100);
  await sleep(1300);

  // 2. one card's own page — lore, trait, real stats
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /BTC, level/i.test(x.getAttribute('aria-label') || ''));
    if (b) b.click();
  });
  await sleep(1800);
  await page.evaluate(() => {
    const sheet = document.querySelector('[role="dialog"]');
    if (sheet) sheet.scrollTo({ top: 300, behavior: 'smooth' });
  });
  await sleep(1700);
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('button')].find((x) => /close/i.test(x.getAttribute('aria-label') || ''));
    if (c) c.click();
  });
  await sleep(700);

  // 3. the deck
  await goto('#/deck', 1600);
  await sleep(1200);

  // 4. the swap, reached the way a player reaches it
  await goto('#/cards', 1200);
  await glide(page, 0, 500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Buy \$MEMPIRE/i.test(x.getAttribute('aria-label') || ''));
    if (b) b.click();
  });
  await sleep(2200);

  await client.send('Page.stopScreencast');
  await sleep(300);

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

  const span = frames.length ? (frames[frames.length - 1].ts - t0).toFixed(1) : 0;
  console.log(`\n${frames.length} frames over ${span}s → ${framesDir}`);
  await browser.close();
};

main().catch((e) => { console.error(e); process.exit(1); });
