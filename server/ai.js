/**
 * Kimi plays the AI opponent, and calls the match.
 *
 * Two routes, both behind the relay so the Moonshot key never reaches a
 * browser:
 *
 *  - `POST /api/ai/plan` — the bot's seat sends a compact summary of the board
 *    every few seconds of game time and Kimi answers by calling one of three
 *    tools: `deploy_card`, `wait`, or the read-only `get_market_meta`. The
 *    answer is a move the client's bot then plays through the same input path
 *    a human's card drop takes. That is what "powered by" means here: the
 *    model's decision is the play, not a caption on one.
 *  - `POST /api/ai/commentary` — a few recent match events in, one short
 *    caster line out.
 *
 * Without a `MOONSHOT_API_KEY` both routes answer 503 "not configured" and the
 * app plays its own classic bot, labelled as the classic bot. A game that
 * claimed an LLM opponent while a lookup table played would be lying, so there
 * is no stand-in; when Kimi fails mid-match the route says so (502) and the
 * classic bot takes that turn, again labelled.
 *
 * Every model answer is validated before it is returned. A hand index out of
 * range, a card the bot cannot afford, a lane that does not exist — each is
 * sent back to the model as a tool error so it can correct itself, and after
 * a bounded number of tries the heuristic answers instead, labelled as such.
 * The match must never stall on a model.
 */
import { createHash } from 'node:crypto';

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const num = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

const KEY = env('MOONSHOT_API_KEY');
const BASE_URL = env('MOONSHOT_BASE_URL', 'https://api.moonshot.ai/v1').replace(/\/+$/, '');
const MODEL = env('KIMI_MODEL', 'kimi-k2.6');
/** One plan request end to end, every model round included. */
const TIMEOUT_MS = num(process.env.AI_TIMEOUT_MS, 200, 60_000, 9_000);
/**
 * Thinking off by default: a strategist that answers in two seconds plays the
 * board it was shown; one that answers in fifteen plays a board that is gone.
 * `enabled` turns it on, `omit` leaves the field out for an endpoint that does
 * not know it.
 */
const THINKING = env('KIMI_THINKING', 'disabled').toLowerCase();
/**
 * `auto`, not `required`: thinking-capable Kimi models accept `auto`/`none`
 * only, and a 400 on every turn would be a silent mock. The system prompt and
 * a one-line nudge turn a text answer into a tool call instead.
 */
const TOOL_CHOICE = env('KIMI_TOOL_CHOICE', 'auto');
/** Model rounds per plan: a meta read, a corrected bad call, and one spare. */
const MAX_ROUNDS = 4;
/** Concurrent upstream calls across all players. Beyond this, the heuristic. */
const MAX_INFLIGHT = num(process.env.AI_MAX_INFLIGHT, 1, 64, 8);

/**
 * 'kimi' when a Moonshot key is configured, 'off' otherwise. There is no
 * stand-in: without Kimi the app offers its own classic bot, labelled as such.
 */
export function aiMode() {
  return KEY ? 'kimi' : 'off';
}

// ── The board summary ────────────────────────────────────────────────────────

const ARCHETYPES = ['Tank', 'Swarm', 'Ranged', 'Splash', 'Support', 'Spell'];
const LANES = ['left', 'right'];
const DEPTHS = ['back', 'mid', 'bridge'];
/** Zones are named from the AI's seat: "your" is the AI's half, "their" the human's. */
const ZONES = ['their_back', 'their_bridge', 'your_bridge', 'your_back'];
const str = (v, max) => (typeof v === 'string' ? v.replace(/[^\w .$+-]/g, '').slice(0, max) : '');
/** Free text from the model, one line, bounded: it is shown in the HUD as-is. */
const prose = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (v, lo, hi, d = lo) => Math.round(num(v, lo, hi, d));

function readTowers(t) {
  const one = (v) => int(v, 0, 100, 100);
  return { left: one(t?.left), right: one(t?.right), king: one(t?.king) };
}

