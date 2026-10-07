import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { LeagueBadge, TrophyDelta } from '../components/LeagueBadge';
import { EscrowBadge } from '../components/EscrowBadge';
import { MonadLogBadge } from '../components/MonadLogBadge';
import { Commentary, OpponentBrainBadge } from '../components/Commentary';
import { CardArtWell } from '../components/CardFrame';
import { ArchetypeIcon, MoneyRow, Pill } from '../components/ui';
import { buzz, isMuted, setMuted } from '../lib/audio';
import { fmtClock, fmtStake } from '../lib/format';
import { EASE_SNAP, prefersReducedMotion } from '../lib/motion';
import { ARCHETYPES } from '../sim/archetypes';
import { FP, fp } from '../sim/fixed';
import { BattleScene, dropDecision, isLegalDrop, resolveGroundHit } from '../three/BattleScene';
import type { MatchCard } from '../sim/types';
import { CHEST_SLOTS } from '../state/economy';
import { useChain } from '../state/chain';
import { useEscrow } from '../state/escrow';
import { useMatch } from '../state/match';

function GoldBurst() {
  const parts = useMemo(() => Array.from({ length: 26 }, (_, i) => ({
    left: 8 + ((i * 37) % 84),
    delay: (i % 9) * 90,
    size: 7 + ((i * 13) % 9),
  })), []);
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      <style>{`@keyframes coinFall{0%{transform:translateY(-8vh) rotate(0);opacity:0}12%{opacity:1}100%{transform:translateY(105vh) rotate(540deg);opacity:.9}}`}</style>
      {parts.map((p, i) => (
        <span
          key={i}
          style={{
            position: 'absolute', top: 0, left: `${p.left}%`,
            width: p.size, height: p.size, borderRadius: '50%',
            background: 'radial-gradient(circle at 35% 30%, var(--gold-hi), var(--gold) 65%, #8a6a06)',
            animation: `coinFall 1600ms ${p.delay}ms cubic-bezier(.3,.1,.6,1) infinite`,
          }}
        />
      ))}
    </div>
  );
}

