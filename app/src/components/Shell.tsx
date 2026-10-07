import { useEffect, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { WalletPicker } from './WalletPicker';
import { MarketBoard } from './MarketBoard';
import { useChainSync } from '../state/useChainSync';
import { useMatch } from '../state/match';
import { usePlayerSync } from '../state/sync';
import { useWallet } from '../state/wallet';

const TABS = [
  { to: '/', label: 'Arena', icon: '/art/tab_arena.webp' },
  { to: '/cards', label: 'Cards', icon: '/art/tab_cards.webp' },
  { to: '/deck', label: 'Deck', icon: '/art/tab_deck.webp' },
  { to: '/clan', label: 'Clan', icon: '/art/clan_badge.webp' },
  { to: '/empire', label: 'Empire', icon: '/art/tab_empire.webp' },
];
// Swap is deliberately not a tab. It is a thing you do *to* your balance, not
// a place you go, so it lives behind the + on the Crowns pill — next to the
// number it changes. Five tabs also give each one room the six never had.

/**
 * Layout law: one centered 430px column on the quilted field, gutters
 * intentionally empty (reserved: future ads). Battle hides the tab bar.
 */
export function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const inBattle = pathname === '/battle';
  const autoConnect = useWallet((s) => s.autoConnect);
  const matchStatus = useMatch((s) => s.status);
  const nav = useNavigate();

  useEffect(() => { void autoConnect(); }, [autoConnect]);
  usePlayerSync();
  useChainSync();

  // Router-level so the arena opens from whichever tab the player is on —
  // otherwise a match could run headless with the stake escrowed.
  useEffect(() => {
    if (matchStatus === 'battle' && pathname !== '/battle') nav('/battle');
  }, [matchStatus, pathname, nav]);

  const searching = matchStatus === 'queuing' || matchStatus === 'found';

  // The gutters the layout law reserves for ads. Battle takes the whole screen,
  // and a phone has no gutters to give — `.gutter` handles the width rule.
  const showGutters = !inBattle;

  return (
    <div
      className={inBattle ? undefined : 'hall'}
      /* Height, not min-height, and the scroll lives inside the column.
       *
       * With the page free to grow, a full coin list made the document ~5700px
       * tall, and the column carries six layered repeating gradients. Chrome
       * gave up rasterising a strip that big: past roughly 900px of scroll the
       * whole viewport painted flat background colour while the DOM underneath
       * still laid out and hit-tested correctly — content was there, it simply
       * never drew. It also scrolled the tab bar off the screen, which no
       * game shell should ever do. Capping the shell at the viewport keeps the
       * painted layer one screen tall no matter how long the list gets. */
      style={{ height: '100dvh', overflow: 'hidden', display: 'flex', justifyContent: 'center' }}
    >
      {showGutters && <div className="gutter"><MarketBoard side="left" /></div>}
      <div
        className={inBattle ? undefined : 'quilt'}
        style={{
          width: 'min(100vw, 430px)', height: '100dvh', minHeight: 0, position: 'relative',
          display: 'flex', flexDirection: 'column', flexShrink: 0,
          // The gold rule is what makes the column an object standing in the
          // hall rather than a lit patch of the same wall.
          boxShadow: inBattle ? 'none' : [
            '0 0 0 2px rgba(255,196,34,.32)',
            '0 0 0 5px rgba(0,0,0,.55)',
            '0 0 90px rgba(0,0,0,.7)',
          ].join(', '),
          background: inBattle ? 'var(--ink)' : undefined,
        }}
      >
        {/* The `key` re-triggers the entrance on each route so tab changes read as
            movement inside the column rather than an instant swap. Battle is
            excluded on purpose: keying a WebGL canvas ancestor would remount it
            and drop the GL context mid-match. */}
        <main
          key={inBattle ? 'battle' : pathname}
          className={inBattle ? undefined : 'screen-in'}
          style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            // The one scroller. The tab bar is a flex sibling below, so the
            // screen no longer has to reserve height for a fixed bar.
            minHeight: 0,
            overflowY: inBattle ? 'hidden' : 'auto',
            overscrollBehavior: 'contain',
          }}
        >
          {children}
        </main>

        {!inBattle && (
          <nav
            aria-label="Main"
            className="wood"
            style={{
              // In flow at the foot of the column rather than fixed to the
              // viewport: fixed positioning is what let the bar leave the
              // screen once the document itself became the scroller.
              flexShrink: 0, width: '100%', zIndex: 20,
              display: 'grid', gridTemplateColumns: `repeat(${TABS.length}, 1fr)`,
              borderTop: '3px solid var(--wood-edge)',
              boxShadow: '0 -6px 18px rgba(0,0,0,.5), inset 0 2px 0 rgba(255,255,255,.16)',
              paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                onClick={(e) => { if (searching) e.preventDefault(); }}
                aria-disabled={searching}
                style={({ isActive }) => ({
                  position: 'relative',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                  padding: '8px 0 9px', textDecoration: 'none',
                  color: 'var(--text)',
                  opacity: searching && !isActive ? 0.4 : 1,
                  pointerEvents: searching && !isActive ? 'none' : undefined,
                  fontFamily: 'var(--font-display)',
                  fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase',
                  WebkitTextStroke: '2px var(--ink)',
                  paintOrder: 'stroke fill',
                  // the active tab lifts out of the wood on a lit plate
                  background: isActive
                    ? 'linear-gradient(180deg, var(--blue-lit), var(--blue))'
                    : 'transparent',
                  boxShadow: isActive
                    ? 'inset 0 2px 0 rgba(255,255,255,.4), inset 0 -3px 0 rgba(0,0,0,.3)'
                    : 'none',
                  borderLeft: isActive ? '2px solid var(--ink)' : '2px solid transparent',
                  borderRight: isActive ? '2px solid var(--ink)' : '2px solid transparent',
                  transition: 'background 160ms var(--ease-snap), opacity 160ms var(--ease-snap)',
                })}
              >
                {({ isActive }: { isActive: boolean }) => (
                  <>
                    <img
                      src={t.icon}
                      alt=""
                      aria-hidden
                      width={34}
                      height={34}
                      draggable={false}
                      style={{
                        display: 'block',
                        filter: isActive
                          ? 'drop-shadow(0 2px 4px rgba(0,0,0,.6))'
                          : 'saturate(.55) brightness(.78) drop-shadow(0 2px 3px rgba(0,0,0,.5))',
                        transform: isActive ? 'translateY(-2px) scale(1.1)' : 'none',
                        transition: 'transform 160ms var(--ease-snap), filter 160ms var(--ease-snap)',
                      }}
                    />
                    {t.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        )}
        <WalletPicker />
      </div>
      {showGutters && <div className="gutter"><MarketBoard side="right" /></div>}
    </div>
  );
}