function readGroups(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 24).flatMap((g) => {
    if (!LANES.includes(g?.lane) || !ZONES.includes(g?.zone) || !ARCHETYPES.includes(g?.archetype)) return [];
    return [{ lane: g.lane, zone: g.zone, archetype: g.archetype, count: int(g.count, 1, 20), hpPct: int(g.hpPct, 0, 100, 100) }];
  });
}

function readMetaList(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).map((c) => ({
    ticker: str(c?.ticker, 12),
    archetype: ARCHETYPES.includes(c?.archetype) ? c.archetype : 'Tank',
    metaBps: int(c?.metaBps, -1500, 1500, 0),
  }));
}

/**
 * The summary, normalised, or a string saying what was wrong with it.
 *
 * Everything is clamped to the ranges the sim can produce, so a hostile body
 * can at worst describe an impossible board — never inflate a prompt, and
 * never smuggle text into it beyond twelve characters of ticker.
 */
export function readSummary(body) {
  const s = body?.state;
  if (!s || typeof s !== 'object') return 'state is required';
  if (!Array.isArray(s.hand) || s.hand.length < 1 || s.hand.length > 4) return 'hand must have 1-4 cards';
  const hand = [];
  for (const [i, c] of s.hand.entries()) {
    if (!ARCHETYPES.includes(c?.archetype)) return `hand[${i}] has an unknown archetype`;
    hand.push({
      index: i,
      ticker: str(c.ticker, 12) || `CARD${i}`,
      archetype: c.archetype,
      level: int(c.level, 1, 10),
      metaBps: int(c.metaBps, -1500, 1500, 0),
      cost: int(c.cost, 1, 10, 10),
    });
  }
  return {
    tick: int(s.tick, 0, 1_000_000),
    secondsLeft: int(s.secondsLeft, 0, 600),
    doubleElixir: Boolean(s.doubleElixir),
    elixir: { you: num(s.elixir?.you, 0, 10, 0), them: num(s.elixir?.them, 0, 10, 0) },
    towers: { yours: readTowers(s.towers?.yours), theirs: readTowers(s.towers?.theirs) },
    hand,
    enemyUnits: readGroups(s.enemyUnits),
    yourUnits: readGroups(s.yourUnits),
    meta: { yours: readMetaList(s.meta?.yours), theirs: readMetaList(s.meta?.theirs) },
  };
}

/**
 * Is this tool call a legal move on this board? Returns the action, or a
 * sentence the model can act on. The sentence goes back to the model verbatim,
 * so it names the fix rather than the rule.
 */
export function validateCall(name, args, s) {
  if (name === 'wait') {
    return { action: { type: 'wait' }, reason: clean(prose(args?.reason, 120)) || 'waiting' };
  }
  if (name !== 'deploy_card') return { error: `unknown tool ${name}; call deploy_card or wait` };
  const i = args?.hand_index;
  if (!Number.isInteger(i) || i < 0 || i >= s.hand.length) {
    return { error: `hand_index must be an integer 0-${s.hand.length - 1}; got ${JSON.stringify(i)}` };
  }
  if (!LANES.includes(args?.lane)) return { error: `lane must be "left" or "right"; got ${JSON.stringify(args?.lane)}` };
  const depth = args?.depth ?? 'mid';
  if (!DEPTHS.includes(depth)) return { error: `depth must be back, mid or bridge; got ${JSON.stringify(depth)}` };
  const card = s.hand[i];
  if (card.cost > s.elixir.you) {
    return { error: `${card.ticker} costs ${card.cost} elixir and you have ${s.elixir.you.toFixed(1)}; pick a cheaper card or wait` };
  }
  return {
    action: { type: 'deploy', handIndex: i, lane: args.lane, depth },
    reason: clean(prose(args?.reason, 120)) || `${card.ticker} ${args.lane} ${depth}`,
  };
}

// ── Kimi: the model strategist ───────────────────────────────────────────────

