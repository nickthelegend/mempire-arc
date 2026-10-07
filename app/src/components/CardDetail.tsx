import { DEPLOYMENT, explorerUrl } from '../chain/provider';
import { useEffect, useRef } from 'react';
import { useChain } from '../state/chain';
import { coinByMint, tickerOf } from '../lib/coins';
import { fmtUsd } from '../lib/format';
import { ARCHETYPES, scaleByLevel } from '../sim/archetypes';
import { TRAITS, effectiveDef, traitForMint } from '../sim/traits';
import { loreFor } from '../data/lore';

/**
 * Where a shared card lives.
 *
 * The marketing site, not this app — it is the one that server-renders meta
 * tags. Override with VITE_SHARE_ORIGIN if the landing page moves.
 */
const SHARE_ORIGIN = (import.meta.env.VITE_SHARE_ORIGIN as string | undefined)
  ?? 'https://mempire.fun';

/** The X handle, without the @. Mirrors X_HANDLE in the landing site's site.ts. */
const X_HANDLE = 'MempireFun';
import { ARCHETYPE_NAMES } from '../sim/types';
import { FP } from '../sim/fixed';
import type { MintedCard } from '../state/collection';
import { ArchetypeIcon, CoinBadge, LevelPips } from './ui';

/** One labelled stat plate — the Supercell card-info grammar. */
function Stat({ icon, label, value, delta }: {
  icon: string; label: string; value: string; delta?: string;
}) {
  return (
    <div className="well" style={{ padding: '7px 9px', display: 'flex', alignItems: 'center', gap: 7 }}>
      <span aria-hidden style={{ fontSize: 15 }}>{icon}</span>
      <span style={{ minWidth: 0 }}>
        <span className="label" style={{ fontSize: 12, display: 'block' }}>{label}</span>
        <span className="display display--sm" style={{ fontSize: 15 }}>
          {value}
          {delta && (
            <span style={{ color: 'var(--teal)', fontSize: 12, marginLeft: 4 }}>{delta}</span>
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * Full card inspector. Two jobs: show the coin as a real asset (its own art and
 * live market data) and show it as a game piece (stats at this level, and the
 * exact cost of the next one). Seeing both together is what turns a browse into
 * a stake.
 */
export function CardDetail({
  card, onClose,
}: { card: MintedCard; onClose: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const coin = coinByMint(card.mint);
  const chainCards = useChain((s) => s.cards);
  /*
   * The onchain twin of this card, if it has one. On Monad every card is an
   * ERC-721 from the moment it is minted, so there is no separate tokenise
   * step — just a link to the token itself.
   */
  const onChain = chainCards.find((c) => c.mint === card.mint);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    sheet.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!coin) return null;
  const lore = loreFor(coin.ticker);
  const traitId = traitForMint(card.mint);
  const trait = TRAITS[traitId];
  // The trait, folded in — the same numbers the simulation will actually use.
  // Showing the archetype baseline beside an "Ironclad" chip would be the sheet
  // describing a fighter the player is not going to get.
  const def = effectiveDef(ARCHETYPES[card.archetype], traitId, card.archetype);
  const hp = scaleByLevel(def.hp, card.level);
  const dmg = scaleByLevel(def.damage, card.level);
  const dps = def.hitTicks > 0 ? Math.round((dmg * 20) / def.hitTicks) : dmg;
  const nextHp = scaleByLevel(def.hp, Math.min(10, card.level + 1));
  const nextDmg = scaleByLevel(def.damage, Math.min(10, card.level + 1));
  // Absent when no live quote has been read for this coin. It used to fall back to 0, which rendered a green "+0.00%" —
  // a number the app had invented, sitting next to figures it had actually
  // read. Missing data shows as missing, the way `fdvUsd` already does.
  const up = coin.change24h;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'center' }}>
      <div aria-hidden onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }} />
      <div
        ref={sheet}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${tickerOf(coin)} card details`}
        className="panel sheet"
        style={{ maxHeight: '92dvh', overflowY: 'auto', gap: 10 }}
      >
        {/* hero: the coin's own art, big */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{
            padding: 5, borderRadius: 14,
            background: `linear-gradient(180deg, hsl(${coin.hue} 62% 46%), hsl(${coin.hue} 55% 24%))`,
            border: '2.5px solid var(--ink)', boxShadow: 'inset 0 2px 0 rgba(255,255,255,.3)',
          }}
          >
            <CoinBadge mint={card.mint} size={64} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="display" style={{ fontSize: 25, lineHeight: 1.1 }}>{tickerOf(coin)}</h2>
            {/* The character's name leads, the asset's name follows. This is a
                fighter first; the ticker is who it is, not what it does. */}
            <p className="fine" style={{ color: 'var(--dim-on-wood)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {lore ? `${lore.title} · ${coin.name}` : coin.name}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
              <ArchetypeIcon archetype={card.archetype} size={15} />
              <span className="label" style={{ fontSize: 12, color: 'var(--dim-on-wood)' }}>
                {ARCHETYPE_NAMES[card.archetype]}
              </span>
              <span
                className="label"
                title={trait.blurb}
                style={{
                  fontSize: 12, color: 'var(--gold)',
                  border: '1.5px solid var(--gold)', borderRadius: 999,
                  padding: '0 7px', lineHeight: '17px',
                }}
              >
                {trait.name}
              </span>
              <span className="money" style={{ fontSize: 13, marginLeft: 'auto' }}>{def.elixir}⚡</span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="icon-btn" style={{ fontSize: 26, width: 44, height: 44, color: 'var(--dim-on-wood)', alignSelf: 'flex-start', flexShrink: 0 }}>×</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LevelPips level={card.level} />
          {/* Shares the landing page's card route, not the game's own URL.
              X, Discord and the rest read HTML and never run JavaScript, so a
              link into this app would unfurl as a bare URL however the client
              behaved. That route serves the tags in the document itself. */}
          <button
            onClick={() => {
              const url = `${SHARE_ORIGIN}/card/${coin.ticker.toLowerCase()}`;
              const text = lore
                ? `${lore.tagline}\n\nMy $${coin.ticker} is level ${card.level} in @${X_HANDLE}.`
                : `My $${coin.ticker} is level ${card.level} in @${X_HANDLE}.`;
              window.open(
                `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
                '_blank', 'noopener,noreferrer',
              );
            }}
            aria-label={`Share ${tickerOf(coin)} on X`}
            className="btn-3d"
            style={{
              marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
              background: 'linear-gradient(180deg,#7fa4e2,#3a6fc4 52%,#234a8d)',
              border: '2px solid var(--ink)', borderRadius: 999,
              padding: '4px 12px', color: '#fff',
              fontFamily: 'var(--font-display)', fontSize: 12,
              WebkitTextStroke: '1.4px var(--ink)', paintOrder: 'stroke fill',
            }}
          >
            SHARE 𝕏
          </button>
        </div>

        {/* Who this fighter is, and what its trait costs it. Both are properties
            of the coin rather than of this copy — every $BTC in the game is the
            same character with the same trade-off. */}
        {lore && (
          <section className="well" style={{ borderRadius: 10, padding: '10px 12px', display: 'grid', gap: 6 }}>
            <p className="display" style={{ fontSize: 13, margin: 0, color: 'var(--gold)' }}>
              {lore.tagline}
            </p>
            <p className="fine" style={{ margin: 0, lineHeight: 1.5, color: 'var(--dim-on-blue, var(--dim))' }}>
              {lore.story}
            </p>
            <p className="fine" style={{ margin: 0, color: 'var(--dim)' }}>
              <strong style={{ color: 'var(--gold)' }}>{trait.name}</strong>
              {' — '}{trait.blurb}
            </p>
          </section>
        )}

        {/* the coin as a real asset */}
        <div>
          <div className="label" style={{ marginBottom: 5, color: 'var(--dim-on-wood)' }}>
            Market
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <Stat icon="$" label="Price" value={fmtUsd(coin.priceUsd)} />
            <Stat
              icon={up === undefined ? '·' : up >= 0 ? '📈' : '📉'}
              label="24h"
              value={up === undefined ? '—' : `${up >= 0 ? '+' : ''}${up.toFixed(2)}%`}
            />
            <Stat
              icon={coin.metaBps ? (coin.metaBps > 0 ? '▲' : '▼') : '·'}
              label="Today's meta"
              value={coin.metaBps ? `${coin.metaBps > 0 ? '+' : ''}${(coin.metaBps / 100).toFixed(1)}% hp & dmg` : 'neutral'}
            />
            <Stat
              icon="🪙"
              label="Minted at"
              value={onChain?.mintPriceUsd ? fmtUsd(onChain.mintPriceUsd) : '—'}
            />
          </div>
          {/* The panel is headed "Market" and these look like quotes, so it
              says where each number comes from right here. */}
          <p className="fine" style={{ margin: '6px 0 0', color: 'var(--dim-on-wood)' }}>
            Price: Pyth ({coin.pythSymbol}). Meta: Chainlink CRE or Pyth momentum → MarketMeta, ±15% max.
            Minted at: the Pyth price posted in the card&apos;s own mint transaction.
          </p>
        </div>

        {/* the coin as a game piece */}
        <div>
          <div className="label" style={{ marginBottom: 5, color: 'var(--dim-on-wood)' }}>
            Battle stats · level {card.level}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <Stat
              icon="❤️" label="Hitpoints" value={String(hp)}
              delta={card.level < 10 ? `+${nextHp - hp}` : undefined}
            />
            <Stat
              icon="⚔️" label="Damage" value={String(dmg)}
              delta={card.level < 10 ? `+${nextDmg - dmg}` : undefined}
            />
            <Stat icon="💥" label="Damage / sec" value={String(dps)} />
            <Stat icon="🏃" label="Speed" value={`${((def.speedFP / FP) * 20).toFixed(1)} t/s`} />
            <Stat icon="🎯" label="Range" value={`${(def.rangeFP / FP).toFixed(1)} tiles`} />
            <Stat icon="👥" label="Count" value={def.count > 0 ? `x${def.count}` : 'spell'} />
          </div>
        </div>

        {/*
          Progress, which is now a count of duplicates rather than a balance.
          This panel used to read "You have staked $X" against a next-level
          price in dollars — the old economy, where a level was bought by
          locking coins. Levels come from winning: chests drop duplicates, and
          merging a duplicate is what promotes a card. So the honest thing to
          show is the level it is and the one it is playing toward.
        */}
        <div className="well" style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ minWidth: 0 }}>
            <span className="label" style={{ fontSize: 12, display: 'block' }}>Level</span>
            <span className="money" style={{ fontSize: 19 }}>{card.level} of 10</span>
            <span className="fine" style={{ display: 'block', fontSize: 12 }}>
              {tickerOf(coin)} · won, not bought
            </span>
          </span>
          <span style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <span className="label" style={{ fontSize: 12, display: 'block' }}>Next level</span>
            <span className="display display--sm" style={{ fontSize: 15 }}>
              {card.level >= 10 ? 'MAX' : `Merge a duplicate → Lv ${card.level + 1}`}
            </span>
          </span>
        </div>

        {onChain && DEPLOYMENT && (
          <a
            href={`${explorerUrl(DEPLOYMENT.cards, 'address').replace('/address/', '/nft/')}/${onChain.id}`}
            target="_blank"
            rel="noreferrer"
            className="btn-3d"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              minHeight: 50, borderRadius: 'var(--r-pill)', textDecoration: 'none',
              background: 'linear-gradient(180deg, var(--btn-green-hi), var(--btn-green) 50%)',
              border: '3px solid var(--ink)',
              fontFamily: 'var(--font-display)', fontSize: 17, color: '#fff',
              WebkitTextStroke: '2.5px var(--ink)', paintOrder: 'stroke fill',
              boxShadow: 'inset 0 2px 0 rgba(255,255,255,.5), 0 5px 0 var(--btn-green-dark)',
            }}
          >
            Card #{onChain.id} on MonadVision
          </a>
        )}

        {coin.url && (
          <a
            href={coin.url}
            target="_blank"
            rel="noopener noreferrer"
            className="fine"
            style={{ color: 'var(--blue-pale)', textAlign: 'center', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            View {tickerOf(coin)} chart ↗
          </a>
        )}
      </div>
    </div>
  );
}
