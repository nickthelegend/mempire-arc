import { useEffect, useState } from 'react';
import { formatEther, formatUnits } from 'viem';
import { explorerUrl } from '../chain/provider';
import { shortAddr } from '../lib/format';
import {
  coinWinRates, hasIndexer, latestPlays, leaderboard, totals,
  type CoinStat, type LeaderRowIdx, type PlayRow, type Totals,
} from '../lib/indexer';

/*
 * The game, as the chain sees it — from the Envio indexer.
 *
 * Every row here is an event a contract emitted: a card dropped in some match
 * a few hundred milliseconds ago, a wallet's record across settled pots, a
 * fighter's win rate split by whether the market had buffed it that day. The
 * last one is the question the market meta exists to make interesting, and
 * only an indexer can answer it.
 */

function usePoll<T>(fn: () => Promise<T>, ms: number, initial: T): T {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    let live = true;
    const run = () => { void fn().then((r) => { if (live) setV(r); }); };
    run();
    const t = setInterval(run, ms);
    return () => { live = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);
  return v;
}

const ago = (ts: string): string => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - Number(ts)));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

export function LiveOnMonad() {
  const plays = usePoll<PlayRow[]>(() => latestPlays(12), 3000, []);
  const leaders = usePoll<LeaderRowIdx[]>(() => leaderboard(5), 15_000, []);
  const coins = usePoll<CoinStat[]>(coinWinRates, 30_000, []);
  const stats = usePoll<Totals | null>(totals, 10_000, null);

  if (!hasIndexer()) return null;

  const fielded = coins.filter((c) => c.wins + c.losses >= 3).slice(0, 5);

  return (
    <section aria-label="Live on Monad" style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="label">Live on Monad</span>
        <span className="label" style={{ fontSize: 11 }}>indexed by Envio</span>
      </div>

      {stats && (
        <div className="well" style={{ padding: '8px 10px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, textAlign: 'center' }}>
          {[
            ['players', stats.players],
            ['matches', stats.matchesSettled],
            ['plays', stats.plays],
            ['pots', `$${Number(formatUnits(BigInt(stats.volumeAusd), 6)).toLocaleString()}`],
          ].map(([k, v]) => (
            <div key={String(k)}>
              <div className="money" style={{ fontSize: 15 }}>{String(v)}</div>
              <div className="fine" style={{ fontSize: 10, color: 'var(--dim)' }}>{k}</div>
            </div>
          ))}
        </div>
      )}

      <div className="well" style={{ padding: '4px 10px' }}>
        {plays.length === 0 && (
          <p className="fine" style={{ color: 'var(--dim)', margin: '8px 0' }}>
            No card plays indexed yet — the first staked match fills this in.
          </p>
        )}
        {plays.map((p) => (
          <a
            key={p.id}
            href={explorerUrl(p.txHash, 'tx')}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
              borderTop: '1px solid var(--border)', color: 'inherit', textDecoration: 'none', fontSize: 12.5,
            }}
          >
            <span className="mono" style={{ color: 'var(--dim)', width: 34 }}>{ago(p.timestamp)}</span>
            <span style={{ fontWeight: 800 }}>${p.coin?.ticker ?? '?'}</span>
            <span style={{ color: 'var(--dim)' }}>Lv{p.card?.level ?? '?'}</span>
            <span style={{ color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              match #{p.match_id} · seat {p.seat}
            </span>
            {p.coin && p.coin.currentModifierBps !== 0 && (
              <span style={{ marginLeft: 'auto', fontWeight: 800, color: p.coin.currentModifierBps > 0 ? 'var(--teal)' : 'var(--red)' }}>
                {p.coin.currentModifierBps > 0 ? '▲' : '▼'}{Math.abs(p.coin.currentModifierBps / 100).toFixed(0)}%
              </span>
            )}
          </a>
        ))}
      </div>

      {leaders.length > 0 && (
        <div className="well" style={{ padding: '4px 10px' }}>
          {leaders.map((r, i) => (
            <div key={r.id} style={{ display: 'flex', gap: 8, padding: '6px 0', fontSize: 13, borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <span style={{ width: 18, color: 'var(--dim)' }}>{i + 1}</span>
              <span className="mono">{shortAddr(r.id)}</span>
              <span style={{ color: 'var(--dim)' }}>{r.wins}W · {r.losses}L</span>
              <span className="money" style={{ marginLeft: 'auto', fontSize: 13 }}>
                {Number(formatUnits(BigInt(r.netAusd), 6)) !== 0
                  ? `${Number(formatUnits(BigInt(r.netAusd), 6)) > 0 ? '+' : ''}$${Number(formatUnits(BigInt(r.netAusd), 6)).toFixed(2)}`
                  : `${Number(formatEther(BigInt(r.netMon))).toFixed(3)} MON`}
              </span>
            </div>
          ))}
        </div>
      )}

      {fielded.length > 0 && (
        <div className="well" style={{ padding: '6px 10px', display: 'grid', gap: 4 }}>
          <span className="fine" style={{ color: 'var(--dim)' }}>Win rate when fielded · and when the market buffed them</span>
          {fielded.map((c) => {
            const buffed = c.winsBuffed + c.lossesBuffed;
            return (
              <div key={c.id} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                <span style={{ fontWeight: 800, width: 70 }}>${c.ticker}</span>
                <span>{(c.winRateBps / 100).toFixed(0)}%</span>
                <span style={{ color: 'var(--dim)' }}>
                  {buffed ? `· buffed ${Math.round((c.winsBuffed / buffed) * 100)}%` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