export const PLAN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'deploy_card',
      description: 'Play one card from your hand now. Units spawn on your half of the lane at the chosen depth: back = beside your own towers (defence), mid = your half, bridge = at the river ready to cross. A Spell lands on the biggest enemy group in that lane (their tower if the lane is empty); depth is ignored for spells.',
      parameters: {
        type: 'object',
        properties: {
          hand_index: { type: 'integer', minimum: 0, maximum: 3, description: 'Index into your hand.' },
          lane: { type: 'string', enum: LANES },
          depth: { type: 'string', enum: DEPTHS },
          reason: { type: 'string', description: 'Under 12 words: why this play.' },
        },
        required: ['hand_index', 'lane', 'depth'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Play nothing this turn and bank elixir (it regenerates, max 10).',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Under 12 words: why wait.' } },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_market_meta',
      description: "Today's market modifiers for every fighter in both decks, in basis points (+1000 = +10% hp and damage). Read-only; call it, then decide.",
      parameters: { type: 'object', properties: {} },
    },
  },
];

const PLAN_SYSTEM = [
  'You are the AI opponent in Mempire, a real-time lane battler (two lanes, left and right; each side has a left tower, a right tower and a king).',
  'Every few seconds you get the board from your seat and must answer by calling exactly one tool: deploy_card or wait. You may call get_market_meta first.',
  'Cards cost elixir; you cannot play a card that costs more than you have. Tower values are hp percent; 0 means destroyed.',
  'Archetypes: Tank soaks damage and walks to towers; Swarm is many cheap units; Ranged shoots from distance; Splash hits groups; Support speeds allies; Spell is an area blast after a short delay.',
  'Fighters with a positive metaBps hit harder and live longer today; negative ones are weaker.',
  'Good play: defend the lane where enemies are on your half, punish a lane whose tower is down, do not overspend into nothing, and prefer buffed fighters when pushing.',
].join(' ');

/** The assistant turn, as the next request must replay it — reasoning included. */
function assistantTurn(msg) {
  const turn = { role: 'assistant', content: msg.content ?? '' };
  // Kimi's thinking models reject a multi-turn history that drops the
  // reasoning they attached to a tool call, so it rides along unchanged.
  if (msg.reasoning_content !== undefined) turn.reasoning_content = msg.reasoning_content;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) turn.tool_calls = msg.tool_calls;
  return turn;
}

let thinkingRejected = false;
let inflight = 0;

class UpstreamError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

/**
 * One chat completion. The key goes in a header to Moonshot and nowhere else;
 * nothing this function throws or returns carries it.
 */
async function chat(payload, signal) {
  const send = async (withThinking) => {
    const body = { model: MODEL, ...payload };
    if (withThinking) body.thinking = { type: THINKING };
    return fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal,
    });
  };
  const useThinking = THINKING !== 'omit' && !thinkingRejected;
  let res = await send(useThinking);
  // An endpoint (or model) that does not know `thinking` 400s on it. Drop the
  // field for the life of the process rather than failing every call.
  if (res.status === 400 && useThinking) {
    const text = await res.text().catch(() => '');
    if (/thinking/i.test(text)) {
      thinkingRejected = true;
      console.warn('ai: upstream refused the thinking field; sending without it from now on');
      res = await send(false);
    } else {
      throw new UpstreamError('error', `upstream 400: ${text.slice(0, 120)}`);
    }
  }
  if (!res.ok) throw new UpstreamError('error', `upstream ${res.status}`);
  const data = await res.json().catch(() => null);
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new UpstreamError('error', 'upstream returned no message');
  return msg;
}

/** Runs `fn` under the shared deadline and concurrency cap. */
async function withBudget(fn) {
  if (inflight >= MAX_INFLIGHT) throw new UpstreamError('busy', 'too many concurrent model calls');
  inflight += 1;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fn(ctl.signal);
  } catch (e) {
    if (ctl.signal.aborted) throw new UpstreamError('timeout', `no answer in ${TIMEOUT_MS} ms`);
    throw e instanceof UpstreamError ? e : new UpstreamError('error', String(e?.message ?? e).slice(0, 120));
  } finally {
    clearTimeout(timer);
    inflight -= 1;
  }
}

