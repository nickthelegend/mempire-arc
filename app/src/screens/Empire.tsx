import { IS_MAINNET, NETWORK_LABEL } from '../chain/provider';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MoneyRow, Pill } from '../components/ui';
import { RankChip } from '../components/ClanBits';
import { fmtUsdc, fmtStake, shortAddr } from '../lib/format';
import { loadLeaderboard } from '../lib/persist';
import { apiFetch } from '../lib/api';
import { useCollection } from '../state/collection';
import { useMatch } from '../state/match';
import { useWallet } from '../state/wallet';
import { useChain } from '../state/chain';
import { LiveOnArc } from '../components/LiveOnArc';
import { ArcStack } from '../components/ArcStack';
import { fetchStrandedMatches, type ChainMatch } from '../chain/read';
import { useEscrow } from '../state/escrow';

type Board = 'trophies' | 'usdc' | 'clans';
const BOARDS: { id: Board; label: string }[] = [
  { id: 'trophies', label: 'Trophies' },
  { id: 'usdc', label: 'Net USDC' },
  { id: 'clans', label: 'Clans' },
];
interface BoardRow { key: string; title: string; sub: string; value: string; positive: boolean; mine: boolean }

/*
 * Competition in one place: the trophy ladder, chain-verified USDC winnings,
 * and the clans. Rows come from the relay, which credits money only from
 * settled arena matches; harness wallets with no wins and no net are left out
 * (a load-test wallet once sat in the public top ten at 0W · 162L, which reads
 * as a bot farming the ladder). An empty board says it is empty rather than
 * showing nothing.
 */
async function loadBoard(board: Board, me: string): Promise<BoardRow[]> {
  const meLc = me.toLowerCase();
  if (board === 'trophies') {
    const res = await apiFetch('/api/ladder');
    if (!res?.ok) return [];
    const { players } = await res.json() as { players: { address: string; name: string | null; trophies: number; wins: number; losses: number; league: string }[] };
    return players.filter((p) => p.wins + p.losses > 0).map((p) => ({
      key: p.address, title: p.name || shortAddr(p.address), sub: `${p.league} · ${p.wins}W · ${p.losses}L`,
      value: `🏆 ${p.trophies}`, positive: true, mine: p.address.toLowerCase() === meLc,
    }));
  }
  if (board === 'clans') {
    const res = await apiFetch('/api/clans-top');
    if (!res?.ok) return [];
    const { clans } = await res.json() as { clans: { tag: string; name: string; memberCount: number; memberCap: number; crowns: number }[] };
    return clans.map((c) => ({
      key: c.tag, title: c.name, sub: `#${c.tag} · ${c.memberCount}/${c.memberCap} members`,
      value: `♛ ${c.crowns}`, positive: true, mine: false,
    }));
  }
  const rows = await loadLeaderboard();
  return rows
    .map((r) => ({ r, net: r.netUsdc ?? 0 }))
    // A money board lists money that moved, nothing else.
    .filter(({ net }) => net !== 0)
    .map(({ r, net }) => ({
      key: r.address, title: shortAddr(r.address), sub: `${r.wins}W · ${r.losses}L`,
      value: `${net >= 0 ? '+' : '−'}${fmtUsdc(Math.abs(net))}`, positive: net >= 0,
      mine: r.address.toLowerCase() === meLc,
    }));
}

const EMPTY: Record<Board, string> = {
  trophies: 'No ranked matches yet — the ladder fills as people play Ranked.',
  usdc: 'No USDC pots settled yet.',
  clans: 'No clans yet — found the first one on the Clan tab.',
};

