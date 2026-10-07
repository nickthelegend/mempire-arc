import { useEffect, useState } from 'react';

const TIPS = [
  'Any meme coin can become a fighter. You do not have to hold it.',
  'Merge a duplicate card to raise its level. Winning is how you get them.',
  'Drag a card onto your half of the arena to deploy it.',
  'Fell a tower to earn a crown. Three crowns ends it early.',
  'Win a battle, earn a chest. Only four fit at a time.',
  '$MEMPIRE skips chest timers and buys upgrades. It never buys stats.',
  'A coin needs $25k liquidity and 48 hours to become a card.',
  'The house takes 10% of every pot, and says so up front.',
];

/**
 * Shown while the battle route and its models load. It exists so the arena is
 * never a blank rectangle: a loading screen that teaches is better than a
 * spinner, and this is the only moment a player is guaranteed to read.
 */
export function Loading({ label = 'Entering the arena' }: { label?: string }) {
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  const [pct, setPct] = useState(8);

  // Real load progress is not observable through Suspense, so the bar eases
  // toward 90% and the unmount completes it. Honest enough: it always moves,
  // and it never claims to be done while work remains.
  useEffect(() => {
    const t = setInterval(() => setPct((p) => (p < 90 ? p + Math.max(1, (90 - p) * 0.09) : p)), 90);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="quilt"
      style={{
        position: 'fixed', inset: 0, zIndex: 90,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 22, padding: '0 26px', textAlign: 'center',
      }}
    >
      <img
        src="/art/logo.webp"
        alt="Mempire"
        width={270}
        draggable={false}
        style={{ maxWidth: '78%', height: 'auto', animation: 'logoPulse 2.4s ease-in-out infinite' }}
      />

      <div style={{ width: '100%', maxWidth: 320 }}>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-label={label}
          style={{
            height: 22, borderRadius: 8, overflow: 'hidden',
            background: 'var(--recess)',
            border: '2.5px solid var(--ink)', boxShadow: 'var(--bevel-in)',
          }}
        >
          {/* progress is the violet beam, not the gold button face — gold in this
              world means SOL is moving, and nothing is moving here */}
          <div style={{
            height: '100%',
            background: 'var(--grad-solana)',
            boxShadow: 'inset 0 2px 0 rgba(255,255,255,.35)',
            // scale rather than width — animating width thrashes layout
            transform: `scaleX(${pct / 100})`,
            transformOrigin: 'left',
            transition: 'transform 220ms linear',
          }}
          />
        </div>
        <p className="display display--sm" style={{ fontSize: 15, marginTop: 8 }}>
          {label}… {Math.round(pct)}%
        </p>
      </div>

      <p className="fine" style={{ maxWidth: 320, fontSize: 13 }}>{tip}</p>

      <style>{'@keyframes logoPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}'}</style>
    </div>
  );
}
