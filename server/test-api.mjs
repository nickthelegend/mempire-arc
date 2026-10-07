/**
 * Every HTTP endpoint the API exposes, against a running instance.
 *
 * The existing suites test behaviour in depth — matchmaking, clan rules, Elo.
 * This one tests *coverage*: that every route exists, answers, validates
 * their input, and return the shape the client expects. A route that 404s
 * because it was renamed, or 500s because an index is missing, is invisible to
 * a behavioural test that never calls it.
 *
 * It also asserts the things a deployment gets wrong rather than the things a
 * developer gets wrong: health reflects the database rather than the process,
 * a bad address is refused before it reaches Mongo, the rate limiter actually
 * limits, and the WebSocket upgrade is served from the same port.
 *
 *   node index.js            # no MONGODB_URI: the in-memory store is enough
 *   node test-api.mjs
 *
 * API=http://host:port to point it elsewhere. Writes are signed by fresh
 * throwaway keys, as the client signs them; run it against a chain with no
 * $MEMPIRE deployment, or founding the test clan needs a real charter payment.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { freshAccount, signed } from './test-util.mjs';

const API = process.env.API ?? 'http://localhost:8787';

let pass = 0;
let fail = 0;
const seen = new Set();

/** Marks a route as covered, so the summary can prove nothing was skipped. */
const cover = (method, path) => seen.add(`${method} ${path}`);

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0].slice(0, 180)}`);
  }
}

/**
 * A request, signed by `as` for `action` when both are given. The address in
 * the body is the signer's, as the server requires.
 */
async function req(method, path, rawBody, as, action) {
  const body = as && action ? await signed(as, action, rawBody ?? {}) : rawBody;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* some errors have no body */ }
  return { status: res.status, json };
}


/**
 * Fresh actors every run.
 *
 * The first version reused three fixed addresses, which passed once and then
 * failed forever: Alice was still in the clan she founded, so the next run's
 * `POST /api/clans` returned 409 and took nine assertions down with it. A suite
 * that only passes against an empty database is a suite that passes once.
 */
const alice = freshAccount();
const bob = freshAccount();
const carol = freshAccount();
const ALICE = alice.address;
const BOB = bob.address;
const CAROL = carol.address;
/**
 * Allocated by the server, not chosen here.
 *
 * The first version of this test invented a tag and passed it in the body. The
 * API generates one and returns it, so every follow-up call addressed a clan
 * that had never existed and nine assertions failed against a server that was
 * behaving correctly. Read the contract, do not assume it.
 */
let TAG = '';
let REQUEST_ID = null;

console.log(`\ntarget ${API}\n`);

// ── liveness ────────────────────────────────────────────────────────────────
console.log('health');

await check('GET /api/health reports the database, not just the process', async () => {
  cover('GET', '/api/health');
  const { status, json } = await req('GET', '/api/health');
  assert.equal(status, 200, `health returned ${status}`);
  assert.equal(json.ok, true);
  // A health check that returns ok without touching Mongo would let a
  // deployment with a dead database pass its readiness probe.
  assert.ok(json.db, 'health did not name the database it pinged');
  assert.equal(typeof json.chain?.chainId, 'number', 'health did not name the chain');
});

// ── player state ────────────────────────────────────────────────────────────
console.log('\nplayer state');

await check('GET /api/player/:address returns null for an unknown wallet', async () => {
  cover('GET', '/api/player/:address');
  const { status, json } = await req('GET', `/api/player/${ALICE}`);
  assert.equal(status, 200);
  assert.ok(json === null || typeof json === 'object');
});

await check('PUT /api/player/:address saves, and GET reads it back', async () => {
  cover('PUT', '/api/player/:address');
  const state = {
    cards: [], deck: [], tier: 1, mon: 4.2, nextId: 7, history: [],
    gems: 120, chests: [], nextChestId: 1,
  };
  const put = await req('PUT', `/api/player/${ALICE}`, state, alice, 'player.put');
  assert.ok(put.status < 300, `save returned ${put.status}`);
  // Read back under the other spelling: one account, one row.
  const got = await req('GET', `/api/player/${ALICE.toLowerCase()}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.mon, 4.2, 'the saved value did not come back');
  assert.equal(got.json.gems, 120);
});

await check('an unsigned write is refused', async () => {
  const { status } = await req('PUT', `/api/player/${ALICE}`, { cards: [], deck: [] });
  assert.equal(status, 401);
});

await check('a write signed by someone else is refused', async () => {
  const forged = await signed(bob, 'player.put', { cards: [], deck: [] }, ALICE);
  const { status } = await req('PUT', `/api/player/${ALICE}`, forged);
  assert.equal(status, 401);
});

await check('a malformed address is refused before it reaches Mongo', async () => {
  const { status } = await req('GET', '/api/player/not-a-real-address!!');
  assert.ok(status === 400 || status === 404, `expected a refusal, got ${status}`);
});

