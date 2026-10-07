/**
 * The Kimi opponent and commentary routes, in both modes.
 *
 *   node test-ai.mjs
 *
 * Mock mode runs against a relay with no key. Kimi mode runs against a relay
 * pointed at a fake OpenAI-compatible server started here, which answers with
 * scripted tool calls and records what it was sent — so the request shape
 * (tools, tool_choice, the bearer key, reasoning carried across turns) is
 * asserted rather than assumed, and the failure paths (bad calls, text
 * answers, a model that never answers) are exercised without a Moonshot
 * account. Needs no chain: CHAIN_ID=10143 and no deployment calls.
 */
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { startRelay, tally } from './test-util.mjs';

const { check, done } = tally();

/**
 * A port nobody holds right now. Fixed ports collided with other suites run
 * in parallel, and `startRelay`'s health poll then happily talked to *their*
 * relay — a mock-mode relay answering a Kimi-mode test.
 */
async function freePort(preferred) {
  const tryPort = (p) => new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(null));
    s.listen(p, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  return (await tryPort(preferred)) ?? tryPort(0);
}
const post = async (base, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, text: JSON.stringify(data) };
};

/** A board from the AI's seat. `them` varies per call so the plan cache never answers for a different test. */
function board(over = {}) {
  return {
    state: {
      tick: 400,
      secondsLeft: 160,
      doubleElixir: false,
      elixir: { you: 8, them: 4 },
      towers: { yours: { left: 100, right: 100, king: 100 }, theirs: { left: 100, right: 100, king: 100 } },
      hand: [
        { ticker: 'DOGE', archetype: 'Tank', level: 3, metaBps: 0, cost: 4 },
        { ticker: 'ZAP', archetype: 'Spell', level: 3, metaBps: 0, cost: 4 },
        { ticker: 'PEPE', archetype: 'Swarm', level: 3, metaBps: 0, cost: 3 },
        { ticker: 'AAPL', archetype: 'Ranged', level: 3, metaBps: 0, cost: 3 },
      ],
      enemyUnits: [],
      yourUnits: [],
      meta: {
        yours: [{ ticker: 'DOGE', archetype: 'Tank', metaBps: 900 }],
        theirs: [{ ticker: 'WIF', archetype: 'Splash', metaBps: -400 }],
      },
      ...over,
    },
  };
}

// ── (a) no key: not configured, no stand-in ────────────────────────────────
console.log('no key');
const off = await startRelay(await freePort(8796), { CHAIN_ID: '10143' });
try {
  const st = await fetch(`${off.base}/api/ai/status`).then((x) => x.json());
  check('status says off and names the missing key', st.mode === 'off' && st.model === null && st.missing?.includes('MOONSHOT_API_KEY'));
  let r = await post(off.base, '/api/ai/plan', board({}));
  check('a plan request is 503 not configured', r.status === 503 && /not configured/.test(r.data?.error ?? ''), r.text);
  check('and carries no move', r.data?.action === undefined);
  r = await post(off.base, '/api/ai/commentary', { aiName: 'Kimi', events: [{ kind: 'tower_down', side: 'you', lane: 'left' }] });
  check('commentary is 503 not configured', r.status === 503 && r.data?.line === undefined, r.text);
} finally {
  await off.stop();
}

// ── (b) Kimi mode, against a fake OpenAI-compatible server ───────────────────
console.log('\nkimi mode (fake upstream)');
const seen = [];
const script = [];
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    seen.push({ path: req.url, auth: req.headers.authorization, body });
    const step = script.shift() ?? { body: { choices: [{ message: { role: 'assistant', content: 'unscripted' } }] } };
    if (step.delay) await new Promise((r) => { setTimeout(r, step.delay); });
    if (res.destroyed) return;
    res.writeHead(step.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(step.body));
  });
});
await new Promise((r) => { fake.listen(0, '127.0.0.1', r); });
const fakePort = fake.address().port;

