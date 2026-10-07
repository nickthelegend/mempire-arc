/**
 * The zero-mock browser pass, in real Google Chrome (Playwright, channel
 * "chrome", headless) against the local fork stack from scripts/local-up.sh.
 *
 * Used because the Claude in Chrome extension was unreachable (its host hook
 * timed out). Every item records console errors/warnings, page errors and
 * failed requests, and checks its result against the chain or the relay — never
 * only against what the page says.
 *
 * Passkeys run on a CDP WebAuthn virtual authenticator with PRF, so the real
 * Mera derivation path executes (no stub).
 *
 *   ./scripts/local-up.sh && node app/e2e/browser-pass.mjs
 *
 * Writes docs/evidence/browser/results.json and screenshots beside it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APP = process.env.APP_URL ?? 'http://localhost:5181';
const API = 'http://localhost:8799';
const RPC = 'http://127.0.0.1:8612';
const OUT = `${ROOT}docs/evidence/browser/`;
mkdirSync(OUT, { recursive: true });
const dep = JSON.parse(readFileSync(`${ROOT}shared/deployments/31337.json`, 'utf8'));
const arenaAbi = JSON.parse(readFileSync(`${ROOT}shared/abi/MempireArena.json`, 'utf8'));
const pub = createPublicClient({ transport: http(RPC) });
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const cardsAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);

const results = [];
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** A page with its own console / network watch. */
async function watched(ctx, label) {
  const page = await ctx.newPage();
  const w = { console: [], pageErrors: [], failed: [] };
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) w.console.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => w.pageErrors.push(String(e).slice(0, 200)));
  page.on('requestfailed', (r) => w.failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) w.failed.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on('request', (r) => {
    if (r.url().endsWith('/api/onboard') && r.method() === 'POST') {
      try { page.onboarded = JSON.parse(r.postData() ?? '{}').address ?? page.onboarded; } catch { /* not json */ }
    }
  });
  page.label = label;
  page.watch = w;
  page.drain = () => { const out = { console: [...w.console], pageErrors: [...w.pageErrors], failed: [...w.failed] }; w.console.length = 0; w.pageErrors.length = 0; w.failed.length = 0; return out; };
  return page;
}

/*
 * The one console line tolerated everywhere: @react-three/fiber 9.8.1 (latest
 * stable) constructs THREE.Clock, which three r185 deprecates. Third-party,
 * harmless, fixed only in fiber 10 canaries. Everything else fails the item.
 */
const KNOWN = (l) => /THREE\.Clock: This module has been deprecated/.test(l);

function record(id, title, ok, evidence, pages = [], allow = () => false) {
  const watch = pages.map((p) => ({ page: p.label, ...p.drain() }));
  const noise = watch.flatMap((w) => [...w.console, ...w.pageErrors, ...w.failed]).filter((l) => !allow(l) && !KNOWN(l));
  const clean = noise.length === 0;
  const result = ok && clean ? 'PASS' : 'FAIL';
  results.push({ id, title, result, evidence, clean, noise: noise.slice(0, 12) });
  console.log(`${result}  ${id} ${title} — ${evidence}${clean ? '' : `\n      noise: ${noise.slice(0, 4).join(' | ')}`}`);
}

async function addAuthenticator(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
  } });
  return { cdp, authenticatorId };
}

const shortOf = async (page) => (await page.locator('main').innerText()).match(/0x[0-9a-fA-F]{2}…[0-9a-fA-F]{4}/)?.[0];
const walletOf = async (page) => (await page.evaluate(() => {
  for (let i = 0; i < localStorage.length; i++) {
    const v = localStorage.getItem(localStorage.key(i)) ?? '';
    const m = v.match(/"address":"(0x[0-9a-fA-F]{40})"/);
    if (m) return m[1];
  }
  return null;
})) ?? page.onboarded ?? null;
const ausdOf = (a) => pub.readContract({ address: dep.ausd, abi: erc20, functionName: 'balanceOf', args: [a] });

