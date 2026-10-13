import { useEffect, useRef, useState } from 'react';
import { FP } from '../sim/fixed';
import { RIVER_BOT, RIVER_TOP } from '../sim/engine';
import type { SimState } from '../sim/types';
import { useMatch } from '../state/match';
import { Pill } from './ui';

/*
 * A coached first match.
 *
 * The intro tour explains stakes; this teaches the board, inside a real
 * Practice match, one step at a time. Each step advances on what the player
 * actually does in the sim — a deploy, an elixir spend, a fighter across the
 * river, damage on an enemy tower — never on a timer, so it cannot run ahead of
 * someone still finding the hand. Once per device; "Replay tutorial" in the
 * account menu brings it back.
 */

const DONE_KEY = 'mempire_coach_done';
export const coachDone = (): boolean => {
  try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return true; }
};
export const resetCoach = (): void => {
  try { localStorage.removeItem(DONE_KEY); } catch { /* private mode */ }
};
const markDone = () => { try { localStorage.setItem(DONE_KEY, '1'); } catch { /* private mode */ } };

interface Step { title: string; body: string; done: (s: SimState, me: 0 | 1, ctx: { deploys: number }) => boolean }

const STEPS: Step[] = [
  {
    title: 'Drop a fighter',
    body: 'Drag a card from your hand onto your half of the arena — anywhere below the river.',
    done: (_s, _me, ctx) => ctx.deploys >= 1,
  },
  {
    title: 'Mind the elixir',
    body: 'Each card costs elixir — the purple bar. It refills on its own. Wait for enough, then drop a second card.',
    done: (_s, _me, ctx) => ctx.deploys >= 2,
  },
  {
    title: 'Cross the river',
    body: 'Fighters walk their lane and cross at the bridges. Get one onto the enemy side.',
    done: (s, me) => s.units.some((u) => u.owner === me && (me === 0 ? u.y > RIVER_BOT : u.y < RIVER_TOP)),
  },
  {
    title: 'Hit a tower',
    body: 'Towers shoot back. Push into one — fell a tower for a crown, three crowns win outright.',
    done: (s, me) => s.towers.some((t) => t.owner !== me && t.hp < t.maxHp),
  },
];

export function Coach() {
  const practice = useMatch((s) => s.practice);
  const perspective = useMatch((s) => s.perspective);
  const [active, setActive] = useState(() => !coachDone());
  const [step, setStep] = useState(0);
  const deploys = useRef(0);
  const lastElixir = useRef<number | null>(null);

  useEffect(() => {
    if (!practice || !active || step >= STEPS.length) return;
    const iv = setInterval(() => {
      const sim = useMatch.getState().sim;
      if (!sim) return;
      // A deploy is an elixir spend of at least one whole elixir between samples.
      const e = sim.players[perspective].elixirFP;
      if (lastElixir.current !== null && lastElixir.current - e >= FP) deploys.current += 1;
      lastElixir.current = e;
      if (STEPS[step].done(sim, perspective, { deploys: deploys.current })) setStep((n) => n + 1);
    }, 150);
    return () => clearInterval(iv);
  }, [practice, active, step, perspective]);

  if (!practice || !active) return null;
  const finished = step >= STEPS.length;
  const s = STEPS[Math.min(step, STEPS.length - 1)];
  const close = () => { markDone(); setActive(false); };

  return (
    <section
      role="dialog"
      aria-label="Coach"
      aria-live="polite"
      className="panel"
      style={{
        position: 'absolute', left: 12, right: 12, top: 132, zIndex: 20, margin: '0 auto', maxWidth: 380,
        padding: '10px 12px', display: 'grid', gap: 6, pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="display display--sm" style={{ fontSize: 16 }}>{finished ? 'You’ve got it' : s.title}</span>
        <span className="label" style={{ marginLeft: 'auto', fontSize: 11 }}>
          {finished ? 'done' : `${step + 1}/${STEPS.length}`}
        </span>
      </div>
      <p className="fine" style={{ margin: 0, fontSize: 13, color: 'var(--dim-on-wood)' }}>
        {finished
          ? 'That is the whole game. Finish this practice, then stake a dollar of USDC in Ranked — the contract pays the winner.'
          : s.body}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        {finished
          ? <Pill onClick={close} style={{ minHeight: 40, fontSize: 14 }}>Finish</Pill>
          : <Pill ghost onClick={close} style={{ minHeight: 40, fontSize: 14 }}>Skip coaching</Pill>}
      </div>
    </section>
  );
}
