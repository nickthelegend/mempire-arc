import { IS_MAINNET } from '../chain/provider';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { click } from '../lib/audio';

/**
 * First-run coach marks on the Arena.
 *
 * Judges arrive cold: nothing else in the app explains that the deck is built
 * from coins you actually hold, or that Practice is free while Battle stakes
 * real SOL. Four steps, anchored to the real controls, shown once.
 *
 * Deliberately not a modal wizard over screenshots — each step spotlights the
 * live element itself (a scrim with a cutout), so what the player learns is
 * where the thing actually is. Skippable at every step; completion persists so
 * it never plays twice; "replay" lives in the account menu rather than nagging.
 */

const DONE_KEY = 'mempire_tutorial_done';

export interface TutorialStep {
  /** matches a data-tut attribute on the target element */
  anchor: string;
  title: string;
  body: string;
}

const STEPS: TutorialStep[] = [
  {
    anchor: 'deck',
    title: 'Any coin, your army',
    body: 'Every card is a real asset — a coin, a memecoin or a stock — as a fighter. You never have to hold it. Today\'s market buffs or nerfs it a little; win matches to earn duplicates and merge them to level it up.',
  },
  {
    anchor: 'tier',
    title: 'Pick your stakes',
    body: `Each tier stakes ${IS_MAINNET ? '' : 'testnet '}AUSD dollars or MON. Both players pay in, the contract pays the winner 90% of the pot — the house keeps 10%, and says so. Without a stake a match counts for rating only.`,
  },
  {
    anchor: 'practice',
    title: 'Learn for free',
    body: 'Practice is a full match with no stake, no rake, nothing recorded. Drag cards onto your half of the arena.',
  },
  {
    anchor: 'battle',
    title: 'Then fight for the pot',
    body: 'When the deck feels right, Battle matches you by deck power and escrows the stake. Fell towers, take crowns.',
  },
];

export const tutorialDone = (): boolean => {
  try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return true; }
};

export const resetTutorial = (): void => {
  try { localStorage.removeItem(DONE_KEY); } catch { /* private mode */ }
};

function markDone(): void {
  try { localStorage.setItem(DONE_KEY, '1'); } catch { /* private mode */ }
}

interface Rect { top: number; left: number; width: number; height: number }

export function Tutorial({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const current = STEPS[step];

  const measure = useCallback(() => {
    const el = document.querySelector<HTMLElement>(`[data-tut="${current.anchor}"]`);
    if (!el) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    setRect((prev) => (
      prev && prev.top === r.top && prev.left === r.left
        && prev.width === r.width && prev.height === r.height
        ? prev // identical — don't re-render
        : { top: r.top, left: r.left, width: r.width, height: r.height }
    ));
  }, [current.anchor]);

  /**
   * Bring the anchor into view once per step — not inside `measure`.
   *
   * It used to live in `measure`, which the scroll listener called, so every
   * scroll yanked the page back and the player could not look around.
   */
  useLayoutEffect(() => {
    document.querySelector<HTMLElement>(`[data-tut="${current.anchor}"]`)
      ?.scrollIntoView({ behavior: 'instant' as ScrollBehavior, block: 'center' });
    measure();
  }, [current.anchor, measure]);

  /**
   * Track the anchor every frame while the tutorial is open.
   *
   * Measuring once on mount left the hole wherever the element happened to be
   * at first paint — and this screen is still settling then: card art and the
   * ad boards load, fonts swap, the CTA breathes. `resize` and `scroll` do not
   * fire for an image finishing, so the spotlight silently drifted off its
   * target. One `getBoundingClientRect` per frame on a single element is cheap,
   * the overlay is transient, and `measure` bails out when nothing moved, so
   * this costs a comparison per frame rather than a re-render.
   */
  useEffect(() => {
    let raf = 0;
    const tick = () => { measure(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [measure]);

  const finish = () => { markDone(); onDone(); };
  const next = () => {
    click();
    if (step === STEPS.length - 1) finish();
    else setStep((s) => s + 1);
  };

  // A missing anchor (layout changed, element unmounted) skips forward rather
  // than trapping the player under a scrim with no hole.
  useEffect(() => {
    if (rect) return;
    const t = setTimeout(() => {
      if (step === STEPS.length - 1) finish();
      else setStep((s) => s + 1);
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, step]);

  if (!rect) return null;

  const pad = 7;
  const cut = {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };

  // Card above or below the cutout, whichever half has room.
  const below = cut.top + cut.height / 2 < window.innerHeight / 2;

  /**
   * Rendered into <body>, not in place.
   *
   * The spotlight positions from `getBoundingClientRect`, which is viewport
   * space — so the overlay must be in viewport space too. Any ancestor with a
   * transform (even an identity one left behind by an animation) silently
   * becomes the containing block for `position: fixed`, and the hole lands
   * offset by however far that ancestor sits from the viewport edge. A portal
   * makes that class of bug impossible rather than relying on no ancestor ever
   * growing a transform.
   */
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Tutorial step ${step + 1} of ${STEPS.length}: ${current.title}`}
      style={{ position: 'fixed', inset: 0, zIndex: 80 }}
    >
      {/* The scrim is the cutout: one element whose shadow floods everything
          around the hole. Taps on the scrim advance — nothing is ever locked. */}
      <div
        onClick={next}
        style={{
          position: 'absolute',
          top: cut.top,
          left: cut.left,
          width: cut.width,
          height: cut.height,
          borderRadius: 14,
          boxShadow: '0 0 0 200vmax rgba(6,16,38,.78)',
          border: '3px solid var(--gold)',
          pointerEvents: 'none',
          transition: 'all 240ms var(--ease-snap)',
        }}
      />
      {/* invisible full-screen tap-catcher under the card */}
      <div onClick={next} style={{ position: 'absolute', inset: 0 }} />

      <div
        className="panel"
        style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          ...(below
            ? { top: Math.min(cut.top + cut.height + 12, window.innerHeight - 210) }
            : { bottom: Math.max(window.innerHeight - cut.top + 12, 90) }),
          width: 'min(92vw, 360px)',
          padding: '14px 15px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="display display--sm" style={{ fontSize: 17, flex: 1 }}>
            {current.title}
          </span>
          <span className="label" style={{ fontSize: 12, flexShrink: 0 }}>
            {step + 1}/{STEPS.length}
          </span>
        </div>
        <p style={{ fontSize: 13.5, lineHeight: 1.4, color: 'var(--dim-on-wood)', margin: 0 }}>
          {current.body}
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
          <button
            onClick={() => { click(); finish(); }}
            className="menu-item"
            style={{
              minHeight: 44, padding: '0 12px', borderRadius: 9,
              fontSize: 13, fontWeight: 700, color: 'var(--dim-on-wood)',
            }}
          >
            Skip
          </button>
          <button
            onClick={next}
            className="btn-3d"
            style={{
              flex: 1, minHeight: 44, borderRadius: 'var(--r-pill)',
              background: 'linear-gradient(180deg, var(--btn-gold-hi), var(--btn-gold) 52%, var(--btn-gold-dark))',
              border: '2px solid var(--ink)',
              boxShadow: 'inset 0 2px 0 rgba(255,255,255,.45), 0 4px 0 var(--btn-gold-dark)',
              fontFamily: 'var(--font-display)', fontSize: 15, color: 'var(--text)',
              WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
              textTransform: 'uppercase', letterSpacing: '.03em',
            }}
          >
            {step === STEPS.length - 1 ? 'To battle' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
