/**
 * Clan API integration test.
 *
 * Runs against a live server and a real database, because the things most likely
 * to be wrong here are exactly the things a mocked test would not catch: the
 * unique index on name, the atomic capacity guard on join, leader succession, and
 * whether a permission check actually refuses.
 *
 * Cleans up after itself so it can be run repeatedly.
 *
 * Every write is signed by the wallet it names, exactly as the client signs
 * it: the action is derived from the route, so a test cannot accidentally
 * exercise the 401 path while believing it is testing a clan rule.
 *
 * Run: node test-clans.mjs      (server must be running; a chain with no
 * $MEMPIRE deployment, so founding a clan carries no charter fee)
 */
import { freshAccount, signed } from './test-util.mjs';

const API = process.env.API ?? 'http://localhost:8787';

// Fresh keys per run; the server stores addresses lowercase, so the test does too.
const accounts = [freshAccount(), freshAccount(), freshAccount()];
const [A, B, C] = accounts.map((a) => a.address.toLowerCase());
const byAddress = new Map(accounts.map((a) => [a.address.toLowerCase(), a]));

/** The signed action for a clan write, read off the route the way the server names it. */
function actionFor(method, path) {
  if (method === 'PATCH') return 'clan.settings';
  if (path === '/api/clans') return 'clan.create';
  return `clan.${path.split('/').pop()}`;
}

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); } else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

