import { useEffect, useRef, useState } from 'react';

/**
 * Shared motion primitives.
 *
 * Two rules hold everywhere in here:
 *
 * 1. **Reduced motion is honoured in JS, not just CSS.** The `prefers-reduced-motion`
 *    block in tokens.css collapses CSS durations, but a JS-driven count-up or a
 *    `behavior: 'smooth'` scroll keeps animating regardless. Anything in this file
 *    that moves over time checks the preference itself.
 * 2. **The final state is never hidden behind an animation.** Every hook lands
 *    exactly on its target value, and a hook that fails to run leaves the true
 *    value on screen rather than a zero or a blank.
 */

/** Read once per call — the user can change this mid-session. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Confident arrival. The one easing curve display motion should reach for. */
export const EASE_OUT_EXPO = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** Matches `--ease-snap` in tokens.css, for JS-driven motion that must agree with CSS. */
export const EASE_SNAP = 'cubic-bezier(0.2, 0.9, 0.3, 1)';

const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/**
 * Counts a number up to `target` on a rAF loop.
 *
 * DESIGN.md commits to "pot settle = gold coin burst + count-up in mono" — the
 * burst shipped and this did not, so the most consequential number in the product
 * used to simply appear. Money deserves the beat.
 *
 * Decelerates hard (ease-out-expo) so the value reads as arriving rather than
 * scrolling. Re-targets mid-flight from wherever it currently is, so a value that
 * changes twice in quick succession does not snap back to zero.
 */
export function useCountUp(target: number, durationMs = 900, delayMs = 0): number {
  const safeTarget = Number.isFinite(target) ? target : 0;
  // Reduced motion, or a tab that cannot animate, shows the truth immediately.
  const [value, setValue] = useState(() => (
    prefersReducedMotion() || typeof document === 'undefined' || document.hidden
      ? safeTarget
      : 0
  ));
  const frame = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safety = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef(value);

  useEffect(() => { current.current = value; }, [value]);

  useEffect(() => {
    if (prefersReducedMotion() || document.hidden) { setValue(safeTarget); return; }

    const from = current.current;
    if (from === safeTarget) return;

    let done = false;
    const land = () => { done = true; setValue(safeTarget); };

    let start = 0;
    const step = (now: number) => {
      if (done) return;
      if (!start) start = now;
      const t = Math.min(1, (now - start) / durationMs);
      // Land exactly on target — floating-point easing must not leave 0.0499
      if (t >= 1) land();
      else {
        setValue(from + (safeTarget - from) * easeOutExpo(t));
        frame.current = requestAnimationFrame(step);
      }
    };

    const begin = () => { frame.current = requestAnimationFrame(step); };
    if (delayMs > 0) timer.current = setTimeout(begin, delayMs);
    else begin();

    /**
     * The number must never be left mid-tween.
     *
     * `requestAnimationFrame` does not fire in a hidden or throttled tab, so a
     * player who backgrounds the app during the settle would come back to a
     * payout reading 0.00 SOL. `setTimeout` keeps running where rAF does not, so
     * this force-lands the true value slightly after the tween should have
     * finished. Losing the animation is acceptable; showing the wrong number is
     * not — and this is the payout screen.
     */
    safety.current = setTimeout(land, delayMs + durationMs + 220);
    // Also land immediately if the tab goes away mid-flight.
    const onHide = () => { if (document.hidden) land(); };
    document.addEventListener('visibilitychange', onHide);

    return () => {
      cancelAnimationFrame(frame.current);
      if (timer.current) clearTimeout(timer.current);
      if (safety.current) clearTimeout(safety.current);
      document.removeEventListener('visibilitychange', onHide);
    };
    // `value` is deliberately absent: including it would restart the tween on
    // every frame it sets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeTarget, durationMs, delayMs]);

  return value;
}

/**
 * Flips true a beat after mount, for staged entrances.
 *
 * Returns true immediately under reduced motion so nothing is gated behind a
 * timer the user asked not to run.
 */
export function useStaged(delayMs: number): boolean {
  const [on, setOn] = useState(() => prefersReducedMotion() || delayMs <= 0);
  useEffect(() => {
    if (on) return;
    const t = setTimeout(() => setOn(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs, on]);
  return on;
}

/**
 * Fires a one-shot keyframe animation on a ref whenever `key` changes.
 *
 * Driven off `element.animate()` rather than a React-managed CSS class because
 * the battle screen must never remount an ancestor of the WebGL canvas — that
 * drops the context. Skips the first run so a mount is not mistaken for a change.
 */
export function usePulse(
  key: number | string,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions = { duration: 320, easing: EASE_SNAP },
): React.RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null);
  const seen = useRef<number | string | null>(null);

  useEffect(() => {
    if (seen.current === null) { seen.current = key; return; } // skip mount
    if (seen.current === key) return;
    seen.current = key;
    if (!ref.current || prefersReducedMotion()) return;
    ref.current.animate(keyframes, options);
    // keyframes/options are literals at the call sites; keying on `key` is the intent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return ref;
}