function ResultOverlay() {
  const { result, stakeSol, currency, dismiss, practice, soloVsBot } = useMatch();
  const fmtMon = (n: number) => fmtStake(n, currency);
  const escrowPhase = useEscrow((s) => s.phase);
  const chainChests = useChain((s) => s.chests);
  const nav = useNavigate();
  if (!result) return null;
  /**
   * Did any MON or AUSD actually move for this match.
   *
   * The card below counts a pot up in gold whether or not one exists. A guest,
   * an un-minted deck, or a wallet too thin to cover the stake all leave
   * `phase: 'failed'` and `wallet.receive()` a no-op — and the result screen is
   * the one a judge screenshots. The Arena warns beforehand and the HUD carries
   * a badge, neither of which is on this card.
   */
  const escrowed = ['waiting', 'live', 'claiming', 'claimed', 'settled', 'refunded']
    .includes(escrowPhase);
  /**
   * Escrowed, but the chain has not paid yet.
   *
   * The figures on this card come from the simulation, and the simulation
   * finishes the moment the clock does. Settlement is a separate, slower
   * thing: both sides report, or one claims a timeout. If the opponent walks
   * away, the pot sits in escrow until the timeout and
   * the payout never lands.
   *
   * The card used to announce "You take +0.09 SOL" in gold regardless, and the
   * balance behind it did not move. Claiming money that has not arrived is the
   * one thing a card about money must never do, so this state says what is
   * actually true and points at the recovery.
   */
  const awaitingPayout = escrowed && !['settled', 'refunded'].includes(escrowPhase);
  const slotsFull = chainChests.filter((c) => c.state < 4).length >= CHEST_SLOTS;
  const title = result.voided ? 'Voided' : result.draw ? 'Split' : result.won ? 'Pot Secured' : 'Rekt';
  const color = result.draw ? 'var(--dim)' : result.won ? 'var(--gold)' : 'var(--red)';
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 30,
      // No backdrop-filter. Blurring the backdrop here means re-sampling the
      // whole match canvas every frame the result card is up, on the one
      // device class least able to afford it. A heavier scrim hides the board
      // just as well and costs a single fill.
      background: 'rgba(6,14,32,.82)',
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      padding: '0 22px', gap: 14, textAlign: 'center',
      animation: 'fadeIn 300ms var(--ease-snap)',
    }}
    >
      <style>{'@keyframes fadeIn{from{opacity:0}to{opacity:1}}'}</style>
      {result.won && <GoldBurst />}
      {/* The title lands rather than fades: it starts oversized and settles onto
          the baseline, which is the one authored beat the whole product builds to. */}
      <h2
        className={result.won ? 'display display--gold' : 'display'}
        style={{
          fontSize: 48, color: result.won ? undefined : color, lineHeight: 1.05,
          animation: 'resultStamp 620ms cubic-bezier(0.16,1,0.3,1) both',
        }}
      >
        {title}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {practice ? (
          <p className="fine" style={{ fontSize: 13 }}>
            Practice match — no stake, no rake, nothing recorded.
          </p>
        ) : result.voided ? (
          <p className="fine" style={{ fontSize: 13 }}>
            The two sims stopped agreeing, so the match was annulled — your
            stake came back whole and nothing was raked or recorded.
          </p>
        ) : (
        <>
        {/* Staggered so the arithmetic reads in the order it happens: the pot
            fills, the rake is taken out of it, then what you actually take
            lands last and largest. */}
        <MoneyRow label="Pot" value={fmtMon(result.potSol)} count={{ to: result.potSol, delayMs: 340, format: fmtMon }} />
        <MoneyRow
          label={`House rake (${result.draw ? 5 : 10}%)`}
          value={`−${fmtMon(result.rakeSol)}`}
          count={{ to: result.rakeSol, prefix: '−', delayMs: 520, format: fmtMon }}
        />
        <MoneyRow
          big
          label={awaitingPayout
            ? (result.won ? 'You win (unpaid)' : result.draw ? 'Returned (unpaid)' : 'You lost')
            : result.won ? 'You take' : result.draw ? 'Returned' : 'You lost'}
          value={result.payoutSol > 0 ? `+${fmtMon(result.payoutSol)}` : `−${fmtMon(stakeSol)}`}
          count={result.payoutSol > 0
            ? { to: result.payoutSol, prefix: '+', delayMs: 700, format: fmtMon }
            : { to: stakeSol, prefix: '−', delayMs: 700, format: fmtMon }}
        />
        {!escrowed && (
          <p
            className="fine"
            style={{ fontSize: 12, color: 'var(--dim)', margin: '8px 0 0', lineHeight: 1.35 }}
          >
            Nothing was escrowed for this match, so no money changed hands — the
            figures above are what the pot would have been. This one counted for
            rating only.
          </p>
        )}
        {awaitingPayout && (
          <p
            className="fine"
            style={{ fontSize: 12, color: 'var(--gold)', margin: '8px 0 0', lineHeight: 1.35 }}
          >
            Your stake is still escrowed — this pot has not been paid out yet.
            Settlement needs both players to report, and your opponent has not.
            If it stays unpaid, reclaim it from Empire once the match times out.
          </p>
        )}
        </>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 14, alignItems: 'center' }}>
        <CrownScore crowns={result.crowns} />
      </div>

      {/* Ranked only. A trophy move is the other half of the result — for a
          ladder player it often matters more than the pot. */}
      {soloVsBot && !practice && (
        <p
          className="fine"
          style={{ fontSize: 12, color: 'var(--dim)', margin: '10px 0 0', lineHeight: 1.35 }}
        >
          Nobody else was queuing, so this one was against the AI — no trophies
          either way, and nothing was escrowed onchain. Ranked only counts a
          real opponent.
        </p>
      )}

      {typeof result.trophyDelta === 'number' && (
        <div
          className="well"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: '10px 14px',
          }}
        >
          <LeagueBadge trophies={result.trophiesAfter ?? 0} size={34} />
          <TrophyDelta delta={result.trophyDelta} floored={result.trophyDelta === 0} />
          {result.promoted && (
            <span className="display display--sm" style={{ fontSize: 14, color: 'var(--teal)' }}>
              {result.leagueAfter}!
            </span>
          )}
        </div>
      )}
      {/* Chests come only from the arena, on chain, for a staked win both
          seats agreed on. Unstaked wins earn none, so they get no row. */}
      {result.won && !practice && escrowed && (
        <div className="well" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span aria-hidden style={{ fontSize: 22 }}>🎁</span>
          <span style={{ textAlign: 'left', minWidth: 0 }}>
            <span className="display display--sm" style={{ fontSize: 15, display: 'block' }}>
              {escrowPhase === 'settled' ? 'Chest granted on chain' : slotsFull ? 'Chest slots full' : 'Chest on settlement'}
            </span>
            <span className="fine" style={{ fontSize: 12 }}>
              {escrowPhase === 'settled'
                ? 'Open it on the Cards tab'
                : slotsFull
                  ? 'The arena forfeits this chest — open one to make room'
                  : 'The arena grants it when both results land'}
            </span>
          </span>
        </div>
      )}
      <p className="fine" style={{ fontSize: 12 }}>
        {result.hashes} state hashes committed · settled by final-state signature
      </p>
      <Pill onClick={() => { dismiss(); nav('/'); }}>Return to Arena</Pill>
    </div>
  );
}

