import { useEffect, useMemo, useState } from 'react';
import { buzz, click, play } from '../lib/audio';
import {
  CHESTS, CHEST_SLOTS,
  type ChestSlot, type OpenedChest,
} from '../state/economy';
import { ConfirmSpend } from './ConfirmSpend';
import { PRICES } from '../chain/spend';
import { buyChestTx, openChestTx, readableChainError, skipChestTx, startUnlockTx } from '../chain/actions';
import { fetchCardsFor } from '../chain/read';
import { COINS } from '../lib/coins';
import { TIER_ORDER } from '../state/economy';
import { useChain } from '../state/chain';
import { useWallet } from '../state/wallet';

/*
 * Two sources of chests, one rail.
 *
 * Signed in, chests live on chain: a staked win's chest is granted by the arena
 * in the settling transaction, its timer is a timestamp in `MempireCards`, and
 * opening it commits to the hash of the next Monad block and then reveals —
 * the cards it holds are minted as real ERC-721s. Playing as a guest without a
 * deployment, the rail keeps the local chests it always had, labelled local.
 */
const chainId = (slotId: string): number | null =>
  (slotId.startsWith('c') ? Number(slotId.slice(1)) : null);

async function openOnChain(slotId: string): Promise<OpenedChest> {
  const id = chainId(slotId)!;
  const chain = useChain.getState();
  const chest = chain.chests.find((c) => c.id === id);
  // Most drops land on a fighter the player already owns, because a duplicate
  // is what levels a card. The contract only honours coins actually held.
  const owned = [...new Set(chain.cards.map((c) => c.coinId))];
  const res = await openChestTx(id, owned);
  const me = useWallet.getState().address;
  const after = await fetchCardsFor(me);
  const byId = new Map(after.map((c) => [c.id, c]));
  const tickers = res.cardIds.map((cid) => COINS[byId.get(cid)?.coinId ?? -1]?.ticker ?? '?');
  void chain.refreshSettled();
  const tier = TIER_ORDER[chest?.tier ?? 0] ?? 'silver';
  return { ...CHESTS[tier], droppedTickers: tickers, seed: res.seed, source: 'chain' };
}

