import { IS_MAINNET, NETWORK_LABEL } from '../chain/provider';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MoneyRow, Pill } from '../components/ui';
import { RankChip } from '../components/ClanBits';
import { fmtMon, fmtStake, shortAddr } from '../lib/format';
import { loadLeaderboard, type LeaderRow } from '../lib/persist';
import { useCollection } from '../state/collection';
import { useMatch } from '../state/match';
import { useWallet } from '../state/wallet';
import { useChain } from '../state/chain';
import { LiveOnMonad } from '../components/LiveOnMonad';
import { fetchStrandedMatches, type ChainMatch } from '../chain/read';
import { useEscrow } from '../state/escrow';

/**
 * Top players by net MON / AUSD, from the persistence API.
 *
 * Renders nothing when the API is down or the board is empty — a leaderboard
 * with no rows is dead weight, and the rest of the screen already works
 * without the server.
 */
function Leaderboard({ me }: { me: string }) {
  const [rows, setRows] = useState<LeaderRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadLeaderboard().then((r) => {
      if (cancelled) return;
      /* Drop the harness accounts.
       *
       * A load-test wallet sat in the public top ten at 0W · 162L · +0,
       * which is not a player and reads to anyone looking as a bot farming the
       * ladder. A row earns its place by having won something or moved some
       * money; nothing legitimate is excluded by that, because a real player with
       * zero wins and zero net is also ranked nowhere. */
      setRows(r.filter((row) => row.wins > 0 || (row.netAusd ?? 0) !== 0 || (row.netMon ?? 0) !== 0));
    });
    return () => { cancelled = true; };
  }, []);

  if (rows.length === 0) return null;

  return (
    <section aria-label="Leaderboard">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span className="label">Leaderboard</span>
        <span className="label" style={{ fontSize: 12 }}>by net winnings</span>
      </div>
      <div className="well" style={{ padding: '2px 10px' }}>
        {rows.slice(0, 10).map((r, i) => {
          const isMe = r.address === me;
          return (
            <div
              key={r.address}
              style={{
                display: 'flex', alignItems: 'center', gap: 9, padding: '9px 0',
                borderTop: i === 0 ? 'none' : '2px solid rgba(0,0,0,.28)',
              }}
            >
              <RankChip rank={i + 1} />
              <span
                className="mono"
                style={{
                  fontSize: 12, minWidth: 0, flex: 1,
                  color: isMe ? 'var(--gold-hi)' : 'var(--dim)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontWeight: isMe ? 800 : 400,
                }}
              >
                {shortAddr(r.address)}
                {isMe && <span className="label" style={{ fontSize: 12, marginLeft: 5 }}>you</span>}
              </span>
              <span className="fine" style={{ fontSize: 12, flexShrink: 0 }}>
                {r.wins}W · {r.losses}L
              </span>
              <span
                className="money"
                style={{ fontSize: 13, flexShrink: 0, color: (r.netAusd || r.netMon || 0) >= 0 ? 'var(--gold)' : 'var(--red)' }}
              >
                {r.netAusd
                  ? `${r.netAusd >= 0 ? '+' : '−'}${fmtStake(Math.abs(r.netAusd), 'AUSD')}`
                  : `${(r.netMon ?? 0) >= 0 ? '+' : '−'}${fmtMon(Math.abs(r.netMon ?? 0))}`}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Empire() {
  const nav = useNavigate();
  const wallet = useWallet();
  const ausd = useChain((s) => s.ausdBalance);
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
   * money counts escrowed ones, each in the currency it was staked in.
   */
  const sumBy = (pick: (h: (typeof history)[number]) => number) => {
    const t = { MON: 0, AUSD: 0 };
    for (const h of history) if (h.escrowed) t[h.currency ?? 'MON'] += pick(h);
    return t;
  };
  const both = (t: { MON: number; AUSD: number }) => {
    const parts = [t.AUSD ? fmtStake(t.AUSD, 'AUSD') : '', t.MON ? fmtMon(t.MON) : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : fmtStake(0, 'AUSD');
  };
  const earned = both(sumBy((h) => h.payoutSol));
  const raked = both(sumBy((h) => h.rakeSol));

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
            <MoneyRow stack label="MON" value={fmtMon(wallet.mon)} />
            <MoneyRow stack label="AUSD" value={fmtStake(ausd, 'AUSD')} />
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
                      pot {fmtStake(h.potSol, h.currency ?? 'MON')} · {h.hashes} commits
                    </span>
                    <span className="money" style={{ marginLeft: 'auto', color: !h.escrowed ? 'var(--dim)' : h.payoutSol > 0 ? 'var(--gold)' : 'var(--red)' }}>
                      {/* An unescrowed match moved nothing; showing ±SOL for it
                          would restate the number the result card already
                          disclaims. */}
                      {!h.escrowed ? 'rating only' : h.payoutSol > 0 ? `+${fmtStake(h.payoutSol, h.currency ?? 'MON')}` : `−${fmtStake(h.potSol / 2, h.currency ?? 'MON')}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <LiveOnMonad />

          <Leaderboard me={wallet.address} />

          <StakeRecovery />

          <p className="fine" style={{ fontSize: 12 }}>
            {/* A guest's browser key signs its own transactions, so on testnet
                mints and stakes spend the same real MON a connected wallet
                would. On mainnet a guest cannot sign at all — the browser key
                is testnet-only by policy. */}
            {wallet.isGuest
              ? (IS_MAINNET
                ? 'Guest mode on mainnet is play-only — connect a wallet to mint, stake, or hold anything real. '
                : `Guest mode — this browser holds a real key on the ${NETWORK_LABEL}, so mints and stakes are real transactions. Sign in with a passkey to keep the account on every device. `)
              : wallet.kind === 'passkey'
                ? 'Passkey account — derived from your passkey, never stored. Same account on any device your passkey syncs to. '
                : `${NETWORK_LABEL} — balances are read from the chain and staked matches escrow for real. `}
            Mint fee 0.01 MON · rake 10% of the pot, 5% on a draw.
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