interface DragState {
  handIndex: number; // hand slot, for highlighting
  deckIndex: number; // what actually gets played — the cycle rotates
  pointerId: number;
  startX: number;
  startY: number;
  screenX: number;
  screenY: number;
  moved: boolean;
  ground: { x: number; z: number; legal: boolean } | null;
}

const TAP_SLOP_PX = 8;

/**
 * Crowns earned — the Clash Royale scoreline, one per tower felled.
 *
 * The newest crown slams in. Felling a tower is the loudest thing that happens
 * in a match and it used to register as a colour fade, which read as a value
 * update rather than a hit. Only the crown that just landed animates; the ones
 * already earned stay still, so the eye goes to the change.
 */
function CrownScore({ crowns }: { crowns: [number, number] }) {
  const Side = ({ n, mine }: { n: number; mine: boolean }) => (
    <span style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={`${i}_${i === n - 1 ? 'new' : 'old'}`}
          aria-hidden
          style={{
            fontSize: 15, lineHeight: 1,
            color: i < n ? 'var(--gold)' : 'rgba(219,232,255,.26)',
            textShadow: i < n ? '0 0 9px rgba(255,196,34,.8)' : 'none',
            transform: i < n ? 'scale(1.05)' : 'none',
            transition: 'color 240ms var(--ease-snap), transform 240ms var(--ease-snap)',
            // `key` includes n, so the freshly-earned crown remounts and replays
            animation: i === n - 1 ? 'crownSlam 420ms cubic-bezier(0.16,1,0.3,1) both' : undefined,
          }}
        >
          ♛
        </span>
      ))}
      <span
        className="display display--sm"
        style={{ fontSize: 13, color: mine ? '#4fd14f' : '#ff6b5a', marginLeft: 2 }}
      >
        {n}
      </span>
    </span>
  );
  return (
    <div
      role="img"
      aria-label={`Crowns: you ${crowns[0]}, opponent ${crowns[1]}`}
      style={{ display: 'flex', alignItems: 'center', gap: 10 }}
    >
      <Side n={crowns[0]} mine />
      <span style={{ color: 'var(--dim)', fontSize: 12 }}>vs</span>
      <Side n={crowns[1]} mine={false} />
    </div>
  );
}

/**
 * One card in the hand.
 *
 * Extracted from the map so it can hold its own "just became playable" state.
 * Crossing a card's elixir cost is gameplay information — it is the moment the
 * card becomes an option — and it used to register only as an opacity ramp
 * shared with three other cards. Now the card that crossed lifts once.
 */
