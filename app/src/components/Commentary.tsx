import { useEffect, useRef, useState } from 'react';
import {
  LANE_NAMES, brainLabel, laneOf, requestCommentary, useAiOpponent,
  type AiMode, type CommentaryEvent,
} from '../lib/ai';
import { hasApi } from '../lib/api';
import { prefersReducedMotion } from '../lib/motion';
import { FP } from '../sim/fixed';
import { useMatch } from '../state/match';

/*
 * The caster, and the badge that says who is playing the other seat.
 *
 * Both are presentation only. Commentary reads the sim after each step and
 * never writes to it; the badge reads the AI store. Nothing here can change a
 * match — which is why the caster runs on a slow clock and the sim does not.
 */

/** One line per this long, at most: a ticker, not a chat. */
const LINE_EVERY_MS = 8_000;
/** A fighter this far off neutral today is worth a mention. */
const META_NOTE_BPS = 500;
const ELIXIR_LEAD = 4;
/** Don't call the same elixir lead every eight seconds. */
const ELIXIR_NOTE_EVERY_TICKS = 400;
const MAX_EVENTS = 6;

const shell: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '3px 9px', borderRadius: 999,
  background: 'var(--recess)', border: '2px solid var(--ink)',
  boxShadow: 'var(--bevel-in)', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
};

/**
 * Which brain holds the opponent's seat, and its last decision.
 *
 * "Classic bot covering" whenever Kimi did not answer — a timeout, an unusable
 * answer, the relay down — so a judge never reads a lookup table as a model.
 * The reason is the model's own, clipped.
 */