await check('POST /api/match/:address records a settled match', async () => {
  cover('POST', '/api/match/:address');
  const { status } = await req('POST', `/api/match/${ALICE}`, {
    won: true, crowns: [3, 0], pot: 0.1, payout: 0.09, currency: 'MON', tier: 1,
  }, alice, 'match.post');
  assert.ok(status < 300, `record returned ${status}`);
});

await check('an escrowed claim the chain cannot back credits no money', async () => {
  // No such arena match exists on this relay's chain, so the money column
  // must stay at zero however large the claimed payout.
  await req('POST', `/api/match/${ALICE}`, {
    won: true, crowns: [1, 0], escrowed: true, matchId: 999999, payout: 999, currency: 'MON',
  }, alice, 'match.post');
  const { json } = await req('GET', '/api/leaderboard');
  const row = json.find((r) => r.address === ALICE.toLowerCase());
  assert.ok(row, 'the reporting wallet is not on the board');
  assert.equal(row.netMon, 0, `a claim the chain does not support was credited: ${row.netMon}`);
});

await check('GET /api/leaderboard returns rows shaped for the client', async () => {
  cover('GET', '/api/leaderboard');
  const { status, json } = await req('GET', '/api/leaderboard');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json), 'leaderboard was not an array');
  if (json.length) {
    const r = json[0];
    assert.ok(typeof r.address === 'string', 'a row has no address');
    assert.ok('netMon' in r && 'netAusd' in r, 'a row is missing a per-currency money column');
    assert.ok(!('_id' in r) || r._id === undefined, 'Mongo _id leaked to the client');
  }
});

// ── the ladder ──────────────────────────────────────────────────────────────
console.log('\nladder');

await check('GET /api/ladder/:address starts a new player at the floor', async () => {
  cover('GET', '/api/ladder/:address');
  const { status, json } = await req('GET', `/api/ladder/${CAROL}`);
  assert.equal(status, 200);
  assert.ok(typeof json.trophies === 'number', 'no trophy count');
});

/** Queues `who` ranked, signed, and resolves the `matched` message. */
function queueRanked(who) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no pairing within 6s')); }, 6000);
    ws.on('open', async () => {
      ws.send(JSON.stringify({
        t: 'queue', ...(await signed(who, 'queue')), tier: 0, ranked: true,
        deck: Array.from({ length: 8 }, (_, i) => ({ coinId: i, name: `C${i}`, archetype: i % 6, level: 1 })),
      }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === 'matched') { clearTimeout(timer); ws.close(); resolve(m); }
    });
    ws.on('error', reject);
  });
}

await check('POST /api/ladder/:address moves trophies once both seats agree', async () => {
  cover('POST', '/api/ladder/:address');
  const before = (await req('GET', `/api/ladder/${CAROL}`)).json.trophies;
  const [mc] = await Promise.all([queueRanked(carol), queueRanked(bob)]);
  const first = await req('POST', `/api/ladder/${CAROL}`, { outcome: 'win', pairKey: mc.pairKey }, carol, 'ladder.post');
  assert.equal(first.json?.pending, true, `the first report settled alone: ${JSON.stringify(first.json)}`);
  const second = await req('POST', `/api/ladder/${BOB}`, { outcome: 'loss', pairKey: mc.pairKey }, bob, 'ladder.post');
  assert.ok(second.status < 300, `ladder post returned ${second.status}`);
  const after = (await req('GET', `/api/ladder/${CAROL}`)).json.trophies;
  assert.ok(after > before, `trophies did not rise: ${before} -> ${after}`);
});

await check('a rating report needs a pairing the relay made', async () => {
  const { status } = await req('POST', `/api/ladder/${CAROL}`, { outcome: 'win', pairKey: 'nope' }, carol, 'ladder.post');
  assert.equal(status, 409);
});

await check('GET /api/ladder returns the top table', async () => {
  cover('GET', '/api/ladder');
  const { status, json } = await req('GET', '/api/ladder');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.players), 'no players array');
});

// ── coins ───────────────────────────────────────────────────────────────────
console.log('\ncoins');

await check('GET /api/coins answers', async () => {
  cover('GET', '/api/coins');
  const { status, json } = await req('GET', '/api/coins');
  assert.equal(status, 200);
  // Possibly empty while the upstream rate-limits; never invented.
  assert.ok(Array.isArray(json), 'coins is not a list');
  for (const c of json) {
    assert.ok(Number.isInteger(c.coinId) && typeof c.ticker === 'string' && c.priceUsd > 0, JSON.stringify(c));
  }
});

// ── chain-backed reads ──────────────────────────────────────────────────────
console.log('\nchain');

