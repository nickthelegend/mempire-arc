/**
 * Ladder integration test.
 *
 * The first section is the one that matters structurally: the client
 * (`app/src/lib/ranking.ts`) and the server (`server/ranking.js`) carry
 * independent copies of the Elo math, because one is a Vite/TS bundle and the
 * other is plain ESM Node. If they ever drift the ladder silently splits in
 * two — the result screen shows one number and the leaderboard another. This
 * asserts a shared vector across both so drift fails loudly here instead.
 *
 * The live section plays the ladder the way the relay demands it be played:
 * a rating only moves for a pairing the matchmaker made, and only once both
 * seats have reported the same result.
 *
 * Run: node test-ladder.mjs   (server must be running)
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { applyMatch as serverApply, leagueFor } from './ranking.js';
import { freshAccount, signed } from './test-util.mjs';

const API = process.env.API ?? 'http://localhost:8787';
const WS = `${API.replace(/^http/, 'ws')}/ws`;
const DECK = Array.from({ length: 8 }, (_, i) => ({ coinId: i, name: `C${i}`, archetype: i % 6, level: 1 }));

/** Queues `account` ranked (signed) and resolves its `matched` message. */
function queueRanked(account, trophies) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no pairing within 6s')); }, 6000);
    ws.on('open', async () => {
      ws.send(JSON.stringify({ t: 'queue', ...(await signed(account, 'queue')), tier: 0, ranked: true, trophies, deck: DECK }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === 'matched') { clearTimeout(timer); resolve({ ws, m }); }
    });
    ws.on('error', reject);
  });
}

const post = async (account, body) => {
  const res = await fetch(`${API}/api/ladder/${account.address}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await signed(account, 'ladder.post', body)),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

let pass = 0; let fail = 0;
const check = (l, ok, d = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); }
};

/** Runs the CLIENT's implementation by evaluating its pure math here. */
function clientApply(mine, theirs, outcome) {
  const src = readFileSync(new URL('../app/src/lib/ranking.ts', import.meta.url), 'utf8');
  const K = Number(/const K = (\d+)/.exec(src)[1]);
  const SCALE = Number(/const ELO_SCALE = (\d+)/.exec(src)[1]);
  const floors = [...src.matchAll(/at: (\d+), floor: (\d+)/g)].map((m) => +m[2]);
  const expected = 1 / (1 + 10 ** ((theirs - mine) / SCALE));
  const score = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
  const raw = Math.round(K * (score - expected));
  const delta = outcome === 'draw' ? raw
    : outcome === 'win' ? Math.max(1, raw) : Math.min(-1, raw);
  let floor = 0;
  const ats = [...src.matchAll(/at: (\d+), floor: (\d+)/g)].map((m) => +m[1]);
  for (let i = 0; i < ats.length; i += 1) if (mine >= ats[i]) floor = floors[i];
  return { delta, after: Math.max(floor, mine + delta) };
}

async function main() {
  console.log('1. client and server Elo agree (drift guard)');
  const vectors = [
    [0, 1200, 'win'], [0, 0, 'win'], [1500, 1500, 'loss'],
    [2400, 900, 'win'], [900, 2400, 'loss'], [700, 700, 'draw'],
    [400, 380, 'loss'], [3000, 3200, 'win'],
  ];
  let agreed = 0;
  for (const [mine, theirs, outcome] of vectors) {
    const s = serverApply(mine, theirs, outcome);
    const c = clientApply(mine, theirs, outcome);
    const same = s.delta === c.delta && s.after === c.after;
    if (same) agreed += 1;
    else console.log(`    drift @ ${mine}v${theirs} ${outcome}: server ${s.delta}/${s.after} vs client ${c.delta}/${c.after}`);
  }
  check('all vectors agree', agreed === vectors.length, `${agreed}/${vectors.length}`);

  console.log('\n2. league floors');
  // A Bag Holder (400) losing badly cannot fall back to Paper Hands.
  //
  // The opponent must be *weaker*, not stronger: in Elo, losing to someone far
  // above you costs almost nothing (−1 here), so a 3000-rated opponent never
  // pushes 405 through the floor at all. Losing to a 100 is what hurts.
  const floored = serverApply(405, 100, 'loss');
  check('floor absorbs the loss', floored.after === 400,
    `405 vs 100 → raw ${405 + floored.delta}, floored to ${floored.after}`);
  check('floor is reported', floored.floored === true);
  const free = serverApply(800, 3000, 'loss');
  check('above the floor, losses land normally', free.after < 800 && !free.floored, `800 → ${free.after}`);

  console.log('\n3. Elo direction');
  const upset = serverApply(100, 2000, 'win');
  const expectedWin = serverApply(2000, 100, 'win');
  check('beating someone far above pays more than beating someone far below',
    upset.delta > expectedWin.delta, `${upset.delta} vs ${expectedWin.delta}`);
  check('a heavy favourite still gains at least 1', expectedWin.delta >= 1, `${expectedWin.delta}`);
  const heavyLoss = serverApply(2000, 100, 'loss');
  check('a heavy favourite losing is punished hard', heavyLoss.delta <= -30, `${heavyLoss.delta}`);

  console.log('\n4. leagues');
  check('0 is Paper Hands', leagueFor(0).name === 'Paper Hands');
  check('4000 is Mempire', leagueFor(4000).name === 'Mempire');
  check('399 has not promoted', leagueFor(399).name === 'Paper Hands');
  check('400 has promoted', leagueFor(400).name === 'Bag Holder');

  console.log('\n5. live API');
  const A = freshAccount();
  const B = freshAccount();
  const before = await (await fetch(`${API}/api/ladder/${A.address}`)).json();
  const [pa, pb] = await Promise.all([queueRanked(A, 0), queueRanked(B, 0)]);
  check('both seats share one pairing key', pa.m.pairKey && pa.m.pairKey === pb.m.pairKey);
  pa.ws.close();
  pb.ws.close();

  const forged = await post(A, { outcome: 'win', pairKey: 'f'.repeat(32) });
  check('a report citing no real pairing is refused', forged.status === 409, `status ${forged.status}`);
  const bad = await post(A, { outcome: 'cheat', pairKey: pa.m.pairKey });
  check('bogus outcome rejected', bad.status === 400, `status ${bad.status}`);
  const stranger = await post(freshAccount(), { outcome: 'win', pairKey: pa.m.pairKey });
  check('a wallet that did not play cannot report', stranger.status === 403, `status ${stranger.status}`);

  const first = await post(A, { outcome: 'win', pairKey: pa.m.pairKey });
  check('first report waits for the opponent', first.data?.pending === true, JSON.stringify(first.data));
  const second = await post(B, { outcome: 'loss', pairKey: pb.m.pairKey });
  check('second, agreeing report settles', second.status === 200 && typeof second.data?.trophies === 'number',
    JSON.stringify(second.data));
  const r = await (await fetch(`${API}/api/ladder/${A.address.toLowerCase()}`)).json();
  const local = serverApply(before.trophies, 0, 'win');
  check('API applies the same math to the winner', r.trophies === local.after, `api ${r.trophies} vs local ${local.after}`);
  check('rank is derived', typeof r.rank === 'number' && r.rank >= 1, `rank ${r.rank}`);
  check('best never decreases', r.best >= before.best, `${before.best} → ${r.best}`);
  const again = await post(A, { outcome: 'win', pairKey: pa.m.pairKey });
  check('a second report of the same pairing changes nothing', again.data?.duplicate === true);

  const badAddr = await fetch(`${API}/api/ladder/not-an-address`);
  check('bad address rejected', badAddr.status === 400, `status ${badAddr.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