export function OpponentBrainBadge() {
  const active = useAiOpponent((s) => s.active);
  const live = useAiOpponent((s) => s.live);
  const status = useAiOpponent((s) => s.status);
  const mode: AiMode | null = live?.source === 'relay' ? live.mode : (status?.mode ?? null);
  const label = brainLabel(active, mode);
  const covering = active === 'kimi' && live?.source === 'local';
  const fellBack = active === 'kimi' && live?.source === 'relay' && live.fallback;
  const dot = active === 'classic' ? 'var(--dim)' : mode === 'kimi' && !covering ? 'var(--teal)' : 'var(--gold)';
  const detail = active === 'classic' ? null
    : covering ? 'classic bot covering'
      : fellBack ? `fallback: ${live.fallback}`
        : live?.reason ?? 'thinking…';
  const title = active === 'classic'
    ? 'The rule-based bot plays this seat'
    : `${label}${status?.model && mode === 'kimi' ? ` · ${status.model}` : ''} plays this seat${live?.reason ? ` — last: ${live.reason}` : ''}${live?.latencyMs !== undefined ? ` (${live.latencyMs} ms)` : ''}`;
  return (
    <span style={shell} title={title} aria-label={title}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
      <span>{label}</span>
      {detail && (
        <span style={{
          color: 'var(--dim)', fontWeight: 600, maxWidth: 150,
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}
        >
          · {detail}
        </span>
      )}
    </span>
  );
}

/**
 * The caster ticker.
 *
 * Watches the sim for things worth a line — a tower falling, a spell landing,
 * a buffed or nerfed fighter hitting the board, a swarm, an elixir lead, the
 * clock changing phase — and every eight seconds sends the newest few to the
 * relay for one line. Bot matches only: the prompt calls the other seat an AI,
 * and in a human match that would be a lie.
 */
export function Commentary() {
  const sim = useMatch((s) => s.sim);
  const version = useMatch((s) => s.version);
  const perspective = useMatch((s) => s.perspective);
  const mode = useMatch((s) => s.mode);
  const active = useAiOpponent((s) => s.active);
  const opponentName = useMatch((s) => s.opponentName);
  const aiName = active === 'kimi' ? 'Kimi' : opponentName.replace(/\s*\(AI\)$/, '') || 'the bot';
  // Commentary is Kimi's, so it runs only when the relay runs Kimi.
  const kimiOn = useAiOpponent((s) => s.status?.mode === 'kimi');
  const enabled = mode === 'bot' && hasApi() && kimiOn;

  const [line, setLine] = useState<{ text: string; mode: AiMode; id: number } | null>(null);
  const events = useRef<CommentaryEvent[]>([]);
  const seen = useRef({
    sim: null as unknown,
    towers: [] as boolean[],
    nextUnitId: 1,
    spells: new Set<string>(),
    meta: new Set<string>(),
    phase: '',
    doubled: false,
    elixirAt: -ELIXIR_NOTE_EVERY_TICKS,
  });

  // Event detection, once per sim step.
  useEffect(() => {
    if (!enabled || !sim) return;
    const s = seen.current;
    const push = (e: CommentaryEvent) => {
      events.current.push(e);
      if (events.current.length > MAX_EVENTS) events.current.shift();
    };
    const sideOf = (owner: 0 | 1): 'you' | 'ai' => (owner === perspective ? 'you' : 'ai');

    if (s.sim !== sim) {
      // A new match: reset everything and open with a kickoff line.
      s.sim = sim;
      s.towers = sim.towers.map((t) => t.hp > 0);
      s.nextUnitId = sim.nextUnitId;
      s.spells = new Set();
      s.meta = new Set();
      s.phase = sim.phase;
      s.doubled = false;
      s.elixirAt = -ELIXIR_NOTE_EVERY_TICKS;
      events.current = [{ kind: 'kickoff', side: 'ai' }];
      setLine(null);
      return;
    }

    sim.towers.forEach((t, i) => {
      if (s.towers[i] && t.hp <= 0) {
        // The side that *felled* it gets the credit.
        push({
          kind: 'tower_down', side: sideOf((1 - t.owner) as 0 | 1),
          ...(t.lane >= 0 ? { lane: LANE_NAMES[t.lane as 0 | 1] } : {}),
        });
      }
      s.towers[i] = t.hp > 0;
    });

    for (const sp of sim.spells) {
      const key = `${sp.owner}:${sp.explodeTick}:${sp.cardIndex}`;
      if (s.spells.has(key)) continue;
      s.spells.add(key);
      push({ kind: 'spell', side: sideOf(sp.owner), ticker: sim.players[sp.owner].deck[sp.cardIndex]?.name });
    }

    // New units since last step, grouped by the card that spawned them.
    const fresh = new Map<string, { owner: 0 | 1; card: number; count: number; x: number; bps: number }>();
    for (const u of sim.units) {
      if (u.id < s.nextUnitId) continue;
      const k = `${u.owner}:${u.cardIndex}`;
      const f = fresh.get(k) ?? { owner: u.owner, card: u.cardIndex, count: 0, x: u.x, bps: u.metaBps };
      f.count += 1;
      fresh.set(k, f);
    }
    s.nextUnitId = sim.nextUnitId;
    for (const f of fresh.values()) {
      const ticker = sim.players[f.owner].deck[f.card]?.name;
      if (f.count >= 4) push({ kind: 'swarm', side: sideOf(f.owner), ticker, lane: LANE_NAMES[laneOf(f.x)] });
      if (ticker && Math.abs(f.bps) >= META_NOTE_BPS && !s.meta.has(ticker)) {
        s.meta.add(ticker);
        push({ kind: f.bps > 0 ? 'buffed' : 'nerfed', side: sideOf(f.owner), ticker, bps: f.bps });
      }
    }

    const doubled = sim.tick >= sim.format.doubleElixirAt;
    if (doubled && !s.doubled && sim.phase === 'regulation') push({ kind: 'double_elixir', side: 'ai' });
    s.doubled = doubled;
    if (sim.phase === 'overtime' && s.phase !== 'overtime') push({ kind: 'overtime', side: 'ai' });
    s.phase = sim.phase;

    if (sim.tick - s.elixirAt >= ELIXIR_NOTE_EVERY_TICKS) {
      const mine = sim.players[perspective].elixirFP / FP;
      const theirs = sim.players[(1 - perspective) as 0 | 1].elixirFP / FP;
      if (Math.abs(mine - theirs) >= ELIXIR_LEAD) {
        s.elixirAt = sim.tick;
        push({ kind: 'elixir_lead', side: mine > theirs ? 'you' : 'ai', amount: Math.floor(Math.abs(mine - theirs)) });
      }
    }
  }, [enabled, sim, version, perspective]);

  // The line clock: at most one request per LINE_EVERY_MS, none in flight twice.
  useEffect(() => {
    if (!enabled) return undefined;
    let busy = false;
    let last = 0;
    let id = 0;
    let alive = true;
    const timer = setInterval(() => {
      if (busy || !events.current.length || Date.now() - last < LINE_EVERY_MS) return;
      if (useMatch.getState().sim?.phase === 'ended') return;
      const batch = events.current;
      events.current = [];
      busy = true;
      last = Date.now();
      requestCommentary(batch, aiName)
        .then((r) => { if (alive && r?.line) setLine({ text: r.line, mode: r.mode, id: (id += 1) }); })
        .catch(() => { /* the ticker just stays quiet */ })
        .finally(() => { busy = false; });
    }, 1_000);
    return () => { alive = false; clearInterval(timer); };
  }, [enabled, aiName]);

  if (!enabled || !line) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ display: 'flex', justifyContent: 'center', padding: '0 8px', pointerEvents: 'none' }}
    >
      <style>{'@keyframes castIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}'}</style>
      <span
        key={line.id}
        style={{
          display: 'inline-flex', alignItems: 'baseline', gap: 6, maxWidth: '100%',
          padding: '3px 10px', borderRadius: 8,
          background: 'rgba(6,16,38,.55)', fontSize: 12, fontWeight: 700,
          animation: prefersReducedMotion() ? undefined : 'castIn 260ms ease-out',
        }}
      >
        <span style={{ color: 'var(--gold)', fontSize: 10, letterSpacing: '.12em', flexShrink: 0 }}>
          KIMI CAST
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{line.text}</span>
      </span>
    </div>
  );
}
