import { useState, type CSSProperties, type ReactNode } from 'react';
import { ARCHETYPE_NAMES, type Archetype } from '../sim/types';
import { click } from '../lib/audio';
import { coinByMint } from '../lib/coins';
import { fmtMon } from '../lib/format';
import { useCountUp } from '../lib/motion';

type Tone = 'gold' | 'blue' | 'green' | 'red';

const TONES: Record<Tone, { top: string; mid: string; base: string }> = {
  gold: { top: 'var(--btn-gold-hi)', mid: 'var(--btn-gold)', base: 'var(--btn-gold-dark)' },
  blue: { top: 'var(--btn-blue-hi)', mid: 'var(--btn-blue)', base: 'var(--btn-blue-dark)' },
  green: { top: 'var(--btn-green-hi)', mid: 'var(--btn-green)', base: 'var(--btn-green-dark)' },
  red: { top: '#ff8fa3', mid: 'var(--red)', base: '#a01930' },
};

/**
 * The arcade button. A solid colour face over a hard base edge, so it reads as
 * a physical key — and presses into its own shadow on tap. Everything
 * clickable in the game uses this; nothing is a flat rectangle.
 *
 * `ghost` is a live secondary control and `disabled` is a dead one, so they must
 * not look alike: they used to share one flat recipe, which made "Keep fighting"
 * read as switched off next to a fully lit "Forfeit" on the one confirm that
 * costs real SOL.
 */
export function Pill({
  children, onClick, disabled, ghost, danger, tone = 'gold', style,
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  ghost?: boolean; danger?: boolean; tone?: Tone; style?: CSSProperties;
}) {
  const t = TONES[danger ? 'red' : tone];
  const raised = !ghost && !disabled;
  return (
    <button
      onClick={onClick ? () => { click(); onClick(); } : undefined}
      disabled={disabled}
      className="btn-3d"
      style={{
        display: 'block', width: '100%', padding: '13px 22px',
        borderRadius: 'var(--r-pill)',
        background: raised
          ? `linear-gradient(180deg, ${t.top} 0%, ${t.mid} 46%, ${t.mid} 100%)`
          : disabled
            ? 'var(--recess)'
            : 'linear-gradient(180deg, rgba(90,140,210,.5), rgba(23,62,110,.62))',
        border: `3px solid ${disabled ? 'rgba(0,0,0,.45)' : 'var(--ink)'}`,
        color: disabled ? 'var(--dim)' : 'var(--text)',
        fontFamily: 'var(--font-display)',
        fontWeight: 400, fontSize: 17, letterSpacing: '0.04em', textTransform: 'uppercase',
        WebkitTextStroke: disabled ? '0' : '2.5px var(--ink)',
        paintOrder: 'stroke fill',
        minHeight: 48,
        boxShadow: raised
          ? `inset 0 2px 0 rgba(255,255,255,.5), inset 0 -4px 0 rgba(0,0,0,.22), 0 5px 0 ${t.base}, 0 9px 14px rgba(0,0,0,.45)`
          : disabled
            ? 'var(--bevel-in)'
            : 'inset 0 2px 0 rgba(255,255,255,.3), inset 0 -3px 0 rgba(0,0,0,.24), 0 4px 0 var(--btn-blue-dark), 0 7px 12px rgba(0,0,0,.4)',
        transition: 'transform 90ms var(--ease-snap), box-shadow 90ms var(--ease-snap), filter 140ms',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** Inline pending mark. A pending action must look different from a dead one. */
export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <>
      <span
        aria-hidden
        style={{
          width: size, height: size, flexShrink: 0, borderRadius: '50%',
          border: `${Math.max(2, size * 0.17)}px solid rgba(0,0,0,.35)`,
          borderTopColor: 'rgba(255,255,255,.95)',
          display: 'inline-block',
          animation: 'spin 720ms linear infinite',
        }}
      />
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </>
  );
}

/** Round coin logo. Generated art when present; procedural fallback otherwise. */
/**
 * A coin, as its fighter.
 *
 * This used to render two letters in a coloured circle — "SB", "QQ" — because
 * it only looked at `logoUrl`, and not one seeded coin has one. So the Daily
 * Shop, the screen whose whole job is to make you want a card, showed a grid
 * of initials while the actual character art sat unused two fields away.
 *
 * Every coin has `cardArt`. The art is a 3:4 portrait, so it is cropped to the
 * top third and scaled up: that lands the character's head in the circle
 * rather than their chest, which is the difference between a face and a blob.
 * The initials survive as a real fallback for a missing file, not as the
 * default path.
 */
export function CoinBadge({ mint, size = 40 }: { mint: string; size?: number }) {
  const coin = coinByMint(mint);
  const [artFailed, setArtFailed] = useState(false);
  if (!coin) return null;

  const art = !artFailed ? (coin.cardArt ?? coin.logoUrl) : null;
  const ring = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    border: '2px solid var(--gold)',
    boxShadow: `inset 0 -3px 6px rgba(0,0,0,.35), 0 ${Math.max(1, size * 0.03)}px ${size * 0.08}px rgba(0,0,0,.45)`,
    background: `radial-gradient(circle at 32% 28%, hsl(${coin.hue} 85% 62%), hsl(${coin.hue} 80% 34%))`,
    overflow: 'hidden',
  } as const;

  if (art) {
    return (
      <div style={ring} role="img" aria-label={coin.ticker}>
        <img
          src={art}
          alt=""
          aria-hidden
          loading="lazy"
          draggable={false}
          onError={() => setArtFailed(true)}
          style={{
            // 3:4 art, cropped to the head. `objectPosition` at the top and a
            // width overshoot together frame the face; `contain` would letterbox
            // it into a stripe and `cover` alone centres on the torso.
            width: '135%',
            height: '135%',
            marginLeft: '-17.5%',
            marginTop: '-6%',
            objectFit: 'cover',
            objectPosition: 'center top',
            display: 'block',
          }}
        />
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={coin.ticker}
      style={{
        ...ring,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontWeight: 800,
        fontSize: size * 0.32,
        textShadow: '0 1px 2px rgba(0,0,0,.5)',
        letterSpacing: '-0.02em',
      }}
    >
      {coin.ticker.slice(0, 2)}
    </div>
  );
}

const ARCH_SLUGS = ['tank', 'swarm', 'ranged', 'splash', 'support', 'spell'] as const;

/** Archetype crest. Generated gold icon, with a text-only fallback. */
export function ArchetypeIcon({ archetype, size = 14 }: { archetype: Archetype; size?: number }) {
  return (
    <img
      src={`/art/icon_${ARCH_SLUGS[archetype]}.webp`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      draggable={false}
      style={{ display: 'block', flexShrink: 0 }}
      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
    />
  );
}

export function ArchetypeTag({ archetype }: { archetype: Archetype }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 12, fontWeight: 700, letterSpacing: '0.06em',
      color: 'var(--dim)', textTransform: 'uppercase',
    }}
    >
      <ArchetypeIcon archetype={archetype} />
      {ARCHETYPE_NAMES[archetype]}
    </span>
  );
}

