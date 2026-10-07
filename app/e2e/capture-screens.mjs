/**
 * Mempire's key screens, captured from the running local fork stack in real
 * Google Chrome (Playwright, headless) at 1440×900 and 390×844, then laid out as
 * two labelled contact sheets. Everything on screen is real fork data: a
 * passkey account (virtual authenticator with PRF), its on-chain starter deck,
 * a mint at a live price, a bought golden chest, a merge, and a staked $1 AUSD
 * Rush match against a guest.
 *
 *   ./scripts/local-up.sh && node app/e2e/capture-screens.mjs
 *
 * Writes docs/screens/<nn>-<screen>-{desktop,mobile}.png and
 * docs/screens/sheets/mempire-{desktop,mobile}.png.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APP = 'http://localhost:5181';
const RPC = 'http://127.0.0.1:8612';
const OUT = `${ROOT}docs/screens/`;
mkdirSync(`${OUT}sheets`, { recursive: true });
const dep = JSON.parse(readFileSync(`${ROOT}shared/deployments/31337.json`, 'utf8'));
const pub = createPublicClient({ transport: http(RPC) });
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil #0, local fork only
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const shots = [];

/** Navigate inside the SPA without a reload (a passkey session is memory-only). */
const go = (page, hash) => page.evaluate((h) => { location.hash = h; }, hash);

async function capture(page, n, name, label) {
  for (const [size, vp] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
    await page.setViewportSize(vp);
    await sleep(700);
    const file = `${String(n).padStart(2, '0')}-${name}-${size}.png`;
    await page.screenshot({ path: `${OUT}${file}` });
    shots.push({ n, name, label, size, file });
  }
  await page.setViewportSize(DESKTOP);
  console.log(`captured ${n} ${name}`);
}