/** Kimi's move for this board: the tool loop, validated at every step. */
export async function kimiPlan(s) {
  return withBudget(async (signal) => {
    const { meta, ...board } = s;
    const messages = [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: `Board from your seat:\n${JSON.stringify(board)}\nCall one tool.` },
    ];
    let lastError = 'no tool call';
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const msg = await chat({
        messages,
        tools: PLAN_TOOLS,
        tool_choice: TOOL_CHOICE,
        max_tokens: THINKING === 'enabled' ? 4096 : 400,
      }, signal);
      messages.push(assistantTurn(msg));
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!calls.length) {
        lastError = 'answered in text instead of a tool call';
        messages.push({ role: 'user', content: 'Answer by calling exactly one tool: deploy_card or wait.' });
        continue;
      }
      let decided = null;
      // Every tool_call id must be answered before the next turn, including
      // the ones this loop ignores, or the next request is malformed.
      for (const call of calls) {
        const name = call?.function?.name;
        let args = {};
        let content;
        try {
          args = JSON.parse(call?.function?.arguments || '{}') ?? {};
        } catch {
          args = null;
        }
        if (name === 'get_market_meta') {
          content = JSON.stringify(meta);
        } else if (decided) {
          content = 'ignored: one move per turn, the first was taken';
        } else if (args === null) {
          lastError = 'arguments were not valid JSON';
          content = `rejected: ${lastError}`;
        } else {
          const v = validateCall(name, args, s);
          if (v.error) { lastError = v.error; content = `rejected: ${v.error}`; } else { decided = v; content = 'accepted'; }
        }
        messages.push({ role: 'tool', tool_call_id: call?.id ?? '', name: name ?? '', content });
      }
      if (decided) return { ...decided, rounds: round + 1 };
    }
    throw new UpstreamError('invalid', lastError);
  });
}

// ── Commentary ───────────────────────────────────────────────────────────────

const EVENT_KINDS = ['tower_down', 'spell', 'elixir_lead', 'buffed', 'nerfed', 'swarm', 'double_elixir', 'overtime', 'kickoff'];
const SIDES = ['you', 'ai'];
const MAX_LINE = 90;

export function readEvents(body) {
  if (!Array.isArray(body?.events) || !body.events.length) return 'events must be a non-empty array';
  const events = body.events.slice(-6).flatMap((e) => {
    if (!EVENT_KINDS.includes(e?.kind)) return [];
    return [{
      kind: e.kind,
      side: SIDES.includes(e.side) ? e.side : 'ai',
      ...(e.ticker ? { ticker: str(e.ticker, 12) } : {}),
      ...(LANES.includes(e.lane) ? { lane: e.lane } : {}),
      ...(e.amount !== undefined ? { amount: int(e.amount, 0, 10) } : {}),
      ...(e.bps !== undefined ? { bps: int(e.bps, -1500, 1500, 0) } : {}),
    }];
  });
  if (!events.length) return 'no recognised events';
  return { events, aiName: str(body.aiName, 20) || 'the AI' };
}

/**
 * Lines that are not about the match have no business in it. No price calls,
 * no "buy", no "not financial advice" — the market here is a stat modifier,
 * and the caster says so in the only language the game needs.
 */
const OFF_LIMITS = /\b(buy|sell|invest|investment|financial advice|nfa|price target|pump|dump|shill|ape in|10x|100x|guaranteed)\b|\b(fuck|shit|bitch|cunt|retard)/i;

/** A model's reason is shown in the HUD too, so it passes the same filter as a caster line. */
function clean(text) {
  return OFF_LIMITS.test(text) ? '' : text;
}

const pct = (bps) => `${bps > 0 ? '+' : ''}${(bps / 100).toFixed(0)}%`;
const who = (side, ai) => (side === 'you' ? 'The challenger' : ai);