function HandCard({
  card, elixir, armed, dragging, onGrab,
}: {
  card: MatchCard; elixir: number; armed: boolean; dragging: boolean;
  onGrab: (e: React.PointerEvent) => void;
}) {
  const cost = ARCHETYPES[card.archetype].elixir;
  const afford = elixir >= cost;
  const ref = useRef<HTMLButtonElement>(null);
  const wasAfford = useRef(afford);

  useEffect(() => {
    if (afford && !wasAfford.current && ref.current && !prefersReducedMotion()) {
      ref.current.animate([
        { transform: 'translateY(0) scale(1)' },
        { transform: 'translateY(-4px) scale(1.05)', offset: 0.45 },
        { transform: 'translateY(0) scale(1)' },
      ], { duration: 380, easing: EASE_SNAP });
    }
    wasAfford.current = afford;
  }, [afford]);

  return (
    <button
      ref={ref}
      disabled={!afford}
      aria-pressed={armed}
      aria-label={`Deploy ${card.name}, ${cost} elixir`}
      onPointerDown={(e) => { if (afford) onGrab(e); }}
      style={{
        flex: 1, minWidth: 0, position: 'relative',
        borderRadius: 11, padding: 3,
        background: armed
          ? 'linear-gradient(180deg, var(--btn-gold-hi), var(--btn-gold) 55%, var(--btn-gold-dark))'
          : 'linear-gradient(180deg, #8fa8d8, #5d76ad 52%, #3b4f7d)',
        border: '2.5px solid var(--ink)',
        boxShadow: armed
          ? 'inset 0 2px 0 rgba(255,255,255,.55), 0 3px 0 #7a4f04'
          : 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 #26324f',
        opacity: afford ? (dragging ? 0.4 : 1) : 0.45,
        filter: afford ? 'none' : 'saturate(.3)',
        transform: armed ? 'translateY(-7px)' : dragging ? 'translateY(-4px)' : 'none',
        transition: 'transform 150ms var(--ease-snap), opacity 150ms linear',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        touchAction: 'none',
      }}
    >
      <div style={{
        width: '100%', borderRadius: 7, padding: '6px 2px 3px',
        background: 'var(--recess)',
        boxShadow: 'inset 0 2px 5px rgba(0,0,0,.45)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      }}
      >
        {/* The fighter, not a token. At hand size the portrait is the fastest
            way to tell four cards apart under time pressure — a row of round
            badges all read as "a coin" and forced the player onto the label. */}
        <div style={{ position: 'relative', width: '100%', aspectRatio: '1 / 1' }}>
          <CardArtWell mint={card.coinId} radius={6} badgeSize={34} />
        </div>
        <span style={{
          fontFamily: 'var(--font-display)', fontSize: 12,
          WebkitTextStroke: '1.6px var(--ink)', paintOrder: 'stroke fill',
          display: 'flex', alignItems: 'center', gap: 3,
          maxWidth: '100%', minWidth: 0,
        }}
        >
          <ArchetypeIcon archetype={card.archetype} size={11} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            ${card.name.replace(/^\$+/, '')}
          </span>
        </span>
      </div>
      <span
        aria-hidden
        style={{
          position: 'absolute', top: -9, left: -5,
          width: 25, height: 25, borderRadius: '50%',
          background: 'radial-gradient(circle at 34% 28%, #ff9cf5, var(--elixir) 58%, #7a1d7a)',
          border: '2.5px solid var(--ink)',
          boxShadow: 'inset 0 2px 0 rgba(255,255,255,.5), 0 2px 4px rgba(0,0,0,.55)',
          fontFamily: 'var(--font-display)', fontSize: 14, color: '#fff',
          WebkitTextStroke: '2px var(--ink)', paintOrder: 'stroke fill',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {cost}
      </span>
    </button>
  );
}

export function Battle() {
  const match = useMatch();
  const version = useMatch((s) => s.version);
  void version; // tick-rate subscription keeps the HUD live
  // stable action reference — depending on `match` would rebuild the drag
  // listeners 20x/second for the whole match
  const playCard = useMatch((s) => s.playCard);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [confirmQuit, setConfirmQuit] = useState(false);
  /**
   * Whether any stake is genuinely at risk in this match.
   *
   * Same test the result card uses. A bot-fallback Ranked match never escrows,
   * so the forfeit warning must not price it as though it had.
   */
  const quitEscrowPhase = useEscrow((s) => s.phase);
  const quitEscrowed = ['waiting', 'live', 'claiming', 'claimed', 'settled', 'refunded']
    .includes(quitEscrowPhase);
  const [, setMuteTick] = useState(0); // re-render the mute glyph
  const sceneEl = useRef<HTMLDivElement>(null);
  const shakeEl = useRef<HTMLDivElement>(null);
  const shockId = match.shock?.id ?? 0;

  // Tower-fall impact. Driven off a ref so the WebGL context is never remounted.
  // Escape backs out of the forfeit confirm.
  useEffect(() => {
    if (!confirmQuit) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConfirmQuit(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmQuit]);

  useEffect(() => {
    if (!shockId || !shakeEl.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    shakeEl.current.animate(
      [
        { transform: 'none' },
        { transform: 'translate3d(0, 6px, 0) scale(1.014)', offset: 0.18 },
        { transform: 'translate3d(0, -4px, 0) scale(1.006)', offset: 0.44 },
        { transform: 'none' },
      ],
      { duration: 360, easing: 'cubic-bezier(.2,.9,.3,1)' },
    );
  }, [shockId]);

  const sim = match.sim;
  // Human matches can seat this client as player 1 — everything the HUD shows
  // is read from the seat, never from a hardcoded 0.
  const elixir = sim ? sim.players[match.perspective].elixirFP / FP : 0;

  const project = useCallback((clientX: number, clientY: number) => {
    const el = sceneEl.current;
    if (!el) return null;
    const hit = resolveGroundHit(clientX, clientY, el);
    if (!hit) return null;
    return { x: hit.x, z: hit.z, legal: isLegalDrop(hit.x, hit.z) };
  }, []);

  // Drag lives on window so the pointer can leave the card and cross the arena.
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      setDrag((d) => {
        if (!d) return d;
        const moved = d.moved
          || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > TAP_SLOP_PX;
        return {
          ...d, moved, screenX: e.clientX, screenY: e.clientY,
          ground: project(e.clientX, e.clientY),
        };
      });
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) return;
      const travelled = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (travelled <= TAP_SLOP_PX) {
        // a tap, not a drag → arm the card; next arena tap deploys it
        setSelected((s) => (s === drag.handIndex ? null : drag.handIndex));
      } else {
        const g = project(e.clientX, e.clientY);
        // Deep in enemy territory this is null and nothing is spent — the red
        // ring the player was just shown is the reason.
        const snapped = g ? dropDecision(g.x, g.z) : null;
        if (snapped) { playCard(drag.deckIndex, fp(snapped.x), fp(snapped.z)); buzz(14); }
        setSelected(null);
      }
      setDrag(null);
    };
    const cancel = () => setDrag(null);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [drag, project, playCard]);

  if (!sim || match.status === 'idle') return <Navigate to="/" replace />;

  const me = sim.players[match.perspective];
  const hand = me.cycle.slice(0, 4).map((deckIndex) => ({ deckIndex, card: match.playerDeck[deckIndex] }));
  const next = match.playerDeck[me.cycle[4]];
  // Read timing off the match's own format — Rush is 30s with no overtime, so
  // module constants would show a 3-minute clock on a 30-second match.
  const fmt = sim.format;
  const remaining = sim.phase === 'overtime'
    ? fmt.regulationTicks + fmt.overtimeTicks - sim.tick
    : fmt.regulationTicks - sim.tick;
  const doubleElixir = sim.phase === 'overtime' || sim.tick >= fmt.doubleElixirAt;
  const dragCard = drag ? hand[drag.handIndex]?.card : null;

  return (
    <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
      {/* top bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
        padding: '6px 8px 14px',
        background: 'linear-gradient(rgba(6,16,38,.95), rgba(6,16,38,.55) 62%, transparent)',
        display: 'flex', flexDirection: 'column', gap: 2,
      }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button
            onClick={() => setConfirmQuit(true)}
            aria-label="Forfeit match"
            className="icon-btn"
            style={{
              color: 'var(--dim)', fontSize: 19, lineHeight: 1,
              width: 44, height: 44, flexShrink: 0,
            }}
          >
            ✕
          </button>
          <span
            className="mono"
            style={{
              marginLeft: 'auto', marginRight: 'auto',
              fontSize: 19, fontWeight: 700, whiteSpace: 'nowrap',
              // urgency is not a money moment — never gold here
              color: sim.phase === 'overtime' || remaining < 600 ? 'var(--red)' : 'var(--text)',
            }}
          >
            {sim.phase === 'overtime' ? 'OT ' : ''}{fmtClock(remaining)}
          </span>
          <button
            onClick={() => { setMuted(!isMuted()); setMuteTick((n) => n + 1); }}
            aria-label={isMuted() ? 'Unmute sound' : 'Mute sound'}
            aria-pressed={isMuted()}
            className="icon-btn"
            style={{ fontSize: 15, width: 44, height: 44, flexShrink: 0, opacity: isMuted() ? 0.5 : 1 }}
          >
            {isMuted() ? '🔇' : '🔊'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <CrownScore crowns={match.crowns} />
          <span
            className={match.practice ? 'label' : 'money'}
            style={{ fontSize: 12, whiteSpace: 'nowrap' }}
          >
            {match.practice ? 'practice · no stake' : fmtStake(match.stakeSol * 2, match.currency)}
          </span>
        </div>
        {/* Which layer this match is running on, and where its money is. Both
            belong next to the pot, because both are claims about what is real —
            and "0.1 SOL" printed above a match that escrowed nothing is exactly
            the claim this pair exists to keep honest. */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
          <MonadLogBadge />
          {!match.practice && <EscrowBadge compact />}
          {/* Who holds the other seat: the classic bot or Kimi. */}
          {match.mode === 'bot' && <OpponentBrainBadge />}
        </div>
        {/* A third row, not an absolute overlay — it was landing on top of the
            crown score for the entire double-elixir phase and all of overtime. */}
        {doubleElixir && sim.phase !== 'ended' && (
          <div style={{
            textAlign: 'center', fontSize: 12, fontWeight: 800,
            letterSpacing: '.14em', color: 'var(--teal)',
          }}
          >
            2× ELIXIR
          </div>
        )}
        <Commentary />
      </div>

      <div ref={shakeEl} style={{ position: 'absolute', inset: 0 }}>
        <BattleScene
          sceneRef={sceneEl}
          perspective={match.perspective}
          onPlace={(x, y) => {
            if (drag || selected === null) return;
            // Same rule as the drag path — an armed card tapped deep in enemy
            // territory is refused rather than snapped back to the line.
            const snapped = dropDecision(x / FP, y / FP);
            if (snapped) {
              playCard(hand[selected].deckIndex, fp(snapped.x), fp(snapped.z));
              setSelected(null);
            }
          }}
          placing={drag !== null || selected !== null}
          marker={drag?.ground ?? null}
        />
      </div>

      {/* dragged card ghost following the finger */}
      {drag?.moved && dragCard && (
        <div
          aria-hidden
          style={{
            position: 'fixed', left: drag.screenX, top: drag.screenY, zIndex: 25,
            transform: 'translate(-50%, -120%) scale(1.12)', pointerEvents: 'none',
            filter: drag.ground?.legal === false ? 'grayscale(.7)' : 'none',
            transition: 'filter 120ms linear',
          }}
        >
          {/* The ghost is the card itself lifted off the HUD, so it wears the
              CardFrame face. The legality ring is the only thing added. */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            padding: '8px 10px', borderRadius: 14,
            background: 'linear-gradient(180deg, #8fa8d8, #5d76ad 52%, #3b4f7d)',
            border: `2.5px solid ${drag.ground?.legal ? 'var(--teal)' : 'var(--red)'}`,
            boxShadow: 'inset 0 2px 0 rgba(255,255,255,.4), 0 10px 26px rgba(0,0,0,.6)',
          }}
          >
            <div style={{ position: 'relative', width: 46, height: 46 }}>
              <CardArtWell mint={dragCard.coinId} radius={6} badgeSize={34} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 800 }}>{dragCard.name}</span>
          </div>
        </div>
      )}

      {/* bottom HUD */}
      <div className="wood" style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
        padding: '9px 10px calc(10px + env(safe-area-inset-bottom))',
        borderTop: '3px solid var(--wood-edge)',
        boxShadow: '0 -6px 18px rgba(0,0,0,.55), inset 0 2px 0 rgba(255,255,255,.16)',
        display: 'flex', flexDirection: 'column', gap: 7,
      }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            role="progressbar"
            aria-label="Elixir"
            aria-valuemin={0}
            aria-valuemax={10}
            aria-valuenow={Math.floor(elixir)}
            style={{
              flex: 1, height: 20, borderRadius: 7,
              background: 'var(--recess)',
              border: '2.5px solid var(--ink)',
              boxShadow: 'var(--bevel-in)',
              overflow: 'hidden', position: 'relative',
            }}
          >
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(180deg, #ff9cf5, var(--elixir) 48%, #8c1f8c)',
              boxShadow: 'inset 0 2px 0 rgba(255,255,255,.4)',
              transform: `scaleX(${elixir / 10})`, transformOrigin: 'left',
              transition: 'transform 110ms linear',
            }}
            />
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} style={{
                position: 'absolute', left: `${((i + 1) / 10) * 100}%`, top: 0, bottom: 0,
                width: 2, background: 'rgba(6,16,38,.6)',
              }}
              />
            ))}
          </div>
          <span
            className="display"
            style={{ fontSize: 21, color: '#ff9cf5', minWidth: 30, textAlign: 'right' }}
          >
            {Math.floor(elixir)}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          {hand.map(({ card, deckIndex }, i) => (
            <HandCard
              key={`${card.coinId}_${i}`}
              card={card}
              elixir={elixir}
              armed={selected === i}
              dragging={drag?.handIndex === i && drag.moved}
              onGrab={(e) => {
                e.preventDefault();
                setDrag({
                  handIndex: i, deckIndex, pointerId: e.pointerId,
                  startX: e.clientX, startY: e.clientY,
                  screenX: e.clientX, screenY: e.clientY,
                  moved: false,
                  ground: project(e.clientX, e.clientY),
                });
              }}
            />
          ))}
          <div style={{
            width: 44, display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: 3, opacity: 0.6,
          }}
          >
            <span className="label" style={{ fontSize: 12 }}>next</span>
            {next && (
              <div style={{ position: 'relative', width: 28, height: 28 }}>
                <CardArtWell mint={next.coinId} radius={5} badgeSize={22} />
              </div>
            )}
          </div>
        </div>
        <p style={{
          fontSize: 12, color: drag || selected !== null ? 'var(--teal)' : 'var(--dim-on-wood)',
          textAlign: 'center', margin: 0, minHeight: 18, lineHeight: '18px',
        }}
        >
          {drag?.moved
            ? (drag.ground?.legal ? 'release to deploy' : 'your half only')
            : selected !== null
              ? 'tap your half to deploy'
              : 'drag a card onto your half of the arena'}
        </p>
      </div>

      {confirmQuit && match.status === 'battle' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm forfeit"
          style={{
            position: 'absolute', inset: 0, zIndex: 40, background: 'var(--scrim)',
            display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 28, gap: 12,
          }}
        >
          {/*
            Three cases, because there are three. The dialog used to have two
            and told a bot-fallback player "your opponent takes the 0.1 SOL
            pot" over a button reading "Forfeit — lose 0.05 SOL" — for a match
            where nothing had been escrowed and the balance could not move. The
            result screen then said "nothing was escrowed, so no SOL changed
            hands", contradicting the warning that had just been used to talk
            them out of leaving. A confirmation that overstates the cost is the
            same defect as one that understates it.
          */}
          <p style={{ textAlign: 'center', fontSize: 15 }}>
            {match.practice
              ? 'Leave practice? Nothing is staked.'
              : quitEscrowed
                ? `Forfeit the match? Your opponent takes the ${fmtStake(match.stakeSol * 2, match.currency)} pot.`
                : 'Leave the match? Nothing was escrowed, so no money changes hands — it counts as a loss for rating only.'}
          </p>
          <Pill danger onClick={() => { setConfirmQuit(false); match.forfeit(); }}>
            {match.practice
              ? 'Leave practice'
              : quitEscrowed ? `Forfeit — lose ${fmtStake(match.stakeSol, match.currency)}` : 'Leave the match'}
          </Pill>
          <Pill ghost onClick={() => setConfirmQuit(false)}>Keep fighting</Pill>
        </div>
      )}

      {match.status === 'settled' && <ResultOverlay />}
    </div>
  );
}