/** One-second ticker, only while something is actually counting down. */
function useTicker(active: boolean): void {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** Generated chest art; bobs and glows once it is ready to open. */
function ChestArt({ tier, size = 54, glow }: { tier: ChestSlot['tier']; size?: number; glow?: boolean }) {
  return (
    <>
      <img
        src={`/art/chest_${tier}.webp`}
        alt=""
        aria-hidden
        width={size}
        height={size}
        draggable={false}
        style={{
          display: 'block',
          filter: glow
            ? 'drop-shadow(0 0 12px rgba(255,214,102,.95)) drop-shadow(0 2px 4px rgba(0,0,0,.5))'
            : 'drop-shadow(0 3px 5px rgba(0,0,0,.55))',
          animation: glow ? 'chestBob 1.1s ease-in-out infinite' : undefined,
        }}
      />
      <style>{'@keyframes chestBob{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-5px) rotate(2deg)}}'}</style>
    </>
  );
}

/**
 * The reward moment. A chest that shakes, bursts, and sprays its contents —
 * this is the payoff the whole timer mechanic is selling, so it gets a full
 * screen rather than a toast.
 */
function OpenCeremony({
  def, onDone,
}: { def: OpenedChest; onDone: () => void }) {
  const [phase, setPhase] = useState<'shake' | 'burst'>('shake');

  useEffect(() => {
    play('chestOpen');
    buzz(24);
    const t1 = setTimeout(() => { setPhase('burst'); play('reward'); }, 700);
    return () => clearTimeout(t1);
  }, []);

  const sparks = useMemo(
    () => Array.from({ length: 22 }, (_, i) => ({
      angle: (i / 22) * Math.PI * 2,
      dist: 90 + ((i * 37) % 70),
      delay: (i % 6) * 40,
      size: 7 + ((i * 13) % 8),
    })),
    [],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${def.name} opened`}
      onClick={onDone}
      style={{
        position: 'fixed', inset: 0, zIndex: 70,
        background: 'radial-gradient(60% 45% at 50% 42%, rgba(255,214,102,.3), var(--scrim) 70%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 18,
      }}
    >
      <style>{`
        @keyframes chestShake{0%,100%{transform:rotate(-5deg) scale(1)}25%{transform:rotate(5deg) scale(1.04)}50%{transform:rotate(-6deg) scale(1)}75%{transform:rotate(6deg) scale(1.05)}}
        @keyframes chestBurst{0%{transform:scale(.7);opacity:0}40%{transform:scale(1.18);opacity:1}100%{transform:scale(1);opacity:1}}
        @keyframes sparkFly{0%{transform:translate(0,0) scale(.4);opacity:0}18%{opacity:1}100%{transform:translate(var(--dx),var(--dy)) scale(1);opacity:0}}
        @keyframes rayspin{to{transform:rotate(360deg)}}
      `}</style>

      {/* light rays behind the burst */}
      {phase === 'burst' && (
        <div
          aria-hidden
          style={{
            position: 'absolute', width: 460, height: 460,
            background: 'conic-gradient(from 0deg, rgba(255,226,138,.5) 0 6deg, transparent 6deg 30deg)',
            animation: 'rayspin 9s linear infinite',
            borderRadius: '50%', pointerEvents: 'none',
          }}
        />
      )}

      {/* sparks */}
      {phase === 'burst' && sparks.map((s, i) => (
        <span
          key={i}
          aria-hidden
          style={{
            position: 'absolute', width: s.size, height: s.size, borderRadius: '50%',
            background: 'radial-gradient(circle at 34% 30%, #fff6d0, var(--gold) 62%, #b5820a)',
            ['--dx' as string]: `${Math.cos(s.angle) * s.dist}px`,
            ['--dy' as string]: `${Math.sin(s.angle) * s.dist}px`,
            animation: `sparkFly 1100ms ${s.delay}ms cubic-bezier(.2,.7,.3,1) forwards`,
          }}
        />
      ))}

      <img
        src={phase === 'burst' ? '/art/chest_open.webp' : `/art/chest_${def.tier}.webp`}
        alt=""
        aria-hidden
        width={phase === 'burst' ? 210 : 150}
        draggable={false}
        style={{
          animation: phase === 'shake'
            ? 'chestShake 220ms linear infinite'
            : 'chestBurst 520ms var(--ease-snap)',
          filter: 'drop-shadow(0 0 26px rgba(255,214,102,.9))',
        }}
      />

      {phase === 'burst' && (
        <>
          <h2 className="display display--gold" style={{ fontSize: 34, textAlign: 'center' }}>
            {def.name}
          </h2>
          <div style={{ display: 'flex', gap: 10 }}>
            <span className="well" style={{ padding: '9px 15px' }}>
              <span className="display" style={{ fontSize: 19 }}>+{def.cards} cards</span>
            </span>
          </div>
          {/*
            The cards you actually won, as cards.

            These used to be text pills — "$MSFT" in a small well — under a
            large exploding chest. So the moment read as "a chest opened" and
            the reward, which is the whole point of opening it, was a caption
            you could miss. Someone watching over your shoulder could not tell
            you what you had won.

            Now the art leads: the fighter's portrait at the size the rest of
            the game shows a card, its ticker under it. The chest is the
            packaging; this is the thing.
          */}
          {def.droppedTickers.length > 0 && (
            <div style={{
              display: 'flex', gap: 10, flexWrap: 'wrap',
              justifyContent: 'center', maxWidth: 320,
            }}
            >
              {def.droppedTickers.map((t, i) => (
                <div
                  key={`${t}_${i}`}
                  className="well"
                  style={{
                    padding: 6, display: 'flex', flexDirection: 'column',
                    alignItems: 'center', gap: 4, width: 96,
                    borderColor: 'var(--gold)',
                  }}
                >
                  <img
                    src={`/art/card_${t.toLowerCase()}.webp`}
                    alt={`$${t}`}
                    width={84}
                    height={84}
                    loading="eager"
                    /* A missing portrait must not leave a broken-image glyph in
                       the middle of the reward — hide the art and let the
                       ticker carry it, which is what this used to be anyway. */
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    style={{
                      width: 84, height: 84, objectFit: 'cover',
                      borderRadius: 8, border: '2px solid var(--ink)',
                      background: 'var(--recess)',
                    }}
                  />
                  <span
                    className="display"
                    style={{ fontSize: 15, color: 'var(--gold-hi)', lineHeight: 1 }}
                  >
                    ${t}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="fine" style={{ color: 'var(--dim)' }}>
            {def.droppedTickers.length ? 'minted to your collection · tap to continue' : 'tap to continue'}
          </p>
          {/* The seed both the tier and these cards came from. Shown because a
              derivation nobody can see the input to is not a derivation the
              player can check — and checking it is the entire point of putting
              the roll through an oracle. */}
          <p
            className="fine"
            title={def.seed}
            style={{
              color: 'var(--dim)', fontFamily: 'ui-monospace, monospace',
              fontSize: 10, opacity: 0.75, marginTop: 2, userSelect: 'all',
            }}
          >
            ⛓ block-hash seed{' '}
            {def.seed.slice(0, 16)}…
          </p>
        </>
      )}
    </div>
  );
}

/* The slot is tall enough for a 44px action under 44px of art — 44 is the touch
   floor, and the skip label needs two lines at 320px. */
const SLOT_RATIO = '1 / 1.45';
const ACTION = {
  width: '100%', minHeight: 44, borderRadius: 7, fontSize: 12.5,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
} as const;

function Slot({ chest, onOpened, onSkipRequest, onBuyRequest }: {
  chest: ChestSlot | null;
  onOpened: (def: OpenedChest) => void;
  /** Skipping costs $MEMPIRE, so it goes through a confirmation, not a tap. */
  onSkipRequest: (chestId: string) => void;
  /** The slot is empty and the player wants to buy one for it. */
  onBuyRequest: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    void fn().catch((e) => setErr(readableChainError(e))).finally(() => setBusy(false));
  };

  if (!chest) {
    return (
      <button
        onClick={() => { click(); onBuyRequest(); }}
        aria-label={`Empty chest slot — win a battle, or buy a golden chest for ${PRICES.chestBuy} $MEMPIRE`}
        className="well"
        style={{
          aspectRatio: SLOT_RATIO, display: 'flex', alignItems: 'center',
          justifyContent: 'center', flexDirection: 'column', gap: 4, padding: 5,
          cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'center',
        }}
      >
        {/* a dark keyhole, not a blank box — the slot shows what it is for */}
        <span
          aria-hidden
          style={{
            width: 30, height: 30, borderRadius: 7,
            border: '2.5px dashed rgba(246,230,204,.34)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 15, opacity: 0.7,
          }}
        >
          🎁
        </span>
        {/* Two truths, both of them offers: the slot is earned by winning, and
            it can also be bought. Showing only "win a battle" hid the fact that
            $MEMPIRE buys one, which is the token's whole reason to exist. */}
        <span className="label" style={{ fontSize: 11, lineHeight: 1.1 }}>
          win a battle
        </span>
        <span style={{ fontSize: 11, lineHeight: 1, color: 'var(--gold-hi)', fontWeight: 800 }}>
          or {PRICES.chestBuy} $M
        </span>
      </button>
    );
  }

  const def = CHESTS[chest.tier];
  const remaining = chest.unlocking ? Math.max(0, chest.readyAt - Date.now()) : def.unlockMs;
  const ready = chest.unlocking && remaining === 0;

  return (
    <div
      className="well"
      style={{
        aspectRatio: SLOT_RATIO, padding: 5, display: 'flex',
        flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between',
        borderColor: ready ? 'var(--gold)' : undefined,
      }}
    >
      <div style={{ position: 'relative' }}>
        <ChestArt tier={chest.tier} size={44} glow={ready} />
        {/* Only a chest the oracle actually rolled gets the mark. Guest play
            rolls in the browser, and showing the same badge for both would be
            a claim about fairness this build has not earned there. */}
        {chest.source === 'chain' && (
          <span
            title="On chain — the timer is in the contract, and opening commits to the next Monad block's hash"
            aria-label="On-chain chest"
            style={{
              position: 'absolute', right: -4, bottom: -2,
              fontSize: 11, lineHeight: 1,
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.7))',
            }}
          >
            ⛓
          </span>
        )}
      </div>
      {ready ? (
        <button
          disabled={busy}
          title={err ?? undefined}
          onClick={() => {
            click();
            run(async () => { onOpened(await openOnChain(chest.id)); });
          }}
          className="btn-3d"
          style={{
            ...ACTION,
            background: 'linear-gradient(180deg,var(--btn-green-hi),var(--btn-green))',
            border: '2px solid var(--ink)', color: '#fff',
            fontFamily: 'var(--font-display)',
            WebkitTextStroke: '1.6px var(--ink)', paintOrder: 'stroke fill',
            boxShadow: 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-green-dark)',
          }}
        >
          {busy ? '…' : err ? 'RETRY' : 'OPEN'}
        </button>
      ) : chest.unlocking ? (
        // Two deliberate lines. "12h 0m · 216 $MEMPIRE" on one line wraps at every
        // width the four-slot grid can produce, which used to burst the slot.
        <button
          onClick={() => { click(); onSkipRequest(chest.id); }}
          aria-label={`Skip ${fmtLeft(remaining)} — ${PRICES.chestSkip} $MEMPIRE`}
          className="btn-3d"
          style={{
            ...ACTION,
            flexDirection: 'column', gap: 0, lineHeight: 1.05,
            background: 'var(--recess)', border: '2px solid var(--ink)',
            boxShadow: 'var(--bevel-in)',
            color: 'var(--gold-hi)', fontWeight: 800,
            opacity: 1,
          }}
        >
          <span>{fmtLeft(remaining)}</span>
          <span style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            {PRICES.chestSkip} $M
          </span>
        </button>
      ) : (
        <button
          disabled={busy}
          title={err ?? undefined}
          onClick={() => {
            click();
            run(async () => {
              await startUnlockTx(chainId(chest.id)!);
              await useChain.getState().refresh();
            });
          }}
          className="btn-3d"
          style={{
            ...ACTION,
            background: 'linear-gradient(180deg,var(--btn-blue-hi),var(--btn-blue))',
            border: '2px solid var(--ink)', color: '#fff',
            fontFamily: 'var(--font-display)',
            WebkitTextStroke: '1.6px var(--ink)', paintOrder: 'stroke fill',
            boxShadow: 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-blue-dark)',
          }}
        >
          {busy ? '…' : 'START'}
        </button>
      )}
    </div>
  );
}

/** The chest rail — four slots, exactly like the games this borrows from. */
export function ChestRail() {
  const mode = useChain((s) => s.mode);
  const chainChests = useChain((s) => s.chests);
  const chests: ChestSlot[] = mode === 'onchain'
    ? chainChests.map((c) => ({
      id: `c${c.id}`,
      tier: TIER_ORDER[c.tier] ?? 'silver',
      readyAt: c.state >= 2 ? c.readyAt * 1000 : 0,
      unlocking: c.state >= 2,
      source: 'chain',
      seed: '',
    }))
    : [];
  const [opened, setOpened] = useState<OpenedChest | null>(null);
  /** The chest whose timer the player has asked to skip, pending confirmation. */
  const [skipping, setSkipping] = useState<string | null>(null);
  /** The player has asked to buy a chest for an empty slot, pending payment. */
  const [buying, setBuying] = useState(false);
  useTicker(chests.some((c) => c.unlocking && c.readyAt > Date.now()));

  // Normally four. Grows only when a bought chest pushed past the cap, so the
  // thing someone paid for is never invisible.
  const slots: (ChestSlot | null)[] = Array.from(
    { length: Math.max(CHEST_SLOTS, chests.length) },
    (_, i) => chests[i] ?? null,
  );

  return (
    <section aria-label="Chests">
      {skipping !== null && (
        <ConfirmSpend
          kind="chestSkip"
          title="Skip the wait"
          detail="Opens this chest now instead of when its timer runs out."
          onCancel={() => setSkipping(null)}
          pay={chainId(skipping) !== null
            ? async () => {
              const r = await skipChestTx(chainId(skipping)!);
              await useChain.getState().refresh();
              return r.hash;
            }
            : undefined}
          onDone={() => setSkipping(null)}
        />
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span className="label">Chests</span>
        <span className="label" style={{ fontSize: 12 }}>
          {chests.length}/{CHEST_SLOTS} · win to earn
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 7 }}>
        {slots.map((c, i) => (
          <Slot
            key={c?.id ?? `empty_${i}`}
            chest={c}
            onOpened={setOpened}
            onSkipRequest={setSkipping}
            onBuyRequest={() => { if (mode === 'onchain') setBuying(true); }}
          />
        ))}
      </div>
      {buying && (
        <ConfirmSpend
          kind="chestBuy"
          title="Buy a golden chest"
          detail={`A ${CHESTS.golden.name} straight into a free slot — ${CHESTS.golden.cards} cards, no battle needed.`}
          onCancel={() => setBuying(false)}
          pay={mode === 'onchain'
            ? async () => {
              const r = await buyChestTx();
              await useChain.getState().refresh();
              return r.hash;
            }
            : undefined}
          onDone={() => setBuying(false)}
        />
      )}
      {opened && <OpenCeremony def={opened} onDone={() => setOpened(null)} />}
    </section>
  );
}