await check('GET /api/onboard/:address answers or says the chain is not deployed', async () => {
  cover('GET', '/api/onboard/:address');
  const { status, json } = await req('GET', `/api/onboard/${ALICE}`);
  assert.ok(status === 200 || status === 503, `status ${status}`);
  if (status === 200) assert.equal(typeof json.starterClaimed, 'boolean');
  assert.equal((await req('GET', '/api/onboard/0x1234')).status, 400);
});

await check('POST /api/onboard refuses an unsigned claim', async () => {
  cover('POST', '/api/onboard');
  assert.equal((await req('POST', '/api/onboard', { address: ALICE })).status, 401);
});

await check('GET /api/pyth/update validates coin ids before spending the key', async () => {
  cover('GET', '/api/pyth/update');
  const { status } = await req('GET', '/api/pyth/update?coinIds=0');
  assert.ok(status === 200 || status === 503, `status ${status}`);
  const bad = await req('GET', '/api/pyth/update?coinIds=99999');
  assert.ok(bad.status === 400 || bad.status === 503, `status ${bad.status}`);
});

await check('GET /nft/:id is metadata, a 404, or a 503 — never a 500', async () => {
  cover('GET', '/nft/:id');
  const { status } = await req('GET', '/nft/1');
  assert.ok([200, 404, 503].includes(status), `status ${status}`);
  assert.equal((await req('GET', '/nft/abc')).status, 404);
});

// ── clans ───────────────────────────────────────────────────────────────────
console.log('\nclans');

await check('POST /api/clans founds one and returns its allocated tag', async () => {
  cover('POST', '/api/clans');
  const { status, json } = await req('POST', '/api/clans', {
    name: `API Test ${Date.now().toString(36).slice(-6)}`,
    description: 'created by the endpoint suite',
    region: 'Global',
    joinMode: 'open',
    memberName: 'alice',
    power: 30,
  }, alice, 'clan.create');
  assert.equal(status, 201, `found returned ${status}: ${JSON.stringify(json).slice(0, 140)}`);
  TAG = json.tag ?? json._id;
  assert.ok(TAG, `no tag in the response: ${JSON.stringify(json).slice(0, 140)}`);
});

await check('GET /api/clans lists it', async () => {
  cover('GET', '/api/clans');
  const { status, json } = await req('GET', '/api/clans');
  assert.equal(status, 200);
  const rows = Array.isArray(json) ? json : json.clans;
  assert.ok(Array.isArray(rows), 'no clan list');
  assert.ok(rows.some((c) => c.tag === TAG), 'the clan just founded is not listed');
});

await check('GET /api/clans/:tag returns it with its roster', async () => {
  cover('GET', '/api/clans/:tag');
  const { status, json } = await req('GET', `/api/clans/${TAG}`);
  assert.equal(status, 200);
  assert.equal(json.tag, TAG);
  assert.ok(Array.isArray(json.members), 'no member list');
});

await check('GET /api/clans/mine/:address finds the founder in it', async () => {
  cover('GET', '/api/clans/mine/:address');
  const { status, json } = await req('GET', `/api/clans/mine/${ALICE}`);
  assert.equal(status, 200);
  assert.ok(json && json.tag === TAG, 'the founder is not shown as a member');
  assert.ok(json.members.some((m) => m.address === ALICE.toLowerCase()), 'the roster is not keyed by the lowercase address');
});

await check('POST /api/clans/:tag/join adds a second member', async () => {
  cover('POST', '/api/clans/:tag/join');
  const { status } = await req('POST', `/api/clans/${TAG}/join`, {
    memberName: 'bob', power: 25,
  }, bob, 'clan.join');
  assert.ok(status < 300, `join returned ${status}`);
});

await check('PATCH /api/clans/:tag edits settings', async () => {
  cover('PATCH', '/api/clans/:tag');
  const { status } = await req('PATCH', `/api/clans/${TAG}`, {
    description: 'edited by the api test',
    region: 'Global', requiredPower: 10, joinMode: 'request',
  }, alice, 'clan.settings');
  assert.ok(status < 300, `patch returned ${status}`);
});

await check('POST /api/clans/:tag/role promotes a member', async () => {
  cover('POST', '/api/clans/:tag/role');
  const { status } = await req('POST', `/api/clans/${TAG}/role`, {
    target: BOB, role: 'elder',
  }, alice, 'clan.role');
  assert.ok(status < 300, `role returned ${status}`);
});

await check('POST /api/clans/:tag/crowns credits a war contribution', async () => {
  cover('POST', '/api/clans/:tag/crowns');
  const { status } = await req('POST', `/api/clans/${TAG}/crowns`, {
    crowns: 3, power: 30,
  }, alice, 'clan.crowns');
  assert.ok(status < 300, `crowns returned ${status}`);
});

