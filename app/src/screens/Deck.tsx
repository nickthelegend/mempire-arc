import { useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pill } from '../components/ui';
import { CardFrame } from '../components/CardFrame';
import { click } from '../lib/audio';
import { COINS } from '../lib/coins';
import { EASE_SNAP, usePulse } from '../lib/motion';
import { revealSection } from '../lib/scroll';
import { ARCHETYPES } from '../sim/archetypes';
import { useCollection } from '../state/collection';
import { DECK_SLOTS, useDeck } from '../state/deck';
import { PasskeyLocker } from '../components/PasskeyLocker';

export function Deck() {
  const nav = useNavigate();
  const cards = useCollection((s) => s.cards);
  const deck = useDeck();
  const benchRef = useRef<HTMLElement>(null);
  const powerRef = usePulse(deck.power(), [
    { transform: 'scale(1)' },
    { transform: 'scale(1.22)', offset: 0.38 },
    { transform: 'scale(1)' },
  ], { duration: 420, easing: EASE_SNAP });

  const inDeck = useMemo(
    () => deck.active.map((id) => cards.find((c) => c.id === id)).filter(Boolean),
    [deck.active, cards],
  );
  const bench = useMemo(() => cards.filter((c) => !deck.active.includes(c.id)), [cards, deck.active]);

  const avgElixir = inDeck.length
    ? (inDeck.reduce((s, c) => s + ARCHETYPES[c!.archetype].elixir, 0) / inDeck.length).toFixed(1)
    : '—';

  const deckMints = new Set(inDeck.map((c) => c!.mint));

  return (
    <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h1 className="display" style={{ fontSize: 30 }}>Deck</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="label" style={{ fontSize: 12 }}>{deck.active.length}/8</span>
          {/* Power is the number the whole screen exists to move, so it reacts. */}
          <span
            ref={powerRef as React.RefObject<HTMLSpanElement>}
            className="label"
            style={{ fontSize: 12, color: 'var(--blue-pale)', display: 'inline-block' }}
          >
            power {deck.power()}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              aria-hidden
              style={{
                width: 9, height: 9, borderRadius: '50%',
                background: 'radial-gradient(circle at 34% 30%, #ff9cf5, var(--elixir))',
                border: '1.5px solid var(--ink)', display: 'inline-block',
              }}
            />
            <span className="label" style={{ fontSize: 12 }}>avg {avgElixir}</span>
          </span>
        </div>
      </header>

      {/* saved loadouts */}
      <div role="tablist" aria-label="Deck slots" style={{ display: 'flex', gap: 7 }}>
        {Array.from({ length: DECK_SLOTS }, (_, i) => {
          const active = deck.slot === i;
          const filled = (deck.slots[i]?.length ?? 0) === 8;
          return (
            <button
              key={i}
              role="tab"
              aria-selected={active}
              onClick={() => { click(); deck.selectSlot(i); }}
              className="btn-3d"
              style={{
                flex: 1, minHeight: 44, borderRadius: 'var(--r-card)',
                background: active
                  ? 'linear-gradient(180deg, var(--btn-gold-hi), var(--btn-gold))'
                  : 'var(--recess)',
                border: '2.5px solid var(--ink)',
                boxShadow: active
                  ? 'inset 0 2px 0 rgba(255,255,255,.5), 0 4px 0 var(--btn-gold-dark)'
                  : 'var(--bevel-in)',
                fontFamily: 'var(--font-display)', fontSize: 15, color: 'var(--text)',
                WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
                transition: 'background 160ms var(--ease-snap)',
              }}
            >
              Deck {i + 1}
              {filled && !active && <span style={{ color: 'var(--teal)' }}> ✓</span>}
            </button>
          );
        })}
      </div>

      <section
        aria-label="active deck"
        className="panel"
        style={{
          padding: 12, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8,
          borderColor: deck.isComplete() ? 'var(--teal)' : undefined,
        }}
      >
        {Array.from({ length: 8 }, (_, i) => {
          const c = inDeck[i];
          return c ? (
            // Keyed by card id, so a card arriving in a slot plays the drop once
            // and cards already seated stay still.
            <div key={c.id} style={{ animation: 'slotDrop 300ms cubic-bezier(0.16,1,0.3,1) both' }}>
              <CardFrame card={c} width={70} fluid selected onClick={() => deck.toggleCard(c.id)} />
            </div>
          ) : (
            // A `+` that does nothing points at a dead target. It scrolls to the
            // collection, which is the only place the slot can actually be filled.
            <button
              key={`empty_${i}`}
              onClick={() => { click(); revealSection(benchRef.current); }}
              aria-label="Empty deck slot — pick a card from your collection"
              className="btn-3d"
              style={{
                width: '100%', aspectRatio: '3 / 4', borderRadius: 'var(--r-card)',
                border: '2.5px dashed rgba(255,255,255,.28)',
                background: 'var(--recess)',
                boxShadow: 'var(--bevel-in)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--dim)', fontSize: 22,
              }}
            >
              <span aria-hidden>+</span>
            </button>
          );
        })}
      </section>
      {!deck.isComplete() && (
        <p className="fine" style={{ textAlign: 'center', marginTop: -6 }}>
          fill all 8 slots to battle — tap a card below
        </p>
      )}

      <section aria-label="collection" ref={benchRef} style={{ scrollMarginTop: 12 }}>
        <div className="label" style={{ marginBottom: 8 }}>Collection · one card per coin</div>
        {bench.length === 0 ? (
          /* An empty bench is not a failure — it means every card is playing.
             But saying only that leaves the bottom half of the screen dead and
             the player with nowhere to go. The way to get a bench is to mint
             more of what you hold, so the empty state says that and offers the
             door rather than making them find the Cards tab themselves. */
          <div className="well" style={{ padding: '22px 20px', textAlign: 'center', display: 'grid', gap: 12, justifyItems: 'center' }}>
            <span className="fine">Everything you own is already enlisted, ser.</span>
            <span className="fine" style={{ color: 'var(--dim)', maxWidth: 260 }}>
              Mint another coin you hold and it lands here, ready to swap in.
            </span>
            <Pill
              tone="blue"
              onClick={() => nav('/cards')}
              style={{ fontSize: 15, minHeight: 44, padding: '10px 20px', width: 'auto' }}
            >
              Mint a fighter
            </Pill>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
            {bench.map((c) => {
              const coin = COINS.find((k) => k.mint === c.mint);
              const dupe = deckMints.has(c.mint);
              const blocked = dupe || deck.active.length >= 8;
              return (
                <div key={c.id} style={{ position: 'relative' }}>
                  <CardFrame
                    card={c}
                    width={96}
                    fluid
                    dimmed={blocked}
                    disabled={blocked}
                    onClick={() => deck.toggleCard(c.id)}
                  />
                  {dupe && (
                    <span style={{
                      position: 'absolute', bottom: 6, left: 0, right: 0,
                      fontSize: 12, textAlign: 'center', color: 'var(--red-on-wood)',
                      fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
                      textShadow: '0 1px 2px rgba(6,16,38,.9)',
                    }}
                    >
                      ${coin?.ticker} in deck
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <PasskeyLocker />
    </div>
  );
}