const errors = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctxA = await browser.newContext({ viewport: DESKTOP });
  const A = await ctxA.newPage();
  A.on('pageerror', (e) => errors.push(`A: ${e}`));
  const cdp = await ctxA.newCDPSession(A);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
  } });

  // 1. Guest start: the first viewport, signed out.
  await A.goto(APP);
  await sleep(3000);
  await capture(A, 1, 'start', 'Start — signed out, live market meta in the gutters');

  // 2. Sign up with a passkey; the starter deck lands on chain.
  await A.getByRole('button', { name: 'Play now' }).click();
  await sleep(800);
  await capture(A, 2, 'sign-in', 'Sign in — passkey (Mera), guest, or a browser wallet');
  await A.getByPlaceholder('Player name').fill('mempire_judge');
  await A.getByRole('button', { name: /Create with passkey/ }).click();
  await A.getByText(/Your deck is on chain/i).waitFor({ timeout: 60_000 });
  let onboarded = null;
  for (let i = 0; i < 20 && !onboarded; i += 1) {
    onboarded = await A.evaluate(() => {
      for (let k = 0; k < localStorage.length; k++) {
        const m = (localStorage.getItem(localStorage.key(k)) ?? '').match(/"address":"(0x[0-9a-fA-F]{40})"/);
        if (m) return m[1];
      }
      return null;
    });
    if (!onboarded) await sleep(500);
  }
  const skip = A.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await capture(A, 3, 'arena', 'Arena — starter deck on chain, $1 AUSD stake tier');

  // $MEMPIRE for the chest and the merge (a real token transfer on the fork).
  if (onboarded) {
    execFileSync('cast', ['send', dep.token, 'transfer(address,uint256)', onboarded, '1000000000000000000000',
      '--private-key', DEPLOYER, '--rpc-url', RPC], { stdio: 'ignore' });
  }

  // 4. Deck and the passkey locker.
  await go(A, '#/deck');
  await sleep(2500);
  await capture(A, 4, 'deck', 'Deck — eight on-chain fighters');
  await A.getByRole('button', { name: /Save to locker/ }).click();
  await A.getByText(/Saved\. Open the locker/).waitFor({ timeout: 20_000 }).catch(() => {});
  await A.locator('section[aria-label="Passkey locker"]').scrollIntoViewIfNeeded();
  await capture(A, 5, 'locker', 'Passkey locker — end-to-end encrypted, unlinkable id');

  // 6. Cards: mint a fighter at a live price.
  await go(A, '#/cards');
  await sleep(3000);
  const bags = A.locator('section[aria-label="Your bags"]');
  await bags.scrollIntoViewIfNeeded();
  const mint = bags.getByRole('button', { name: /^Mint · / }).first();
  await mint.click({ force: true });
  await sleep(6000);
  await capture(A, 6, 'mint', 'Mint — a fighter at a fresh signed price, in the mint tx');

  // 7. Chests: buy a golden chest, open, reveal.
  await A.evaluate(() => window.scrollTo(0, 0));
  await A.getByRole('button', { name: /Empty chest slot/ }).first().click({ force: true });
  await sleep(6000);
  for (let i = 0; i < 6; i += 1) {
    const btn = A.locator('section[aria-label="Chests"]').getByRole('button', { name: /^(OPEN|Open|START|Start)$|that chest|too early|wait a moment/ }).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click({ force: true }); await sleep(4000); }
    if (await A.getByText(/minted to your collection/i).isVisible().catch(() => false)) break;
  }
  await capture(A, 7, 'chest', 'Chest — revealed from a future block hash, real ERC-721 drops');
  const cont = A.getByText(/tap to continue/i);
  if (await cont.isVisible().catch(() => false)) await cont.click({ force: true });
  await sleep(1500);

  // 8. Merge a duplicate if the chest produced one.
  const merge = A.getByRole('button', { name: /Merge · Lv/ }).first();
  if (await merge.isVisible().catch(() => false)) {
    await merge.scrollIntoViewIfNeeded();
    await capture(A, 8, 'merge', 'Merge — a duplicate burns into a level');
    await merge.click({ force: true });
    await sleep(6000);
  } else {
    await capture(A, 8, 'merge', 'Your cards — collection after mint and chest');
  }

  // 9–10. A staked $1 AUSD Rush match against a guest.
  const ctxB = await browser.newContext({ viewport: MOBILE });
  const B = await ctxB.newPage();
  B.on('pageerror', (e) => errors.push(`B: ${e}`));
  await B.goto(APP);
  await B.getByRole('button', { name: 'Play now' }).click();
  await B.getByRole('button', { name: /Play as Guest/ }).click();
  await B.getByText(/Your deck is on chain/i).waitFor({ timeout: 60_000 });
  const bAddr = await B.evaluate(() => {
    for (let k = 0; k < localStorage.length; k++) {
      const m = (localStorage.getItem(localStorage.key(k)) ?? '').match(/"address":"(0x[0-9a-fA-F]{40})"/);
      if (m) return m[1];
    }
    return null;
  });
  // Both need AUSD: the real faucet pays one account a minute and the relay retries.
  const ausd = (a) => (a ? pub.readContract({ address: dep.ausd, abi: erc20, functionName: 'balanceOf', args: [a] }) : 0n);
  for (let i = 0; i < 40 && ((await ausd(onboarded)) === 0n || (await ausd(bAddr)) === 0n); i += 1) await sleep(5000);
  await go(A, '#/');
  await B.reload();
  await sleep(4000);
  const bSkip = B.getByRole('button', { name: 'Skip' });
  if (await bSkip.isVisible().catch(() => false)) await bSkip.click();
  await A.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await B.getByRole('button', { name: /Rush · 30s/i }).click({ force: true });
  await A.waitForURL(/#\/battle/, { timeout: 60_000 });
  const drop = async (p, fx, fy) => {
    const card = p.getByRole('button', { name: /^Deploy / }).first();
    const cb = await card.boundingBox().catch(() => null);
    const cv = await p.locator('canvas').first().boundingBox().catch(() => null);
    if (!cb || !cv) return;
    await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await p.mouse.down();
    await p.mouse.move(cv.x + cv.width * fx, cv.y + cv.height * fy, { steps: 8 });
    await p.mouse.up();
  };
  await A.setViewportSize(MOBILE);
  await sleep(4000);
  for (let i = 0; i < 4; i += 1) { await drop(A, 0.32, 0.62); await drop(B, 0.68, 0.62); await sleep(2500); }
  await capture(A, 9, 'match', 'Mid-match — every card drop is a Monad transaction');
  await A.setViewportSize(MOBILE);
  for (let i = 0; i < 40; i += 1) {
    if (/Pot Secured|Rekt|Split|Voided/i.test(await A.locator('main').innerText())) break;
    await drop(A, 0.32, 0.62);
    await sleep(2500);
  }
  await sleep(8000);
  await capture(A, 10, 'result', 'Result — the pot settles on chain, in dollars');

  // 11. Empire: balances, history, Live on Monad, leaderboard.
  await go(A, '#/empire');
  await sleep(4000);
  await capture(A, 11, 'empire', 'Empire — balances, history, leaderboard');
  await ctxB.close();

  // ── contact sheets ─────────────────────────────────────────────────────
  for (const [size, cols, w] of [['desktop', 3, 520], ['mobile', 6, 250]]) {
    const items = shots.filter((s) => s.size === size);
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:28px;background:#0e0a1a;color:#efe7ff;font:14px/1.35 -apple-system,Helvetica,Arial,sans-serif}
      h1{margin:0 0 4px;font-size:26px} p.sub{margin:0 0 20px;color:#a99cc8}
      .g{display:grid;grid-template-columns:repeat(${cols},${w}px);gap:18px}
      figure{margin:0;background:#1a1330;border:1px solid #3a2d5c;border-radius:10px;padding:8px}
      img{width:100%;display:block;border-radius:6px} figcaption{padding:8px 2px 2px}
      b{color:#f3c64b;margin-right:6px}</style>
      <h1>Mempire on Monad — ${size === 'desktop' ? '1440 × 900' : '390 × 844'}</h1>
      <p class="sub">Captured in Google Chrome from the local fork of Monad testnet (real contracts, Agora AUSD, live prices) · ${new Date().toISOString().slice(0, 10)}</p>
      <div class="g">${items.map((s) => `<figure><img src="file://${OUT}${s.file}"><figcaption><b>${String(s.n).padStart(2, '0')}</b>${s.label}</figcaption></figure>`).join('')}</div>`;
    const file = `${OUT}sheets/_${size}.html`;
    writeFileSync(file, html);
    const ctx = await browser.newContext({ viewport: { width: cols * (w + 18) + 56, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(`file://${file}`);
    await sleep(1500);
    await p.screenshot({ path: `${OUT}sheets/mempire-${size}.png`, fullPage: true });
    await ctx.close();
  }
  console.log(`sheets: ${OUT}sheets/mempire-desktop.png ${OUT}sheets/mempire-mobile.png`);
  if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
} finally {
  await browser.close();
}