/** Level as 10 gold pips — the card's power at a glance. */
export function LevelPips({ level }: { level: number }) {
  return (
    <div style={{ display: 'flex', gap: 3 }} role="img" aria-label={`Level ${level} of 10`}>
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          style={{
            width: 6, height: 6, borderRadius: '50%',
            // an unfilled pip is a hole punched in the wood, not a navy dot —
            // both consumers of this are wood sheets
            background: i < level ? 'var(--gold)' : 'rgba(0,0,0,.45)',
            border: i < level ? 'none' : '1px solid rgba(0,0,0,.5)',
            boxShadow: i < level
              ? '0 0 4px rgba(255,196,34,.6)'
              : 'inset 0 1px 2px rgba(0,0,0,.5)',
          }}
        />
      ))}
    </div>
  );
}

export function Crowns({ n, size = 13 }: { n: number; size?: number }) {
  return (
    <span
      role="img"
      aria-label={`${n} crown${n === 1 ? '' : 's'}`}
      style={{ color: 'var(--gold)', fontSize: size, letterSpacing: 1 }}
    >
      <span aria-hidden>{'♛'.repeat(n)}</span>
    </span>
  );
}

/**
 * Counts an amount up into place, formatted in the match's own currency (AUSD
 * reads as dollars). Split out so `MoneyRow` can stay a plain component when
 * the number is static — a hook cannot be called conditionally.
 */
function CountedAmount({
  to, prefix, delayMs, style, format,
}: { to: number; prefix?: string; delayMs?: number; style: CSSProperties; format: (n: number) => string }) {
  const shown = useCountUp(to, 950, delayMs);
  return (
    <span className="money" style={style}>
      {prefix}
      {format(shown)}
    </span>
  );
}

/**
 * The sacred money readout: gold, exact, never abbreviated. A carved well with
 * a gold rim — it was the last flat 1px rectangle in the game, which made the
 * pot look less real than the buttons around it.
 *
 * `stack` puts the label above the value — required in narrow two-column grids
 * where side-by-side collides at 375px.
 *
 * `count` makes the number arrive instead of appear. DESIGN.md always specified
 * a count-up on settle; this is where it lives. The static `value` is still the
 * accessible truth, so a failed tween can never leave a wrong number on screen.
 */
export function MoneyRow({
  label, value, big, stack, count,
}: {
  label: string; value: string; big?: boolean; stack?: boolean;
  /** `format` defaults to MON; pass the match currency's formatter for AUSD. */
  count?: { to: number; prefix?: string; delayMs?: number; format?: (n: number) => string };
}) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: stack ? 'column' : 'row',
      alignItems: stack ? 'flex-start' : 'baseline',
      justifyContent: stack ? 'center' : 'space-between',
      gap: stack ? 2 : 8,
      padding: big ? '13px 15px' : '10px 13px',
      background: 'var(--recess)',
      border: '2px solid var(--gold)',
      boxShadow: 'var(--bevel-in), 0 0 0 1px rgba(0,0,0,.5)',
      borderRadius: 'var(--r-card)', minWidth: 0,
    }}
    >
      <span className="label" style={{ minWidth: 0, whiteSpace: 'nowrap' }}>{label}</span>
      {count ? (
        <CountedAmount
          to={count.to}
          prefix={count.prefix}
          delayMs={count.delayMs}
          format={count.format ?? fmtMon}
          style={{ fontSize: big ? 21 : 14, whiteSpace: 'nowrap', flexShrink: 0 }}
        />
      ) : (
        <span
          className="money"
          style={{ fontSize: big ? 21 : 14, whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {value}
        </span>
      )}
    </div>
  );
}