let callId = 0;
const toolCall = (name, args, extra = {}) => ({
  body: {
    choices: [{
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: `thinking about ${name}`,
        tool_calls: [{ id: `call_${callId += 1}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }],
        ...extra,
      },
    }],
  },
});
const text = (content) => ({ body: { choices: [{ message: { role: 'assistant', content } }] } });

const KEY = 'sk-test-not-a-real-key';
const kimi = await startRelay(await freePort(8795), {
  CHAIN_ID: '10143',
  MOONSHOT_API_KEY: KEY,
  MOONSHOT_BASE_URL: `http://127.0.0.1:${fakePort}/v1`,
  AI_TIMEOUT_MS: '800',
  AI_PLAN_BURST: '100',
  AI_LINE_BURST: '100',
});
try {
  let r = await fetch(`${kimi.base}/api/ai/status`).then((x) => x.json());
  check('status says kimi with the default model', r.mode === 'kimi' && r.model === 'kimi-k2.6', JSON.stringify(r));
  check('status never carries the key', !JSON.stringify(r).includes(KEY));

  // 1. a straight deploy
  script.push(toolCall('deploy_card', { hand_index: 0, lane: 'left', depth: 'bridge', reason: 'tank leads the push' }));
  r = await post(kimi.base, '/api/ai/plan', board({ elixir: { you: 8, them: 1 } }));
  check('a valid tool call becomes the move', r.data.mode === 'kimi'
    && r.data.action.type === 'deploy' && r.data.action.handIndex === 0
    && r.data.action.lane === 'left' && r.data.action.depth === 'bridge', r.text);
  check('the model\'s reason comes back', r.data.reason === 'tank leads the push');
  check('the key never reaches the response', !r.text.includes(KEY));
  let req = seen.at(-1);
  check('upstream hit at /v1/chat/completions', req.path === '/v1/chat/completions');
  check('bearer key sent upstream', req.auth === `Bearer ${KEY}`);
  check('model is kimi-k2.6', req.body.model === 'kimi-k2.6');
  const names = (req.body.tools ?? []).map((t) => t.function?.name).sort();
  check('tools are deploy_card, get_market_meta, wait', JSON.stringify(names) === JSON.stringify(['deploy_card', 'get_market_meta', 'wait']), names.join());
  const deployTool = req.body.tools.find((t) => t.function.name === 'deploy_card').function;
  check('deploy_card constrains lane and depth', JSON.stringify(deployTool.parameters.properties.lane.enum) === '["left","right"]'
    && JSON.stringify(deployTool.parameters.properties.depth.enum) === '["back","mid","bridge"]');
  check('tool_choice is sent', req.body.tool_choice === 'auto');
  check('thinking is disabled by default', req.body.thinking?.type === 'disabled');
  check('system + user messages, board in the user turn', req.body.messages[0].role === 'system'
    && req.body.messages[1].role === 'user' && req.body.messages[1].content.includes('"DOGE"'));
  check('the meta is not in the prompt (it is behind get_market_meta)', !req.body.messages[1].content.includes('WIF'));

  // 2. a read tool, then a move: multi-turn with reasoning kept
  script.push(toolCall('get_market_meta', {}), toolCall('deploy_card', { hand_index: 2, lane: 'right', depth: 'mid' }));
  r = await post(kimi.base, '/api/ai/plan', board({ elixir: { you: 8, them: 2 } }));
  check('get_market_meta then deploy: the deploy is the move', r.data.mode === 'kimi' && r.data.action.handIndex === 2 && r.data.rounds === 2, r.text);
  req = seen.at(-1);
  const msgs = req.body.messages;
  const asst = msgs.find((m) => m.role === 'assistant');
  const tool = msgs.find((m) => m.role === 'tool');
  check('second turn replays the assistant tool call', asst?.tool_calls?.[0]?.function?.name === 'get_market_meta');
  check('reasoning_content is kept on the assistant turn', asst?.reasoning_content === 'thinking about get_market_meta');
  check('the tool result answers that call id', tool?.tool_call_id === asst?.tool_calls?.[0]?.id);
  check('the tool result is the market meta from the request', tool?.content.includes('WIF') && tool?.content.includes('-400'), tool?.content);

  // 3. a bad index is sent back as a tool error; the model corrects itself
  script.push(toolCall('deploy_card', { hand_index: 7, lane: 'left', depth: 'mid' }), toolCall('wait', { reason: 'fine, banking' }));
  r = await post(kimi.base, '/api/ai/plan', board({ elixir: { you: 8, them: 3 } }));
  check('an out-of-range index is rejected, the retry is used', r.data.mode === 'kimi' && r.data.action.type === 'wait' && r.data.reason === 'fine, banking', r.text);
  const err = seen.at(-1).body.messages.find((m) => m.role === 'tool');
  check('the rejection tells the model how to fix it', /rejected: hand_index must be an integer 0-3/.test(err?.content ?? ''), err?.content);

  // input validation happens before any model call
  r = await post(kimi.base, '/api/ai/plan', { state: { hand: [] } });
  check('an empty hand is a 400', r.status === 400);
  r = await post(kimi.base, '/api/ai/plan', { state: { hand: [{ archetype: 'Wizard' }] } });
  check('an unknown archetype is a 400', r.status === 400);
  r = await post(kimi.base, '/api/ai/plan', {});
  check('no state is a 400', r.status === 400);
  r = await post(kimi.base, '/api/ai/commentary', { events: [{ kind: 'nope' }] });
  check('commentary with no recognised events is a 400', r.status === 400);

  // 4. unaffordable, then bad lane, then bad JSON, then text: falls back to the heuristic, labelled
  script.push(
    toolCall('deploy_card', { hand_index: 0, lane: 'left', depth: 'mid' }),
    toolCall('deploy_card', { hand_index: 2, lane: 'middle', depth: 'mid' }),
    toolCall('deploy_card', '{not json'),
    text('I think I will deploy the tank.'),
  );
  r = await post(kimi.base, '/api/ai/plan', board({ elixir: { you: 3, them: 4 } }));
  check('four bad answers are an honest 502 invalid, no invented move', r.status === 502 && r.data.kind === 'invalid' && r.data.action === undefined, r.text);
  const last = seen.at(-1).body.messages;
  const rejections = last.filter((m) => m.role === 'tool').map((m) => m.content);
  check('unaffordable card was refused with the price', rejections.some((c) => /costs 4 elixir and you have 3\.0/.test(c)), rejections.join(' | '));
  check('bad lane was refused', rejections.some((c) => /lane must be "left" or "right"/.test(c)));
  check('bad JSON was refused', rejections.some((c) => /not valid JSON/.test(c)));
  check('upstream saw exactly four rounds', last.length === 8, `${last.length} messages`);

  // 5. text first, nudged into a tool call
  script.push(text('Probably the swarm?'), toolCall('deploy_card', { hand_index: 2, lane: 'left', depth: 'back' }));
  r = await post(kimi.base, '/api/ai/plan', board({ elixir: { you: 8, them: 5 } }));
  check('a text answer is nudged into a tool call', r.data.mode === 'kimi' && r.data.action.handIndex === 2, r.text);
  check('the nudge asks for a tool', seen.at(-1).body.messages.at(-1).content.includes('calling exactly one tool'));

  // 6. a model that never answers
  const before = Date.now();
  script.push({ delay: 3000, ...toolCall('wait', { reason: 'too late' }) });
  r = await post(kimi.base, '/api/ai/plan', board({
    elixir: { you: 8, them: 6 },
    enemyUnits: [{ lane: 'left', zone: 'your_bridge', archetype: 'Tank', count: 1, hpPct: 100 }],
  }));
  const took = Date.now() - before;
  check('a timeout is an honest 502 timeout', r.status === 502 && r.data.kind === 'timeout', r.text);
  check('within the timeout budget, not the upstream delay', took < 2500, `${took} ms`);

  // 7. an upstream 500
  script.push({ status: 500, body: { error: { message: 'boom' } } });
  r = await post(kimi.base, '/api/ai/plan', board({ elixir: { you: 8, them: 7 } }));
  check('an upstream error is an honest 502', r.status === 502 && r.data.kind === 'error', r.text);

  // 8. cache: the same board (tick aside) is answered without a model call
  script.push(toolCall('deploy_card', { hand_index: 3, lane: 'right', depth: 'mid' }));
  const b8 = board({ elixir: { you: 8, them: 8 } });
  const first = await post(kimi.base, '/api/ai/plan', b8);
  const calls = seen.length;
  const second = await post(kimi.base, '/api/ai/plan', { state: { ...b8.state, tick: 460 } });
  check('a repeat board is served from cache', second.data.cached === true && seen.length === calls
    && JSON.stringify(second.data.action) === JSON.stringify(first.data.action), second.text);

  // 9. commentary
  script.push(text('"Kimi just folded the left tower like a lawn chair — the challenger is in shambles and the chat is going absolutely feral right now"'));
  r = await post(kimi.base, '/api/ai/commentary', { aiName: 'Kimi', events: [{ kind: 'tower_down', side: 'ai', lane: 'left' }] });
  check('commentary from kimi', r.data.mode === 'kimi', r.text);
  check('long lines are cut to 90 characters, quotes stripped', r.data.line.length <= 90 && !r.data.line.startsWith('"'), `${r.data.line.length}: ${r.data.line}`);
  req = seen.at(-1);
  check('commentary sends no tools', req.body.tools === undefined);
  check('commentary prompt carries the events', req.body.messages[1].content.includes('tower_down'));

  script.push(text('Buy DOGE now before it moons, ser'));
  r = await post(kimi.base, '/api/ai/commentary', { aiName: 'Kimi', events: [{ kind: 'buffed', side: 'ai', ticker: 'DOGE', bps: 900 }] });
  check('a line that reads as financial advice is refused, not shown', r.status === 502 && r.data.kind === 'invalid' && r.data.line === undefined, r.text);

  // 10. an upstream that does not know `thinking` is retried without it, once and for good
  script.push(
    { status: 400, body: { error: { message: 'unknown field: thinking' } } },
    toolCall('wait', { reason: 'ok' }),
  );
  r = await post(kimi.base, '/api/ai/plan', board({ elixir: { you: 8, them: 9 } }));
  check('a 400 on thinking is retried without the field', r.data.mode === 'kimi' && seen.at(-1).body.thinking === undefined
    && seen.at(-2).body.thinking?.type === 'disabled', r.text);
} finally {
  await kimi.stop();
  fake.close();
}

process.exit(done() ? 1 : 0);
