import { leagueFor, leagueProgress, nextLeague } from '../lib/ranking';

/**
 * Trophy count and league, drawn rather than shipped as art.
 *
 * A drawn badge means a new league costs one row in `LEAGUES` and no asset
 * pipeline, and it stays crisp at 22px in a ladder row or 64px in a header.
 * The hue comes from the league itself, so the badge and the progress bar
 * always agree without a second source of truth.
 */
export function LeagueBadge({
  trophies, size = 44, showName = false,
}: { trophies: number; size?: number; showName?: boolean }) {
  const league = leagueFor(trophies);
  const gid = `lg_${league.hue}`;

  const badge = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`${league.name}, ${trophies} trophies`}
      style={{ display: 'block', flexShrink: 0, filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.5))' }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`hsl(${league.hue} 70% 62%)`} />
          <stop offset="100%" stopColor={`hsl(${league.hue} 65% 34%)`} />
        </linearGradient>
        <linearGradient id={`${gid}_g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffe38a" />
          <stop offset="55%" stopColor="#ffc422" />
          <stop offset="100%" stopColor="#c58a06" />
        </linearGradient>
      </defs>
      {/* shield */}
      <path
        d="M50 5 L90 18 C90 56 77 82 50 95 C23 82 10 56 10 18 Z"
        fill={`url(#${gid})`}
        stroke="#10203f"
        strokeWidth={5}
      />
      <path
        d="M50 5 L90 18 C90 56 77 82 50 95 C23 82 10 56 10 18 Z"
        fill="none"
        stroke="rgba(255,255,255,.3)"
        strokeWidth={3}
        transform="translate(50 50) scale(0.8) translate(-50 -50)"
      />
      {/* a trophy cup, gold — the one place gold is not money, because it *is*
          the trophy the count refers to */}
      <path
        d="M35 30 H65 V44 A15 15 0 0 1 35 44 Z M30 32 A7 7 0 0 0 35 42 M70 32 A7 7 0 0 1 65 42 M46 59 H54 V68 H46 Z M38 68 H62 V74 H38 Z"
        fill={`url(#${gid}_g)`}
        stroke="#10203f"
        strokeWidth={3.5}
        strokeLinejoin="round"
      />
    </svg>
  );

  if (!showName) return badge;

  const next = nextLeague(trophies);
  const pct = leagueProgress(trophies);

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      {badge}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="display display--sm" style={{ display: 'block', fontSize: 15 }}>
          {league.name}
        </span>
        <span
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            fontFamily: 'var(--font-display)', fontSize: 13,
            color: 'var(--blue-pale)',
            WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
          }}
        >
          <span aria-hidden style={{ WebkitTextStroke: '0', color: 'var(--gold)' }}>🏆</span>
          {trophies.toLocaleString()}
        </span>
        {next && (
          <span
            style={{
              display: 'block', marginTop: 4, height: 6, borderRadius: 3,
              background: 'var(--recess)', boxShadow: 'var(--bevel-in)', overflow: 'hidden',
            }}
          >
            {/* scaleX rather than width — animating width thrashes layout, and
                the elixir bar and loading bar already use this pattern. */}
            <span
              style={{
                display: 'block', height: '100%', width: '100%',
                background: `linear-gradient(90deg, hsl(${league.hue} 70% 55%), hsl(${league.hue} 75% 68%))`,
                transform: `scaleX(${pct})`,
                transformOrigin: 'left',
                transition: 'transform 420ms var(--ease-snap)',
              }}
            />
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * The trophy change after a ranked match.
 *
 * Shows the floor when it absorbs a loss, because a player who "lost" zero
 * trophies deserves to know why rather than assuming the ladder is broken.
 */
export function TrophyDelta({
  delta, floored, size = 17,
}: { delta: number; floored?: boolean; size?: number }) {
  const up = delta > 0;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontFamily: 'var(--font-display)', fontSize: size,
        color: up ? 'var(--teal)' : floored ? 'var(--dim)' : 'var(--red-on-wood)',
        WebkitTextStroke: '2px var(--ink)', paintOrder: 'stroke fill',
        animation: 'valueBump 460ms cubic-bezier(0.16,1,0.3,1) both',
      }}
    >
      <span aria-hidden style={{ WebkitTextStroke: '0', color: 'var(--gold)', fontSize: size - 2 }}>🏆</span>
      {up ? `+${delta}` : delta}
      {floored && (
        <span className="label" style={{ fontSize: 12, WebkitTextStroke: '0' }}>
          league floor
        </span>
      )}
    </span>
  );
}
