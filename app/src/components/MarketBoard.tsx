import { useChain } from '../state/chain';
import { COINS, tickerOf } from '../lib/coins';

/*
 * The desktop gutters: today's market meta, from the chain.
 *
 * MarketMeta stores one bounded modifier per fighter per ten-minute epoch,
 * derived on chain from each fighter's Chainlink Data Feed (its 24h move), or
 * on Arc testnet optionally written by a Chainlink CRE report.
 * The left board shows the fighters it buffed hardest, the right board the
 * ones it nerfed — the same numbers every match this epoch fights with. When
 * nothing has been posted yet the board says so; it never fills the gap.
 */
/** MarketMeta epochs are ten-minute windows: epoch × 600 s is when this meta was written for. */
const metaAge = (epoch: number) => {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - Number(epoch) * 600) / 60));
  return mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
};

export function MarketBoard({ side }: { side: 'left' | 'right' }) {
  const epoch = useChain((s) => s.metaEpoch);
  useChain((s) => s.marketVersion); // re-render when the meta or prices move
  const up = side === 'left';
  const rows = COINS
    .filter((c) => (c.metaBps ?? 0) !== 0 && (up ? (c.metaBps ?? 0) > 0 : (c.metaBps ?? 0) < 0))
    .sort((a, b) => (up ? (b.metaBps ?? 0) - (a.metaBps ?? 0) : (a.metaBps ?? 0) - (b.metaBps ?? 0)))
    .slice(0, 6);

  return (
    <aside
      aria-label={up ? 'Fighters buffed by today’s market' : 'Fighters nerfed by today’s market'}
      style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 48, minWidth: 0 }}
    >
      <div className="panel" style={{ position: 'sticky', top: 48, width: 260, maxWidth: '100%', padding: '14px 14px 12px' }}>
        <div className="label" style={{ textAlign: 'center' }}>{up ? '▲ Buffed by the market' : '▼ Nerfed by the market'}</div>
        <p className="fine" style={{ textAlign: 'center', color: 'var(--dim-on-wood)', margin: '4px 0 10px' }}>
          {epoch ? `meta from ${metaAge(epoch)} · on chain · ±15% max` : 'no market meta posted yet'}
        </p>
        {rows.length === 0 && (
          <p className="fine" style={{ textAlign: 'center', color: 'var(--dim-on-wood)', margin: 0 }}>
            {epoch ? (up ? 'Nothing buffed this epoch.' : 'Nothing nerfed this epoch.') : 'Waiting for the first epoch.'}
          </p>
        )}
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((c) => (
            <div key={c.coinId} className="well" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
              <img
                src={c.cardArt}
                alt=""
                aria-hidden
                width={28}
                height={28}
                onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                style={{ borderRadius: 6, objectFit: 'cover', border: '2px solid var(--ink)' }}
              />
              <span style={{ fontWeight: 800, fontSize: 13 }}>{tickerOf(c)}</span>
              {typeof c.change24h === 'number' && (
                <span className="fine" style={{ color: 'var(--dim)' }}>
                  {c.change24h >= 0 ? '+' : ''}{c.change24h.toFixed(1)}% 24h
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontWeight: 800, color: up ? 'var(--teal)' : 'var(--red)' }}>
                {up ? '+' : '−'}{Math.abs((c.metaBps ?? 0) / 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

/** The meta for a phone: the top buffs and nerfs in one line, with its age. */
export function MarketStrip() {
  const epoch = useChain((s) => s.metaEpoch);
  useChain((s) => s.marketVersion);
  if (!epoch) return null;
  const moved = COINS.filter((c) => (c.metaBps ?? 0) !== 0);
  const top = (up: boolean) => moved
    .filter((c) => (up ? (c.metaBps ?? 0) > 0 : (c.metaBps ?? 0) < 0))
    .sort((a, b) => Math.abs(b.metaBps ?? 0) - Math.abs(a.metaBps ?? 0))
    .slice(0, 2);
  const chip = (c: (typeof COINS)[number]) => (
    <span key={c.coinId} style={{ fontWeight: 800, whiteSpace: 'nowrap', color: (c.metaBps ?? 0) > 0 ? 'var(--teal)' : 'var(--red-on-wood)' }}>
      {(c.metaBps ?? 0) > 0 ? '▲' : '▼'} {tickerOf(c)} {(Math.abs(c.metaBps ?? 0) / 100).toFixed(1)}%
    </span>
  );
  return (
    <div className="market-strip panel" aria-label="Today's market meta" style={{ alignItems: 'center', gap: 10, padding: '6px 10px', fontSize: 12, flexWrap: 'wrap' }}>
      <span className="label" style={{ fontSize: 11 }}>Market meta</span>
      {[...top(true), ...top(false)].map(chip)}
      <span className="fine" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--dim-on-wood)' }}>{metaAge(epoch)} · on chain</span>
    </div>
  );
}
