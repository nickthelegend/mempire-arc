import { useEffect, useState } from 'react';
import { keyedUrl } from '../lib/chromaKey';
import type { MintedCard } from '../state/collection';
import { coinByMint, tickerOf } from '../lib/coins';
import { ARCHETYPES } from '../sim/archetypes';
import { ArchetypeIcon, CoinBadge } from './ui';

/**
 * The portrait well: character art filling a tinted, inset panel.
 *
 * Its own component because the battle hand, the drag ghost and the next-card
 * preview all need exactly this and nothing else around it. They used to show
 * the round `CoinBadge` instead, which turned every fighter in the deck into an
 * identical coin token at the one moment the player is choosing between them.
 */
export function CardArtWell({
  mint, radius = 7, inset = 0, dim, badgeSize = 30,
}: {
  mint: string; radius?: number; inset?: number; dim?: boolean;
  /** Size of the round-badge fallback, for coins whose art has not landed. */
  badgeSize?: number;
}) {
  const [artFailed, setArtFailed] = useState(false);
  // undefined = still keying, null = not keyed (use the raw file), string = cut-out
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  const coin = coinByMint(mint);
  const art = coin?.cardArt;

  /*
   * Chroma-keyed art is shown as a cut-out over the card's own coloured well,
   * which reads far better than a pasted rectangle. Un-keyed art is used
   * as-is.
   *
   * Nothing renders until the key resolves, and that is the point. This used
   * to render `src={keyed ?? art}`, so the raw PNG went on screen while
   * `keyedUrl` fetched the *same URL* to key it — two requests for one file,
   * both in flight before either could populate the cache, and the browser
   * cancelled one. Twenty-two aborted requests a session on desktop and
   * thirty-five on mobile, which is the connection that can least afford it.
   *
   * `resolved` distinguishes three states that `keyed` alone could not:
   * undefined is still working, null is "this image is not keyed, use it
   * raw", and a string is the cut-out. Without the middle case an un-keyed
   * card would wait forever for a key that is never coming.
   */
  useEffect(() => {
    if (!art) return;
    let alive = true;
    void keyedUrl(art).then((u) => { if (alive) setResolved(u); });
    return () => { alive = false; };
  }, [art]);

  if (!coin) return null;

  return (
    <div style={{
      position: 'absolute', inset,
      borderRadius: radius,
      background: `linear-gradient(180deg, hsl(${coin.hue} 62% 42%), hsl(${coin.hue} 55% 22%))`,
      border: '2px solid rgba(0,0,0,.45)',
      boxShadow: 'inset 0 3px 7px rgba(0,0,0,.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
      filter: dim ? 'saturate(.35) brightness(.75)' : undefined,
    }}
    >
      {art && !artFailed && resolved !== undefined ? (
        <img
          src={resolved ?? art}
          alt=""
          aria-hidden
          draggable={false}
          // The art set fills in over time; a missing file falls back to the
          // badge rather than showing a broken image.
          onError={() => setArtFailed(true)}
          style={{
            width: '100%', height: '100%',
            // A cut-out is `contain` so the whole character is visible; a
            // full-bleed render is `cover` so it fills the well.
            objectFit: resolved ? 'contain' : 'cover',
            // The art is drawn head-up, so bias the crop toward the top: a
            // centred crop on a 3:4 portrait cuts the face off in a wide slot.
            objectPosition: '50% 18%',
            display: 'block',
          }}
        />
      ) : (
        <CoinBadge mint={mint} size={badgeSize} />
      )}
    </div>
  );
}

/**
 * The battle card. A thick beveled frame over a tinted portrait well, with the
 * elixir cost as a gem in the top-left and a level banner across the foot —
 * the Supercell card grammar, carrying a meme coin instead of a troop.
 */
