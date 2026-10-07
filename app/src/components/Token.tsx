/**
 * A Crown — the game's soft currency.

 * Deliberately NOT $MEMPIRE. That is a real SPL token with a real pool, and
 * a currency the game *spends* has to be stable: if the traded price ran up
 * 50x, a chest skip would cost forty dollars and nobody would spend it; if it
 * went to zero the economy would be denominated in nothing. Either way the
 * balance is set by traders rather than by the game. Crowns are earned and
 * spent in-game and never leave it. $MEMPIRE is tradable and lives on the
 * Swap screen.
 *
 *
 * This used to be the 💎 emoji, which had two problems worth fixing rather
 * than living with. It rendered as whatever diamond the player's OS shipped —
 * flat and grey on Windows, blue and glossy on Apple, a different shape on
 * Android — so the game's own currency looked like a different currency
 * depending on who was looking at it. And it was a *generic* premium currency,
 * the one every free-to-play game has, when this game has an actual token with
 * an actual mint address and an actual pool behind it.
 *
 * Drawn as an SVG so it is one shape everywhere, scales to any size without
 * going soft, and inherits the crown that the rest of the chrome already uses.
 *
 * The ids are suffixed per-instance. Two of these on one screen with the same
 * gradient id would make the second silently reuse the first's fill — which is
 * fine until one of them is `dim` and both come out bright.
 */

let seq = 0;

export function Token({
  size = 16,
  dim = false,
  title,
}: {
  size?: number;
  /** For a cost the player cannot currently pay — desaturated, not hidden. */
  dim?: boolean;
  /**
   * Screen-reader text. Omit inside a label that already says "$MEMPIRE" or a
   * number followed by the coin — the icon is decorative there, and announcing
   * it twice is worse than not announcing it.
   */
  title?: string;
}) {
  // useId would be the React answer, but this renders inside deeply nested
  // lists that re-key on every shop rotation; a module counter is stable
  // enough and costs nothing.
  seq += 1;
  const id = `mem${seq}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={{
        display: 'inline-block',
        verticalAlign: '-0.15em',
        flexShrink: 0,
        filter: dim ? 'saturate(0.35) brightness(0.8)' : undefined,
      }}
    >
      <defs>
        {/* Struck metal: light from above, a warm core, a dark lower rim. */}
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffe9a8" />
          <stop offset="38%" stopColor="#ffc422" />
          <stop offset="100%" stopColor="#b87708" />
        </linearGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff4cf" />
          <stop offset="100%" stopColor="#a86e07" />
        </linearGradient>
      </defs>

      {/* rim, face, and the inner bevel that makes it a coin and not a disc */}
      <circle cx="16" cy="16" r="15" fill={`url(#${id}r)`} />
      <circle cx="16" cy="16" r="15" fill="none" stroke="#10203f" strokeWidth="2" />
      <circle cx="16" cy="16" r="12" fill={`url(#${id}f)`} />
      <circle
        cx="16" cy="16" r="12"
        fill="none" stroke="#10203f" strokeWidth="1.4" opacity="0.55"
      />

      {/* the crown, struck into the face — the same silhouette as the logo */}
      <path
        d="M8.5 21.2 L7 12.4 L12 16.2 L16 9.6 L20 16.2 L25 12.4 L23.5 21.2 Z"
        fill="#10203f"
        opacity="0.9"
      />
      <rect x="8.5" y="22.4" width="15" height="2.4" rx="0.9" fill="#10203f" opacity="0.9" />

      {/* Two jewels in the app's accent pair, violet and teal */}
      <circle cx="16" cy="18.4" r="1.5" fill="#9945ff" />
      <circle cx="11.4" cy="19.1" r="1" fill="#14f195" />
      <circle cx="20.6" cy="19.1" r="1" fill="#14f195" />

      {/* the highlight that sells it as metal rather than a printed circle */}
      <ellipse cx="12" cy="8.4" rx="5.2" ry="2.6" fill="#fff" opacity="0.34" />
    </svg>
  );
}

/**
 * An amount of Crowns: the number and the coin, kept together.
 *
 * Wrapped in one nowrap span on purpose — "1,200" and its coin landing on
 * different lines is the kind of thing that only shows up on the one narrow
 * phone you did not test on.
 */
export function TokenAmount({
  amount,
  size = 16,
  dim = false,
  style,
}: {
  amount: number;
  size?: number;
  dim?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        whiteSpace: 'nowrap', ...style,
      }}
    >
      {amount.toLocaleString()}
      <Token size={size} dim={dim} title={`${amount.toLocaleString()} Crowns`} />
    </span>
  );
}