function Leaderboard({ me }: { me: string }) {
  const [board, setBoard] = useState<Board>('trophies');
  const [rows, setRows] = useState<BoardRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    void loadBoard(board, me).then((r) => { if (!cancelled) setRows(r); }).catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [board, me]);

  return (
    <section aria-label="Leaderboards">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span className="label">Leaderboards</span>
        <span className="label" style={{ fontSize: 12 }}>money columns are chain-verified</span>
      </div>
      <div role="tablist" aria-label="Leaderboard" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5, marginBottom: 8 }}>
        {BOARDS.map((b) => (
          <button
            key={b.id}
            role="tab"
            type="button"
            aria-selected={board === b.id}
            onClick={() => setBoard(b.id)}
            className="btn-3d"
            style={{
              minHeight: 38, borderRadius: 9, border: '2px solid var(--ink)', fontFamily: 'var(--font-display)', fontSize: 13,
              background: board === b.id ? 'linear-gradient(180deg, var(--btn-gold-hi), var(--btn-gold))' : 'var(--recess)',
              color: board === b.id ? '#0d1120' : 'var(--dim)', cursor: 'pointer',
            }}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="well" style={{ padding: '2px 10px', minHeight: 54 }}>
        {rows === null ? (
          <p className="fine" style={{ margin: '14px 0', fontSize: 12, color: 'var(--dim)' }}>loading…</p>
        ) : rows.length === 0 ? (
          <p className="fine" style={{ margin: '14px 0', fontSize: 12, color: 'var(--dim)' }}>{EMPTY[board]}</p>
        ) : rows.slice(0, 10).map((r, i) => (
          <div
            key={r.key}
            style={{
              display: 'flex', alignItems: 'center', gap: 9, padding: '9px 0',
              borderTop: i === 0 ? 'none' : '2px solid rgba(0,0,0,.28)',
              background: r.mine ? 'rgba(243,198,75,.08)' : undefined,
            }}
          >
            <RankChip rank={i + 1} />
            <span style={{ minWidth: 0, flex: 1, display: 'grid' }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)', fontSize: 12, color: r.mine ? 'var(--gold-hi)' : 'var(--text)', fontWeight: r.mine ? 800 : 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {r.title}{r.mine && <span className="label" style={{ fontSize: 11, marginLeft: 5 }}>you</span>}
              </span>
              <span className="fine" style={{ fontSize: 11, color: 'var(--dim)' }}>{r.sub}</span>
            </span>
            <span className="money" style={{ fontSize: 13, flexShrink: 0, color: r.positive ? 'var(--gold)' : 'var(--red)' }}>{r.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Empire() {
  const nav = useNavigate();
  const wallet = useWallet();
  const mempire = useChain((s) => s.mempireBalance);
  const openPicker = useWallet((s) => s.openPicker);
  const history = useMatch((s) => s.history);
  const cards = useCollection((s) => s.cards);

  const wins = history.filter((h) => h.won).length;
  const losses = history.filter((h) => !h.won && !h.draw).length;
  /*
   * Money totals count only matches where money moved. `escrowed` exists for
   * exactly this: an unstaked match reports the pot it *would* have paid, and
   * summing those printed a "Won" figure that never existed — the same
   * class of lie the result card was cured of. Rating counts all matches;
   * money counts escrowed ones (all USDC on Arc).
   */
  const sumBy = (pick: (h: (typeof history)[number]) => number) => {
    let t = 0;
    for (const h of history) if (h.escrowed) t += pick(h);
    return fmtUsdc(t);
  };
  const earned = sumBy((h) => h.payoutSol);
  const raked = sumBy((h) => h.rakeSol);

  return (
    <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header>
        <h1 className="display" style={{ fontSize: 30 }}>Empire</h1>
        {wallet.connected && (
          <p className="fine">
            {wallet.walletName} · <span className="mono">{shortAddr(wallet.address)}</span>
          </p>
        )}
      </header>

      {/* The same state on Cards offers a button, so sending the player to
          another tab to do the identical thing was two answers to one question. */}
      {!wallet.connected && (
        <div className="panel" style={{ padding: '22px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
          <span style={{ color: 'var(--dim-on-wood)', fontSize: 14, maxWidth: 260 }}>
            No empire yet, anon. Connect a wallet and your record starts counting.
          </span>
          <div style={{ width: 'min(100%, 240px)' }}>
            <Pill onClick={openPicker}>Connect Wallet</Pill>
          </div>
        </div>
      )}

      {wallet.connected && (
        <>
          <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <MoneyRow stack label="USDC" value={fmtUsdc(wallet.usdc)} />
            <MoneyRow stack label="Gas" value="USDC · same balance" />
            <MoneyRow stack label="$MEMPIRE" value={Math.floor(mempire).toLocaleString()} />
            <MoneyRow stack label="Won" value={earned} />
          </section>

          <section className="panel" style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
            {[
              ['Record', `${wins}W · ${losses}L`],
              ['Cards', String(cards.length)],
              ['House raked', raked],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="display display--sm" style={{ fontSize: 18 }}>{value}</div>
                <div className="label" style={{ fontSize: 12 }}>{label}</div>
              </div>
            ))}
          </section>

          <section aria-label="match history">
            <div className="label" style={{ marginBottom: 8 }}>Battles</div>
            {history.length === 0 ? (
              /* The one screen a new player reaches with nothing on it. Saying
                 "the arena awaits" and then not opening the arena leaves them
                 to go and find the tab, which is the moment a first session
                 ends. */
              <div className="well" style={{ padding: '22px 20px', textAlign: 'center', display: 'grid', gap: 12, justifyItems: 'center' }}>
                <span className="fine">No battles yet — the arena awaits, anon.</span>
                <Pill
                  tone="gold"
                  onClick={() => nav('/')}
                  style={{ fontSize: 15, minHeight: 44, padding: '10px 20px', width: 'auto' }}
                >
                  Find a match
                </Pill>
              </div>
            ) : (
              <div className="well" style={{ padding: '2px 12px' }}>
                {history.map((h, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0',
                      borderTop: i === 0 ? 'none' : '2px solid rgba(0,0,0,.28)',
                    }}
                  >
                    <span
                      className="display display--sm"
                      style={{
                        fontSize: 17,
                        color: h.draw ? 'var(--dim)' : h.won ? 'var(--teal)' : 'var(--red)',
                      }}
                    >
                      {h.draw ? 'DRAW' : h.won ? 'WON' : 'REKT'}
                    </span>
                    <span className="fine" style={{ fontSize: 12 }}>
                      pot {fmtStake(h.potSol, h.currency ?? 'USDC')} · {h.hashes} commits
                    </span>
                    <span className="money" style={{ marginLeft: 'auto', color: !h.escrowed ? 'var(--dim)' : h.payoutSol > 0 ? 'var(--gold)' : 'var(--red)' }}>
                      {/* An unescrowed match moved nothing; showing ±SOL for it
                          would restate the number the result card already
                          disclaims. */}
                      {!h.escrowed ? 'rating only' : h.payoutSol > 0 ? `+${fmtStake(h.payoutSol, h.currency ?? 'USDC')}` : `−${fmtStake(h.potSol / 2, h.currency ?? 'USDC')}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <ArcStack />
          <LiveOnArc />

          <Leaderboard me={wallet.address} />

          <StakeRecovery />

          <p className="fine" style={{ fontSize: 12 }}>
            {/* A guest's browser key signs its own transactions, so on testnet
                mints and stakes spend the same real USDC a connected wallet
                would. On mainnet a guest cannot sign at all — the browser key
                is testnet-only by policy. */}
            {wallet.isGuest
              ? (IS_MAINNET
                ? 'Guest mode on mainnet is play-only — connect a wallet to mint, stake, or hold anything real. '
                : `Guest mode — this browser holds a real key on the ${NETWORK_LABEL}, so mints and stakes are real transactions. Sign in with a passkey to keep the account on every device. `)
              : wallet.kind === 'passkey'
                ? 'Passkey account — derived from your passkey, never stored. Same account on any device your passkey syncs to. '
                : `${NETWORK_LABEL} — balances are read from the chain and staked matches escrow for real. `}
            Mint fee $0.05 USDC · rake 10% of the pot, 5% on a draw · gas paid in USDC.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * A way out for a pot the match never resolved.
 *
 * Voided matches — a desync, a dropped relay, an opponent who stopped
 * reporting — leave both stakes escrowed with no agreement to settle them. The
 * program's answer is `claim_timeout` after the deadline, and a program path
 * nothing in the UI can reach is the same as no path at all: the player just
 * sees SOL that never came back.
 *
 * Hidden entirely when there is nothing to recover, so it is never a button
 * inviting people to poke at a match that is working fine.
 */
/**
 * A stake sitting in a match that never settled.
 *
 * This used to read the escrow store, which lives in memory. Reload the page
 * and `matchId` is null and `phase` is 'none', so a stranded pot disappeared
 * from the one screen built to recover it — at exactly the moment its owner
 * would come looking. Verified against a real one: match #65 held 0.05 SOL in
 * state Open and Empire offered nothing at all.
 *
 * Whether a stake is stranded is a fact about the chain, so it is read from
 * the chain: any match this wallet is a player in that has not reached
 * Settled still holds their stake.
 */
function StakeRecovery() {
  const address = useWallet((s) => s.address);
  const recover = useEscrow((s) => s.recover);
  const lastError = useEscrow((s) => s.lastError);
  const [stranded, setStranded] = useState<ChainMatch | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'too-early' | 'paid' | 'none' | 'failed'>('idle');

  useEffect(() => {
    if (!address) { setStranded(null); return; }
    let live = true;
    void fetchStrandedMatches(address)
      .then((ms) => { if (live) setStranded(ms[0] ?? null); })
      .catch(() => { /* a failed read must not invent a stranded stake */ });
    return () => { live = false; };
  }, [address, state]);

  if (!stranded || state === 'paid') return null;
  const matchId = stranded.id;

  return (
    <section className="well" style={{ padding: '10px 12px', display: 'grid', gap: 6 }}>
      <span className="label">Unsettled stake</span>
      <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
        Match #{matchId} escrowed {fmtStake(stranded.stake, stranded.currency)} and never settled.
        After its deadline anyone can finish it — the claim that was recorded stands, and with none both stakes come home.
      </p>
      <Pill
        tone="gold"
        disabled={state === 'busy'}
        onClick={() => {
          setState('busy');
          void recover(matchId).then((r) => setState(
            r === 'paid' ? 'paid'
              : r === 'too-early' ? 'too-early'
                : r === 'failed' ? 'failed' : 'none',
          ));
        }}
      >
        {state === 'busy' ? 'Claiming…' : 'Claim my stake'}
      </Pill>
      {state === 'too-early' && (
        <span className="fine" style={{ color: 'var(--dim)' }}>
          The deadline has not passed yet — try again shortly.
        </span>
      )}
      {state === 'none' && (
        <span className="fine" style={{ color: 'var(--dim)' }}>
          Nothing to claim on this match.
        </span>
      )}
      {state === 'failed' && (
        <span className="fine" style={{ color: 'var(--warn, var(--dim))' }}>
          {lastError
            ? `The claim was refused: ${lastError}. Your stake is still there — try again.`
            : 'The claim was refused. Your stake is still there — try again.'}
        </span>
      )}
    </section>
  );
}