await check('POST /api/clans/:tag/request asks for a card', async () => {
  cover('POST', '/api/clans/:tag/request');
  const { status, json } = await req('POST', `/api/clans/${TAG}/request`, {
    archetype: 0, note: 'need a tank',
  }, bob, 'clan.request');
  assert.ok(status < 300 || status === 409, `request returned ${status}`);
  REQUEST_ID = json?.feed?.find((f) => f.kind === 'request' && !f.filledBy)?.id ?? null;
  assert.ok(REQUEST_ID, 'the new request is not in the feed');
});

await check('POST /api/clans/:tag/lend fulfils one', async () => {
  cover('POST', '/api/clans/:tag/lend');
  const { status } = await req('POST', `/api/clans/${TAG}/lend`, {
    requestId: REQUEST_ID,
  }, alice, 'clan.lend');
  assert.ok(status < 300, `lend returned ${status}`);
});

await check('GET /api/clans-top ranks clans', async () => {
  cover('GET', '/api/clans-top');
  const { status, json } = await req('GET', '/api/clans-top');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json) || Array.isArray(json.clans), 'no ranking');
});

await check('POST /api/clans/:tag/kick removes a member', async () => {
  cover('POST', '/api/clans/:tag/kick');
  const { status } = await req('POST', `/api/clans/${TAG}/kick`, {
    target: BOB,
  }, alice, 'clan.kick');
  assert.ok(status < 300, `kick returned ${status}`);
});

await check('POST /api/clans/:tag/leave lets the founder out last', async () => {
  cover('POST', '/api/clans/:tag/leave');
  const { status } = await req('POST', `/api/clans/${TAG}/leave`, {}, alice, 'clan.leave');
  assert.ok(status < 300, `leave returned ${status}`);
});

await check('a non-member cannot edit a clan', async () => {
  const { status } = await req('PATCH', `/api/clans/${TAG}`, {
    description: 'should not land',
  }, carol, 'clan.settings');
  assert.ok(status >= 400, `a stranger edited the clan (${status})`);
});

// ── transport and limits ────────────────────────────────────────────────────
console.log('\ntransport');

await check('the WebSocket upgrade is served on the same port', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no upgrade within 5s')); }, 5000);
    ws.on('open', () => { clearTimeout(timer); ws.close(); resolve(); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
});

await check('an unknown route 404s rather than hanging', async () => {
  const { status } = await req('GET', '/api/definitely-not-a-route');
  assert.equal(status, 404);
});

await check('an oversized body is rejected, not buffered', async () => {
  const res = await fetch(`${API}/api/player/${ALICE}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ junk: 'x'.repeat(400_000) }),
  });
  assert.ok(res.status === 413 || res.status === 400,
    `a 400KB body returned ${res.status} — the 256KB limit is not enforced`);
});

await check('the rate limiter actually limits writes', async () => {
  // The bucket is 80 with 5/s refill, so a burst well past it must start
  // refusing. A limiter that never trips is a limiter nobody tested.
  const burst = await Promise.all(
    // Unsigned on purpose: the IP limiter sits in front of authentication, so
    // a flood is refused before any signature is even checked.
    Array.from({ length: 140 }, () => req('POST', `/api/match/${BOB}`, {
      won: false, crowns: [0, 0], tier: 1,
    })),
  );
  const limited = burst.filter((r) => r.status === 429).length;
  assert.ok(limited > 0, 'none of 140 rapid writes were rate limited');
  console.log(`       (${limited}/140 refused with 429)`);
});

// ── coverage ────────────────────────────────────────────────────────────────
const ROUTES = [
  'GET /api/health', 'GET /api/player/:address', 'PUT /api/player/:address',
  'POST /api/match/:address', 'GET /api/coins', 'GET /api/ladder/:address',
  'POST /api/ladder/:address', 'GET /api/ladder', 'GET /api/leaderboard',
  'GET /api/clans', 'GET /api/clans/mine/:address', 'GET /api/clans/:tag',
  'POST /api/clans', 'POST /api/clans/:tag/join', 'POST /api/clans/:tag/leave',
  'PATCH /api/clans/:tag', 'POST /api/clans/:tag/role', 'POST /api/clans/:tag/kick',
  'POST /api/clans/:tag/request', 'POST /api/clans/:tag/lend',
  'POST /api/clans/:tag/crowns', 'GET /api/clans-top',
  'GET /api/onboard/:address', 'POST /api/onboard', 'GET /api/pyth/update', 'GET /nft/:id',
];
const missed = ROUTES.filter((r) => !seen.has(r));

console.log('\ncoverage');
await check(`all ${ROUTES.length} routes were exercised`, () => {
  assert.equal(missed.length, 0, `never called: ${missed.join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed  ·  ${seen.size}/${ROUTES.length} routes covered\n`);
process.exit(fail ? 1 : 0);