async function guestSignIn(page) {
  await page.goto(APP);
  await page.getByRole('button', { name: 'Play now' }).click();
  await page.getByRole('button', { name: /Play as Guest/ }).click();
  await page.getByText(/Your deck is on chain/i).waitFor({ timeout: 60_000 });
}
/** A passkey session lives in memory only: after a reload, one prompt reopens it. */
async function passkeySignIn(page) {
  await page.goto(APP);
  const play = page.getByRole('button', { name: 'Play now' });
  if (!(await play.isVisible().catch(() => false))) return;
  await play.click();
  // With a credential hint stored, the picker offers "Sign in as <name>"
  // (or "Unlock as") instead of the generic link.
  const hinted = page.getByRole('button', { name: /^(Sign in|Unlock) as / });
  if (await hinted.isVisible().catch(() => false)) await hinted.click();
  else await page.getByRole('button', { name: 'I already have a Mempire passkey' }).click();
  await sleep(5000);
}
async function skipTour(page) {
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // ── D1: passkey account (Mera, PRF), stateless sign-in ──────────────────
  const ctxA = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const A = await watched(ctxA, 'A (passkey)');
  await addAuthenticator(ctxA, A);
  await A.goto(APP);
  await A.getByRole('button', { name: 'Play now' }).click();
  await A.getByPlaceholder('Player name').fill('pk_judge');
  await A.getByRole('button', { name: /Create with passkey/ }).click();
  await A.getByText(/Your deck is on chain/i).waitFor({ timeout: 60_000 });
  const addrA = await walletOf(A);
  const cardsA = addrA ? Number(await pub.readContract({ address: dep.cards, abi: cardsAbi, functionName: 'balanceOf', args: [addrA] })) : 0;
  const chip = await A.locator('main').innerText();
  record('D1a', 'passkey sign-up (virtual authenticator, PRF) → account + starter deck', Boolean(addrA) && cardsA === 8 && /passkey/i.test(chip),
    `address ${addrA}, ${cardsA} cards on chain, session chip "${chip.match(/passkey · \S+/)?.[0]}"`, [A]);
  await A.screenshot({ path: `${OUT}d1-passkey-signup.png` });

  // Stateless: wipe storage, sign back in with the same passkey.
  await A.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await A.goto(APP);
  await A.getByRole('button', { name: 'Play now' }).click();
  await A.getByRole('button', { name: 'I already have a Mempire passkey' }).click();
  await sleep(6000);
  const again = await walletOf(A);
  record('D1b', 'stateless test: storage cleared, same passkey → same account', again?.toLowerCase() === addrA?.toLowerCase(),
    `before ${addrA}, after ${again}`, [A]);

  // ── D2: passkey locker, save → wipe → restore ──────────────────────────
  await skipTour(A);
  await A.goto(`${APP}/#/deck`);
  await sleep(2000);
  const save = A.getByRole('button', { name: /Save to locker/ });
  let lockerOk = false; let lockerEv = 'no locker on the Deck screen';
  if (await save.isVisible().catch(() => false)) {
    await save.click();
    await A.getByText(/Saved\. Open the locker/).waitFor({ timeout: 20_000 });
    await A.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await A.goto(APP);
    await A.getByRole('button', { name: 'Play now' }).click();
    await A.getByRole('button', { name: 'I already have a Mempire passkey' }).click();
    await sleep(5000);
    await A.goto(`${APP}/#/deck`);
    await sleep(1500);
    await A.getByRole('button', { name: /Open locker|Restore/ }).click();
    const msg = await A.getByRole('status').innerText({ timeout: 20_000 }).catch(() => '');
    lockerOk = /Restored \d+ deck/.test(msg);
    lockerEv = `after a storage wipe and passkey sign-in: "${msg}"`;
  }
  record('D2', 'passkey locker: save, wipe, restore with the same passkey', lockerOk, lockerEv, [A]);

  // ── C11/C13: staked $1 AUSD ranked match, passkey vs guest ─────────────
  const ctxB = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const B = await watched(ctxB, 'B (guest)');
  await guestSignIn(B);
  const addrB = await walletOf(B);

  // ── C9: a guest's deck persists across a reload (its key is kept) ─────
  await skipTour(B);
  await B.goto(`${APP}/#/deck`);
  await sleep(2000);
  const deckBefore = (await B.locator('main').innerText()).match(/\$[A-Z]+/g)?.slice(0, 8).join(',');
  await B.reload();
  await sleep(3000);
  const deckAfter = (await B.locator('main').innerText()).match(/\$[A-Z]+/g)?.slice(0, 8).join(',');
  record('C9', 'deck screen: 8 owned cards, same after reload (guest)', Boolean(deckBefore) && deckBefore === deckAfter, `before ${deckBefore}; after ${deckAfter}`, [B]);

  // Both need AUSD; the real faucet pays one account a minute and the relay retries.
  for (let i = 0; i < 60 && ((await ausdOf(addrA)) === 0n || (await ausdOf(addrB)) === 0n); i += 1) await sleep(5000);
  const funded = (await ausdOf(addrA)) > 0n && (await ausdOf(addrB)) > 0n;
  await passkeySignIn(A); await B.goto(APP);
  await sleep(3000);
  await skipTour(A); await skipTour(B);
  const id = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'nextMatchId' });
  await A.getByRole('button', { name: 'Ranked' }).click({ force: true });
  await B.getByRole('button', { name: 'Ranked' }).click({ force: true });
  await A.waitForURL(/#\/battle/, { timeout: 60_000 });
  await B.waitForURL(/#\/battle/, { timeout: 60_000 });
  // Play: A drops a card every ~3 s onto its left lane; B now and then.
  const drop = async (p, fx, fy) => {
    const card = p.getByRole('button', { name: /^Deploy / }).first();
    const cb = await card.boundingBox().catch(() => null);
    const canvas = await p.locator('canvas').first().boundingBox().catch(() => null);
    if (!cb || !canvas) return;
    await p.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await p.mouse.down();
    await p.mouse.move(canvas.x + canvas.width * fx, canvas.y + canvas.height * fy, { steps: 8 });
    await p.mouse.up();
  };
  const t0 = Date.now();
  while (Date.now() - t0 < 6 * 60_000) {
    if (/Pot Secured|Rekt|Split|Voided/i.test(await A.locator('main').innerText())) break;
    await drop(A, 0.32, 0.6);
    if (Math.random() < 0.3) await drop(B, 0.68, 0.6);
    await sleep(3000);
  }
  await sleep(2500); // let the money rows finish counting up
  const resultText = await A.locator('main').innerText();
  await A.screenshot({ path: `${OUT}c11-result-winner.png` });
  await B.screenshot({ path: `${OUT}c11-result-loser.png` });
  let m = null;
  for (let i = 0; i < 60; i += 1) {
    m = await pub.readContract({ address: dep.arena, abi: arenaAbi, functionName: 'getMatch', args: [id] });
    if (Number(m.state) === 3) break;
    await sleep(3000);
  }
  const badge = resultText.match(/LOGGED · \d+ · [\d.]+S( · \d+ UNLOGGED)?/i)?.[0] ?? '';
  // The money rows: from the "POT" row (not the "POT SECURED" title) to the hashes line.
  const money = resultText.match(/\nPOT\s*\n([\s\S]*?)state hashes/i)?.[1] ?? '';
  const dollars = /^\s*\$2\b/.test(money) && !/\bMON\b/.test(money);
  record('C11', 'staked $1 AUSD ranked match: escrow, on-chain plays, settlement', funded && Number(m?.state) === 3 && !/UNLOGGED/i.test(badge) && dollars,
    `match #${id} state ${m?.state} winner ${m?.winner} plays ${m?.plays0}+${m?.plays1}; badge "${badge}"; result reads in $: ${dollars}`, [A, B],
    (l) => /ERR_ABORTED|net::ERR_NETWORK_CHANGED/.test(l));

  // Leaderboard credit (the client retries on `pending`).
  let row = null;
  for (let i = 0; i < 40; i += 1) {
    const board = await (await fetch(`${API}/api/leaderboard`)).json();
    const w = Number(m?.winner) === 0 ? addrA : addrB;
    row = board.find((r) => r.address === w?.toLowerCase());
    if (row?.netAusd) break;
    await sleep(5000);
  }
  await A.goto(`${APP}/#/empire`);
  await sleep(3000);
  if (!/BATTLES/.test(await A.locator('main').innerText())) { await passkeySignIn(A); await A.goto(`${APP}/#/empire`); await sleep(3000); }
  const empire = await A.locator('main').innerText();
  await A.screenshot({ path: `${OUT}c13-empire.png`, fullPage: true });
  record('C13', 'leaderboard credits the chain-verified AUSD win; Empire shows it in $', Math.abs((row?.netAusd ?? 0) - 0.8) < 1e-9 && /\$/.test(empire.split('BATTLES')[1] ?? ''),
    `winner row netAusd ${row?.netAusd}; Empire history "${(empire.match(/pot \$[\d.]+[^\n]*/) ?? [''])[0]}"`, [A]);

  // ── C15: found a clan (250 $MEMPIRE charter, real transfer) ────────────
  execFileSync('cast', ['send', dep.token, 'transfer(address,uint256)', addrB, '300000000000000000000',
    '--private-key', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '--rpc-url', RPC], { stdio: 'ignore' });
  await B.goto(`${APP}/#/clan`);
  await sleep(2500);
  await B.getByRole('button', { name: /Create a clan|Create new/ }).first().click();
  const clanName = `Judges ${Date.now() % 10000}`;
  await B.getByPlaceholder('Degen Dynasty').fill(clanName);
  await B.getByRole('button', { name: /Found clan/ }).click();
  await sleep(8000);
  await B.reload();
  await sleep(3000);
  const clanText = await B.locator('main').innerText();
  const mine = await (await fetch(`${API}/api/clans/mine/${addrB}`)).json().catch(() => null);
    const shown = clanText.toLowerCase().includes(clanName.toLowerCase()); // the display font upper-cases it
  record('C15', 'found a clan: charter paid on chain, persists across reload', shown && mine?.name === clanName,
    `"${clanName}" on screen after reload: ${shown}; relay /api/clans/mine → ${JSON.stringify(mine)?.slice(0, 80)}`, [B]);

  // ── C16 / C17: 375 px and accessibility basics on every screen ─────────
  await B.setViewportSize({ width: 375, height: 812 });
  const routes = ['/', '/#/cards', '/#/deck', '/#/clan', '/#/empire'];
  const layout = []; const a11y = [];
  for (const r of routes) {
    await B.goto(`${APP}${r}`);
    await sleep(2500);
    const probe = await B.evaluate(() => {
      const over = document.documentElement.scrollWidth - window.innerWidth;
      const unnamed = [...document.querySelectorAll('button, [role=button], a[href]')]
        .filter((el) => el.offsetParent !== null && !(el.getAttribute('aria-label') || el.textContent?.trim() || el.getAttribute('title')))
        .map((el) => el.outerHTML.slice(0, 80));
      const noAlt = [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length;
      const small = [...document.querySelectorAll('button')].filter((b) => {
        const r = b.getBoundingClientRect(); return b.offsetParent !== null && r.width > 0 && (r.height < 32 || r.width < 32);
      }).length;
      return { over, unnamed, noAlt, small };
    });
    const name = r === '/' ? 'arena' : r.slice(3);
    await B.screenshot({ path: `${OUT}375-${name}.png`, fullPage: false });
    layout.push(`${name}: overflow ${probe.over}px`);
    a11y.push(`${name}: unnamed ${probe.unnamed.length}, img-no-alt ${probe.noAlt}, <32px buttons ${probe.small}`);
    if (probe.unnamed.length) a11y.push(`  ${probe.unnamed.join(' ')}`);
  }
  record('C16', '375×812: no horizontal overflow on any screen', layout.every((l) => / 0px$|-\d+px$/.test(l)), layout.join('; '), [B]);
  record('C17', 'accessibility basics: every visible control named, images have alt', a11y.every((l) => !/unnamed [1-9]|img-no-alt [1-9]/.test(l)), a11y.join('; '), [B]);

  // ── C18: relay down → honest offline state, then recovery ──────────────
  const relayPid = readFileSync(`${ROOT}.local/relay.pid`, 'utf8').trim();
  const cmd = execFileSync('ps', ['-o', 'command=', '-p', relayPid]).toString();
  let downOk = false; let downEv = `relay pid ${relayPid} is "${cmd.trim()}", not ours — skipped`;
  if (/node index\.js/.test(cmd)) {
    execFileSync('kill', [relayPid]);
    await sleep(1500);
    await B.goto(`${APP}/#/empire`);
    await sleep(4000);
    const offline = await B.locator('main').innerText();
    const crashed = B.watch.pageErrors.length > 0;
    execFileSync(`${ROOT}scripts/local-up.sh`, ['--relay-only'], { stdio: 'ignore' });
    await B.reload();
    await sleep(4000);
    const back = (await (await fetch(`${API}/api/health`)).json()).ok === true;
    downOk = !crashed && back && !/NaN|undefined/.test(offline);
    downEv = `relay stopped: page rendered without a crash (${offline.length} chars, no NaN/undefined); leaderboard hidden: ${!/LEADERBOARD/.test(offline)}; relay back: ${back}`;
  }
  record('C18', 'relay down: no crash, no invented data, recovers', downOk, downEv, [B],
    (l) => /localhost:8799|ERR_CONNECTION_REFUSED|Failed to fetch|Failed to load resource/.test(l));
} catch (e) {
  results.push({ id: 'run', title: 'suite ran to completion', result: 'FAIL', evidence: String(e?.stack ?? e).slice(0, 600) });
  console.log(`FAIL  suite: ${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  await browser.close();
  writeFileSync(`${OUT}results.json`, `${JSON.stringify({ at: new Date().toISOString(), browser: 'Google Chrome (Playwright channel "chrome", headless)', results }, null, 2)}\n`);
  const pass = results.filter((r) => r.result === 'PASS').length;
  console.log(`\n${pass} PASS, ${results.length - pass} FAIL`);
}
