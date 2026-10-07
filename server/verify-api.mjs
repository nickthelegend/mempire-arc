/**
 * Endpoint sweep for TESTPLAN section B.
 *
 * Hits every relay route and reports status + a shape assertion. Unsigned
 * writes are expected to 401 — that is the auth guard working, so a 401 there
 * is a PASS and a 200 would be the failure.
 *
 * Chain-backed reads accept 503 as well as 200: a relay pointed at a chain
 * with no deployment, or with no Pyth key, says so with a 503 rather than
 * inventing an answer, and that is the correct behaviour to sweep for.
 *
 *   API=https://<relay> node verify-api.mjs
 */
const BASE = process.env.API ?? 'http://localhost:8787';
const ADDR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

let pass = 0; let fail = 0;
const results = [];

async function check(id, method, path, expect, assert) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ probe: true }),
    });
    const want = Array.isArray(expect) ? expect : [expect];
    const statusOk = want.includes(res.status);
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    const shapeOk = statusOk && assert ? assert(body) : statusOk;
    const ok = statusOk && shapeOk !== false;
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(6)} ${method} ${path} -> ${res.status} (want ${want.join('/')})`
      + (ok ? '' : `  body=${JSON.stringify(body).slice(0, 120)}`));
    ok ? pass++ : fail++;
  } catch (e) {
    results.push(`FAIL  ${id.padEnd(6)} ${method} ${path} -> threw ${e.message}`);
    fail++;
  }
}

await check('B1', 'GET', '/api/health', 200, (b) => b.ok === true && typeof b.chain?.chainId === 'number');
// The roster's market data. Correct = a list (possibly empty while upstream is
// rate-limiting), every entry carrying a coin id and a ticker with no padding.
await check('B2', 'GET', '/api/coins', 200, (b) => Array.isArray(b)
  && b.every((x) => Number.isInteger(x.coinId) && x.ticker === x.ticker.trim() && typeof x.priceUsd === 'number'));
await check('B3', 'GET', `/api/onboard/${ADDR}`, [200, 503], (b) => b.error || typeof b.starterClaimed === 'boolean');
await check('B3b', 'GET', '/api/onboard/not-an-address', 400);
await check('B4a', 'POST', '/api/onboard', 401);
await check('B4b', 'GET', '/api/pyth/update?coinIds=0', [200, 503], (b) => b.error || Array.isArray(b.updateData));
await check('B4c', 'GET', '/api/pyth/update?coinIds=9999', [400, 503]);
await check('B4d', 'GET', '/nft/1', [200, 404, 503]);
await check('B4e', 'GET', '/nft/not-a-number', [404]);
await check('B5', 'GET', `/api/player/${ADDR}`, 200);
await check('B5b', 'GET', '/api/player/NotARealAddress11111111111111', 400);
await check('B6', 'PUT', `/api/player/${ADDR}`, [400, 401]);
await check('B7', 'GET', '/api/leaderboard', 200, (b) => Array.isArray(b));
await check('B7b', 'GET', '/api/leaderboard?currency=AUSD', 200, (b) => Array.isArray(b));
await check('B7c', 'GET', '/api/leaderboard?currency=SOL', 400);
await check('B8a', 'GET', '/api/ladder', 200);
await check('B8b', 'GET', `/api/ladder/${ADDR}`, 200);
await check('B9a', 'GET', '/api/clans', 200);
await check('B9b', 'GET', '/api/clans-top', 200);
// Tags are six chars from the Crockford-ish alphabet. Malformed is a 400,
// well-formed but absent is a 404 — the two must stay distinguishable.
await check('B9c', 'GET', '/api/clans/ABCDEF', 404);
await check('B9c2', 'GET', '/api/clans/NOPE', 400);
await check('B9d', 'GET', `/api/clans/mine/${ADDR}`, 200);
await check('B10a', 'POST', '/api/clans', [400, 401]);
await check('B10b', 'POST', '/api/clans/NOPE/join', [400, 401, 404]);
await check('B10c', 'POST', '/api/clans/NOPE/leave', [400, 401, 404]);
await check('B10d', 'POST', '/api/clans/NOPE/lend', [400, 401, 404]);
await check('B10e', 'POST', '/api/clans/NOPE/crowns', [400, 401, 404]);
// Telemetry is signed like every other write; an unsigned post must be refused.
await check('B11', 'POST', '/api/events', 401);
await check('B12a', 'GET', '/api/analytics/summary', 200);
await check('B12c', 'GET', '/api/analytics/ops', 200);
await check('B12d', 'GET', '/api/analytics/insights', 200);
await check('B13a', 'POST', `/api/match/${ADDR}`, [400, 401]);
await check('B13b', 'POST', '/api/player/match', [400, 401]);
// The routes this relay no longer has must stay gone.
await check('B15a', 'GET', '/api/faucet', 404);
await check('B15b', 'GET', '/api/analytics/tvl', 404);
await check('B15c', 'GET', '/api/market/quote', 404);

console.log(results.join('\n'));
console.log(`\n${pass} pass, ${fail} fail`);