const TEMPLATES = {
  tower_down: [
    (e, ai) => `${who(e.side, ai)} just deleted the ${e.lane ?? ''} tower. Timber.`,
    (e, ai) => `Tower down ${e.lane ?? ''}! ${who(e.side, ai)} is cooking.`,
  ],
  spell: [
    (e, ai) => `${who(e.side, ai)} drops ${e.ticker ?? 'a spell'} on the stack. Clean.`,
    (e, ai) => `Big spell from ${who(e.side, ai).toLowerCase()} — that cluster is gone.`,
  ],
  elixir_lead: [
    (e, ai) => `${who(e.side, ai)} is up ${e.amount ?? 'a few'} elixir. Something is coming.`,
    (e, ai) => `Elixir lead: ${who(e.side, ai).toLowerCase()}, by ${e.amount ?? 'plenty'}. Brace.`,
  ],
  buffed: [
    (e) => `${e.ticker ?? 'That fighter'} is juiced ${pct(e.bps ?? 0)} today and it shows.`,
    (e) => `Market says ${e.ticker ?? 'this one'} hits ${pct(e.bps ?? 0)} harder. Respect the meta.`,
  ],
  nerfed: [
    (e) => `${e.ticker ?? 'That fighter'} is nerfed ${pct(e.bps ?? 0)} today. Bold deploy.`,
    (e) => `${e.ticker ?? 'This one'} running ${pct(e.bps ?? 0)} and still showing up. Diamond legs.`,
  ],
  swarm: [
    (e, ai) => `${who(e.side, ai)} floods the ${e.lane ?? ''} lane. Splash, anyone?`,
  ],
  double_elixir: [() => 'Double elixir! Wallets out, hands fast, no more patience.'],
  overtime: [() => 'Overtime. Next tower wins it. No pressure.'],
  kickoff: [(e, ai) => `${ai} vs the challenger. Lanes open — let's see some plays.`],
};
const PRIORITY = ['tower_down', 'spell', 'overtime', 'double_elixir', 'buffed', 'nerfed', 'swarm', 'elixir_lead', 'kickoff'];

const hashOf = (v) => createHash('sha1').update(JSON.stringify(v)).digest();