export function CardFrame({
  card, width = 150, selected, dimmed, disabled, fluid, onClick,
}: {
  card: MintedCard; width?: number; selected?: boolean; dimmed?: boolean;
  disabled?: boolean; fluid?: boolean; onClick?: () => void;
}) {
  const coin = coinByMint(card.mint);
  if (!coin) return null;
  const cost = ARCHETYPES[card.archetype].elixir;
  const h = Math.round((width * 4) / 3);
  const Tag = onClick ? 'button' : 'div';
  const pad = Math.max(3, width * 0.035);

  return (
    <Tag
      onClick={onClick}
      disabled={Tag === 'button' ? disabled : undefined}
      aria-label={`${coin.ticker}, level ${card.level}, ${cost} elixir`}
      className={onClick ? 'btn-3d' : undefined}
      style={{
        width: fluid ? '100%' : width,
        maxWidth: '100%',
        aspectRatio: fluid ? '3 / 4' : undefined,
        height: fluid ? undefined : h,
        position: 'relative',
        flexShrink: fluid ? 1 : 0,
        padding: pad,
        borderRadius: Math.max(8, width * 0.075),
        border: '2.5px solid var(--ink)',
        background: selected
          ? 'linear-gradient(180deg, var(--btn-gold-hi), var(--btn-gold) 55%, var(--btn-gold-dark))'
          : 'linear-gradient(180deg, #8fa8d8, #5d76ad 52%, #3b4f7d)',
        boxShadow: selected
          ? 'inset 0 2px 0 rgba(255,255,255,.55), 0 4px 0 #7a4f04, 0 7px 12px rgba(0,0,0,.5)'
          : 'inset 0 2px 0 rgba(255,255,255,.4), 0 4px 0 #26324f, 0 7px 12px rgba(0,0,0,.45)',
        opacity: dimmed ? 0.5 : 1,
        transition: 'opacity 180ms var(--ease-snap), box-shadow 120ms var(--ease-snap)',
        textAlign: 'inherit' as never,
        display: 'block',
      }}
    >
      {/* Portrait well. Stops short of the foot so the level banner sits below
          the art rather than over it. */}
      <div style={{
        position: 'absolute', inset: pad, bottom: `${Math.max(22, width * 0.24)}px`,
      }}
      >
        <CardArtWell
          mint={card.mint}
          radius={Math.max(5, width * 0.05)}
          badgeSize={width * 0.56}
        />
      </div>

      {/* elixir cost gem */}
      <span
        aria-hidden
        style={{
          position: 'absolute', top: -Math.max(4, width * 0.045), left: -Math.max(3, width * 0.03),
          width: Math.max(19, width * 0.26), height: Math.max(19, width * 0.26),
          borderRadius: '50%',
          background: 'radial-gradient(circle at 34% 28%, #ff9cf5, var(--elixir) 58%, #7a1d7a)',
          border: '2.5px solid var(--ink)',
          boxShadow: 'inset 0 2px 0 rgba(255,255,255,.5), 0 2px 4px rgba(0,0,0,.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-display)',
          fontSize: Math.max(13, width * 0.16), color: '#fff',
          WebkitTextStroke: '2px var(--ink)', paintOrder: 'stroke fill',
        }}
      >
        {cost}
      </span>

      {/* archetype crest */}
      {width >= 66 && (
        <span style={{ position: 'absolute', top: pad + 2, right: pad + 2, opacity: 0.95 }}>
          <ArchetypeIcon archetype={card.archetype} size={Math.max(13, width * 0.17)} />
        </span>
      )}

      {/* level banner */}
      <div style={{
        position: 'absolute', left: pad, right: pad, bottom: pad,
        height: Math.max(18, width * 0.19),
        borderRadius: Math.max(4, width * 0.04),
        background: card.level >= 8
          ? 'linear-gradient(180deg, #ffd766, #d99b0d)'
          : 'linear-gradient(180deg, #2f4780, #1b2c56)',
        border: '2px solid var(--ink)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
      }}
      >
        <span style={{
          fontFamily: 'var(--font-display)',
          fontSize: Math.max(12, width * 0.115),
          color: card.level >= 8 ? '#3a2600' : '#fff',
          WebkitTextStroke: card.level >= 8 ? '0' : '1.6px var(--ink)',
          paintOrder: 'stroke fill',
          letterSpacing: '.03em', whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
        }}
        >
          {width >= 66 ? `${tickerOf(coin)} ${card.level}` : `L${card.level}`}
        </span>
      </div>
    </Tag>
  );
}