async function req(method, path, rawBody) {
  const signer = rawBody?.address && byAddress.get(rawBody.address);
  const body = signer ? await signed(signer, actionFor(method, path), rawBody, rawBody.address) : rawBody;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

/** Leaves whatever clan these wallets are in, so a rerun starts clean. */
async function reset() {
  for (const addr of [A, B, C]) {
    const { data } = await req('GET', `/api/clans/mine/${addr}`);
    if (data?.tag) await req('POST', `/api/clans/${data.tag}/leave`, { address: addr });
  }
}

async function main() {
  console.log(`clan api → ${API}\n`);
  await reset();

  const name = `Test Dynasty ${Date.now() % 100000}`;

  // ── create ───────────────────────────────────────────────────────────────
  console.log('1. create');
  const created = await req('POST', '/api/clans', {
    address: A,
    name,
    description: 'we like alpha',
    region: 'Europe',
    crest: { shape: 2, emblem: 5, hue: 280, tone: 1 },
    requiredPower: 100,
    joinMode: 'open',
    power: 500,
  });
  check('clan created', created.status === 201, `status ${created.status}`);
  const tag = created.data?.tag;
  check('tag allocated', /^[A-HJ-NP-Z2-9]{6}$/.test(tag ?? ''), tag);
  check('founder is leader', created.data?.members?.[0]?.role === 'leader');
  check('member count is 1', created.data?.memberCount === 1);
  check('crest round-tripped', created.data?.crest?.emblem === 5 && created.data?.crest?.hue === 280);

  const dupe = await req('POST', '/api/clans', { address: B, name, power: 500 });
  check('duplicate name refused', dupe.status === 409, dupe.data?.error);

  const second = await req('POST', '/api/clans', { address: A, name: `${name} II`, power: 500 });
  check('one clan per wallet', second.status === 409, second.data?.error);

  const short = await req('POST', '/api/clans', { address: B, name: 'ab', power: 500 });
  check('short name refused', short.status === 400, short.data?.error);

  // ── search ───────────────────────────────────────────────────────────────
  console.log('\n2. search');
  const byName = await req('GET', `/api/clans?q=${encodeURIComponent(name.slice(0, 12))}`);
  check('found by name', byName.data?.clans?.some((c) => c.tag === tag));
  const byTag = await req('GET', `/api/clans?q=${tag}`);
  check('found by tag', byTag.data?.clans?.some((c) => c.tag === tag));
  const byRegion = await req('GET', '/api/clans?region=Europe');
  check('filtered by region', byRegion.data?.clans?.some((c) => c.tag === tag));
  // `tag` must exist for an exclusion assertion to mean anything — otherwise
  // "not in the list" is trivially true and the test lies.
  const wrongRegion = await req('GET', '/api/clans?region=Asia');
  check('excluded by wrong region',
    Boolean(tag) && !wrongRegion.data?.clans?.some((c) => c.tag === tag));
  const lowPower = await req('GET', '/api/clans?maxRequiredPower=50');
  check('excluded when power gate is too high',
    Boolean(tag) && !lowPower.data?.clans?.some((c) => c.tag === tag));

  // ── join ─────────────────────────────────────────────────────────────────
  console.log('\n3. join');
  const weak = await req('POST', `/api/clans/${tag}/join`, { address: B, power: 40 });
  check('underpowered join refused', weak.status === 403, weak.data?.error);

  const joined = await req('POST', `/api/clans/${tag}/join`, { address: B, power: 300 });
  check('join succeeded', joined.status === 200, `status ${joined.status}`);
  check('member count is 2', joined.data?.memberCount === 2);
  check('joiner is a member', joined.data?.members?.find((m) => m.address === B)?.role === 'member');

  const again = await req('POST', `/api/clans/${tag}/join`, { address: B, power: 300 });
  check('double join refused', again.status === 409, again.data?.error);

  const mineB = await req('GET', `/api/clans/mine/${B}`);
  check('mine lookup finds the clan', Boolean(tag) && mineB.data?.tag === tag);

  // ── roles ────────────────────────────────────────────────────────────────
  console.log('\n4. roles and permissions');
  await req('POST', `/api/clans/${tag}/join`, { address: C, power: 300 });

  const byMember = await req('POST', `/api/clans/${tag}/role`, { address: B, target: C, role: 'elder' });
  check('member cannot promote', byMember.status === 403, byMember.data?.error);

  const promoted = await req('POST', `/api/clans/${tag}/role`, { address: A, target: B, role: 'elder' });
  check('leader promotes to elder', promoted.data?.members?.find((m) => m.address === B)?.role === 'elder');

  const kickUp = await req('POST', `/api/clans/${tag}/kick`, { address: B, target: A });
  check('cannot kick a senior', kickUp.status === 403, kickUp.data?.error);

  const kickPeer = await req('POST', `/api/clans/${tag}/kick`, { address: B, target: C });
  check('elder kicks a member', kickPeer.status === 200 && kickPeer.data?.memberCount === 2);

  // ── lend loop ────────────────────────────────────────────────────────────
  console.log('\n5. lend requests');
  const asked = await req('POST', `/api/clans/${tag}/request`, { address: A, archetype: 2, note: 'need ranged' });
  check('request created', asked.status === 200);
  const openReq = asked.data?.feed?.find((f) => f.kind === 'request' && !f.filledBy);
  check('request is open', Boolean(openReq?.id));

  const twice = await req('POST', `/api/clans/${tag}/request`, { address: A, archetype: 3 });
  check('one open request at a time', twice.status === 409, twice.data?.error);

  const selfLend = await req('POST', `/api/clans/${tag}/lend`, { address: A, requestId: openReq.id });
  check('cannot answer your own request', selfLend.status === 400, selfLend.data?.error);

  const lent = await req('POST', `/api/clans/${tag}/lend`, { address: B, requestId: openReq.id });
  check('lend recorded', lent.status === 200);
  check('lender count incremented', lent.data?.members?.find((m) => m.address === B)?.lent === 1);
  check('receiver count incremented', lent.data?.members?.find((m) => m.address === A)?.received === 1);
  check('clan weekly total incremented', lent.data?.weeklyLent === 1);
  check('lender is paid gems', lent.data?.reward?.gems === 5);

  const twiceLend = await req('POST', `/api/clans/${tag}/lend`, { address: B, requestId: openReq.id });
  check('cannot answer twice', twiceLend.status === 409, twiceLend.data?.error);

  // ── crowns ───────────────────────────────────────────────────────────────
  console.log('\n6. crowns');
  await req('POST', `/api/clans/${tag}/crowns`, { address: A, crowns: 3, power: 520 });
  await req('POST', `/api/clans/${tag}/crowns`, { address: B, crowns: 2, power: 310 });
  const withCrowns = await req('GET', `/api/clans/${tag}`);
  check('clan crowns aggregated', withCrowns.data?.crowns === 5, `${withCrowns.data?.crowns}`);
  check('roster ranks by crowns', withCrowns.data?.members?.[0]?.address === A);

  const cheat = await req('POST', `/api/clans/${tag}/crowns`, { address: A, crowns: 999 });
  check('crowns per report are capped at 3', cheat.data?.added === 3, `added ${cheat.data?.added}`);

  const outsider = await req('POST', `/api/clans/${tag}/crowns`, { address: C, crowns: 3 });
  check('non-member cannot contribute crowns', outsider.status === 403, outsider.data?.error);

  // ── settings ─────────────────────────────────────────────────────────────
  console.log('\n7. settings');
  const patched = await req('PATCH', `/api/clans/${tag}`, {
    address: A, description: 'now with more alpha', requiredPower: 250, joinMode: 'closed',
  });
  check('leader edits settings', patched.data?.requiredPower === 250 && patched.data?.joinMode === 'closed');

  const closedJoin = await req('POST', `/api/clans/${tag}/join`, { address: C, power: 900 });
  check('closed clan refuses joins', closedJoin.status === 403, closedJoin.data?.error);

  // ── leader succession ────────────────────────────────────────────────────
  console.log('\n8. leaving');
  const leaderLeft = await req('POST', `/api/clans/${tag}/leave`, { address: A });
  check('leader can leave', leaderLeft.status === 200 && leaderLeft.data?.disbanded === false);
  const afterLeave = await req('GET', `/api/clans/${tag}`);
  check('clan survives with one member', afterLeave.data?.memberCount === 1);
  check('successor was promoted to leader',
    afterLeave.data?.members?.[0]?.role === 'leader',
    afterLeave.data?.members?.[0]?.role);

  const lastLeft = await req('POST', `/api/clans/${tag}/leave`, { address: B });
  check('last member disbands the clan', lastLeft.data?.disbanded === true);
  const gone = await req('GET', `/api/clans/${tag}`);
  check('clan is deleted', gone.status === 404);

  // ── validation ───────────────────────────────────────────────────────────
  console.log('\n9. input validation');
  const badTag = await req('GET', '/api/clans/nope');
  check('bad tag rejected', badTag.status === 400, badTag.data?.error);
  const badAddr = await req('GET', '/api/clans/mine/not-an-address');
  check('bad address rejected', badAddr.status === 400, badAddr.data?.error);
  const badArch = await req('POST', '/api/clans/ABCDEF/request', { address: A, archetype: 99 });
  check('bad archetype rejected', badArch.status === 400, badArch.data?.error);
  const inject = await req('GET', '/api/clans?q=%28%5B%7B*%2B');
  check('regex metacharacters in search are escaped, not thrown', inject.status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