function trimLine(text) {
  let line = String(text).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  line = line.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (line.length <= MAX_LINE) return line;
  const cut = line.slice(0, MAX_LINE - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 50 ? cut.slice(0, space) : cut).replace(/[,;:\s-]+$/, '')}…`;
}

const COMMENTARY_SYSTEM = [
  'You are the live caster for Mempire, a lane battler where fighters are memecoins and stocks.',
  `Write ONE line under ${MAX_LINE} characters about the newest events. Voice: hype, degen slang is fine, but clean: no swearing, no slurs.`,
  'Never give financial advice, never tell anyone to buy or sell anything, never mention prices — market moves only change fighter stats here.',
  'Output the line only. No quotes, no hashtags.',
].join(' ');

export async function kimiLine(ev) {
  return withBudget(async (signal) => {
    const msg = await chat({
      messages: [
        { role: 'system', content: COMMENTARY_SYSTEM },
        { role: 'user', content: `The AI opponent is called ${ev.aiName}; "you" is the human challenger.\nEvents, oldest first: ${JSON.stringify(ev.events)}` },
      ],
      max_tokens: THINKING === 'enabled' ? 2048 : 80,
    }, signal);
    const line = trimLine(msg.content ?? '');
    if (!line) throw new UpstreamError('invalid', 'empty line');
    if (OFF_LIMITS.test(line)) throw new UpstreamError('invalid', 'line failed the content filter');
    return line;
  });
}

// ── Rate limit and cache ─────────────────────────────────────────────────────

/**
 * Per-IP buckets, in process. The relay's shared limiter already guards every
 * POST; these sit on top because a model call costs money per request, and the
 * honest rate — one plan per three seconds, one line per eight — is far below
 * what the shared bucket allows.
 */
function bucket(capacity, refillPerSec) {
  const map = new Map();
  return (key) => {
    const now = Date.now();
    const b = map.get(key) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    map.set(key, b);
    if (map.size > 5000) map.delete(map.keys().next().value);
    return ok;
  };
}

/**
 * A short-lived answer cache. The same board (tick aside) asked twice inside a
 * few seconds — a retry, a second tab — gets the same move without a second
 * model call.
 */
function cache(ttlMs, max = 256) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (Date.now() - hit.at > ttlMs) { map.delete(key); return null; }
      return hit.value;
    },
    set(key, value) {
      map.set(key, { at: Date.now(), value });
      if (map.size > max) map.delete(map.keys().next().value);
    },
  };
}

const keyOf = (mode, v) => hashOf([mode, MODEL, v]).toString('hex');

export function registerAiRoutes(app) {
  const mode = aiMode();
  console.log(`ai: ${mode === 'kimi' ? `Kimi (${MODEL}) via ${BASE_URL}` : 'off — set MOONSHOT_API_KEY to enable Kimi'}`);
  const notConfigured = { error: 'Kimi is not configured on this relay (MOONSHOT_API_KEY)', mode: 'off' };

  const planLimit = bucket(num(process.env.AI_PLAN_BURST, 1, 1000, 8), 0.5);
  const lineLimit = bucket(num(process.env.AI_LINE_BURST, 1, 1000, 4), 0.2);
  const plans = cache(12_000);
  const lines = cache(60_000);

  /** What the UI labels the opponent with. Never the key, only whether there is one. */
  app.get('/api/ai/status', (_req, res) => {
    res.json({
      mode, model: mode === 'kimi' ? MODEL : null, provider: mode === 'kimi' ? 'moonshot' : null,
      missing: mode === 'kimi' ? [] : ['MOONSHOT_API_KEY'],
    });
  });

  app.post('/api/ai/plan', async (req, res) => {
    if (mode !== 'kimi') return res.status(503).json(notConfigured);
    if (!planLimit(req.ip ?? 'unknown')) return res.status(429).json({ error: 'too many plan requests', retryAfterMs: 2000 });
    const s = readSummary(req.body);
    if (typeof s === 'string') return res.status(400).json({ error: s });
    const t0 = Date.now();
    const { tick, secondsLeft, ...board } = s;
    const key = keyOf(mode, board);
    const hit = plans.get(key);
    if (hit) return res.json({ ...hit, latencyMs: Date.now() - t0, cached: true });

    let out;
    try {
      const k = await kimiPlan(s);
      out = { mode: 'kimi', model: MODEL, action: k.action, reason: k.reason, rounds: k.rounds };
    } catch (e) {
      // No plan is invented. The client's own classic bot plays this turn,
      // and says so.
      console.warn(`ai: Kimi plan failed (${e.kind ?? 'error'}: ${e.message})`);
      return res.status(502).json({ error: `Kimi did not answer (${e.kind ?? 'error'})`, kind: e.kind ?? 'error', latencyMs: Date.now() - t0 });
    }
    plans.set(key, out);
    res.json({ ...out, latencyMs: Date.now() - t0 });
  });

  app.post('/api/ai/commentary', async (req, res) => {
    if (mode !== 'kimi') return res.status(503).json(notConfigured);
    if (!lineLimit(req.ip ?? 'unknown')) return res.status(429).json({ error: 'too many commentary requests', retryAfterMs: 8000 });
    const ev = readEvents(req.body);
    if (typeof ev === 'string') return res.status(400).json({ error: ev });
    const t0 = Date.now();
    const key = keyOf(mode, ev);
    const hit = lines.get(key);
    if (hit) return res.json({ ...hit, latencyMs: Date.now() - t0, cached: true });

    let out;
    try {
      out = { mode: 'kimi', model: MODEL, line: await kimiLine(ev) };
    } catch (e) {
      return res.status(502).json({ error: `Kimi did not answer (${e.kind ?? 'error'})`, kind: e.kind ?? 'error' });
    }
    lines.set(key, out);
    res.json({ ...out, latencyMs: Date.now() - t0 });
  });
}
