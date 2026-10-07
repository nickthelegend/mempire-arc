import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CardDetail } from '../components/CardDetail';
import { StarterKit } from '../components/StarterKit';
import { CardFrame } from '../components/CardFrame';
import { ChainBadge } from '../components/ChainBadge';
import { ChestRail } from '../components/Chests';
import { Shop } from '../components/Shop';
import { CoinBadge, Pill, Spinner } from '../components/ui';
import { mintCardTx, readableChainError, upgradeCardTx } from '../chain/actions';
import { click, play } from '../lib/audio';
import { useChain } from '../state/chain';
import {
  ASSET_KINDS, COINS, ineligibleReason, tickerOf,
  type AssetKind, type Coin,
} from '../lib/coins';
import { fmtMon, fmtUsd } from '../lib/format';
import { EASE_SNAP, usePulse } from '../lib/motion';
import { revealSection } from '../lib/scroll';
import { FEES, useCollection } from '../state/collection';
import { useWallet } from '../state/wallet';
import { Token } from '../components/Token';
import { useMempire } from '../state/mempire';

/** "All" first, then the three asset classes from the shared catalogue. */
const FILTERS: { id: AssetKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  ...ASSET_KINDS,
];
const TAP = { minHeight: 44 } as const;

function CoinRow({ coin }: { coin: Coin }) {
  const wallet = useWallet();
  const { cards } = useCollection();
  const chainMode = useChain((s) => s.mode);
  const chainBalances = useChain((s) => s.balances);
  const chainCards = useChain((s) => s.cards);
  const chainSol = useChain((s) => s.solBalance);
  const refreshSettled = useChain((s) => s.refreshSettled);
  const noteSignature = useChain((s) => s.noteSignature);
  const [minting, setMinting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onchain = chainMode === 'onchain';
  const reason = ineligibleReason(coin);
  // Starter cards excluded: they are not something this wallet minted, and
  // counting them hid the Mint button on all eight of them.
  const owned = cards.filter((c) => c.mint === coin.mint && !c.seeded).length;

  /*
   * The onchain cards for this coin, lowest id first. The oldest is the one
   * kept — it is the one most likely to already be sitting in a deck — and
   * every later one is a duplicate that can be merged into it for a level.
   */
  const mine = chainCards
    .filter((c) => c.mint === coin.mint)
    .sort((a, b) => a.id - b.id);
  const keep = mine[0];
  const dupes = mine.slice(1);

  const merge = async () => {
    if (!keep || !dupes.length) return;
    setMerging(true);
    setChainError(null);
    try {
      const { hash } = await upgradeCardTx(keep.id, dupes[0].id, keep.level);
      noteSignature(hash);
      play('reward');
      void refreshSettled();
    } catch (e) {
      setChainError(readableChainError(e));
      play('error');
    } finally {
      setMerging(false);
    }
  };
  // Holdings are never read: a fighter is a character, not collateral. What
  // the row shows instead is the market the fighter answers to today — its
  // price, its 24h move, and the modifier MarketMeta gave it this epoch.
  void chainBalances;
  const affordable = onchain ? chainSol >= FEES.mintMon : wallet.mon >= FEES.mintMon;
  // No live quote → the relay can't sign a price → the contract would refuse.
  const live = coin.priceUsd > 0;
  // Holding the coin is no longer a requirement, on chain or here. The balance
  // still renders on the row — how much of a coin you hold is interesting — it
  // simply no longer decides whether you may mint its card.

  /**
   * Onchain: one wallet-signed transaction; the program re-checks eligibility,
   * charges the fee, and creates the Card PDA. The local card is only minted
   * after the signature confirms, so the collection never shows a card the
   * chain refused.
   */
  const mintOnchain = async () => {
    setMinting(true);
    setChainError(null);
    try {
      const { hash } = await mintCardTx(coin.coinId);
      noteSignature(hash);
      play('reward');
      void refreshSettled();
    } catch (e) {
      setChainError(readableChainError(e));
      play('error');
    } finally {
      setMinting(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
      <CoinBadge mint={coin.mint} size={40} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>
          {tickerOf(coin)}
          {owned > 0 && (
            <span style={{ color: 'var(--teal)', fontSize: 12, marginLeft: 6 }}>
              {owned} card{owned > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--dim-on-wood)' }}>
          {coin.priceUsd > 0 ? fmtUsd(coin.priceUsd) : '—'}
          {typeof coin.change24h === 'number' && ` · ${coin.change24h >= 0 ? '+' : ''}${coin.change24h.toFixed(1)}%`}
          {coin.metaBps ? (
            <span style={{ marginLeft: 6, fontWeight: 800, color: coin.metaBps > 0 ? 'var(--teal)' : 'var(--red-on-wood)' }}>
              {coin.metaBps > 0 ? '▲' : '▼'} {Math.abs(coin.metaBps / 100).toFixed(1)}% today
            </span>
          ) : null}
          {chainError && (
            <span role="alert" style={{ display: 'block', color: 'var(--red-on-wood)', fontWeight: 700 }}>
              {chainError}
            </span>
          )}
        </div>
      </div>
      <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
        {reason ? (
          // Bare --red on wood is 2.3:1. The chip gives it a ground to sit on.
          <span
            className="well"
            style={{
              display: 'inline-block', padding: '5px 8px', fontSize: 12,
              fontWeight: 700, color: 'var(--red-on-wood)', maxWidth: 116,
              textAlign: 'center', lineHeight: 1.25,
            }}
          >
            {reason}
          </span>
        ) : dupes.length > 0 && keep ? (
          /* Duplicates are the progression now.
             Decks are one-card-per-coin, so a second card for a coin you own
             can never be fielded — it used to be a mint fee spent on nothing.
             Merging it closes the duplicate, returns its rent, and buys a
             level for the card you keep. */
          <button
            onClick={() => void merge()}
            disabled={merging || keep.level >= 10}
            aria-label={keep.level >= 10
              ? `${tickerOf(coin)} is at maximum level`
              : `Merge a duplicate into ${tickerOf(coin)} for level ${keep.level + 1}`}
            className="btn-3d"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              padding: '0 11px', ...TAP, borderRadius: 'var(--r-pill)',
              fontFamily: 'var(--font-display)', fontSize: 13,
              background: keep.level >= 10
                ? 'var(--recess)'
                : 'linear-gradient(180deg, var(--btn-green-hi), var(--btn-green) 52%, var(--btn-green-dark))',
              border: '2px solid var(--ink)',
              boxShadow: keep.level >= 10
                ? 'var(--bevel-in)'
                : 'inset 0 2px 0 rgba(255,255,255,.45), 0 3px 0 var(--btn-green-dark)',
              color: 'var(--text)',
              WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
              whiteSpace: 'nowrap',
            }}
          >
            {merging && <Spinner />}
            {keep.level >= 10
              ? 'Max level'
              : merging ? 'Merging' : <>Merge · Lv {keep.level + 1}</>}
          </button>
        ) : owned > 0 ? (
          <span
            className="well"
            style={{
              display: 'inline-block', padding: '5px 10px', fontSize: 12,
              fontWeight: 700, color: 'var(--teal)', maxWidth: 116,
              textAlign: 'center', lineHeight: 1.25,
            }}
          >
            minted
          </span>
        ) : (
          <button
            onClick={() => {
              if (onchain) void mintOnchain();
            }}
            disabled={minting || !affordable || !onchain || !live}
            title={!live ? 'No live price for this coin right now — a card is minted only at a fresh price' : affordable ? undefined : `needs ${fmtMon(FEES.mintMon)}`}
            className="btn-3d"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '0 14px', ...TAP, borderRadius: 'var(--r-pill)',
              fontFamily: 'var(--font-display)', fontSize: 14, letterSpacing: '0.03em',
              background: affordable
                ? 'linear-gradient(180deg, var(--btn-gold-hi), var(--btn-gold) 52%, var(--btn-gold-dark))'
                : 'var(--recess)',
              border: '2px solid var(--ink)',
              boxShadow: affordable
                ? 'inset 0 2px 0 rgba(255,255,255,.45), 0 3px 0 var(--btn-gold-dark)'
                : 'var(--bevel-in)',
              color: 'var(--text)',
              WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
              opacity: minting ? 0.7 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {minting && <Spinner />}
            {minting ? 'Minting' : !live ? 'No live price' : affordable ? `Mint · ${fmtMon(FEES.mintMon)}` : 'Need MON'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The last confirmed transaction, linked to the explorer.
 *
 * This row is the difference between claiming the mint was onchain and letting
 * the player check. It renders only in onchain mode, because a link that
 * resolves to nothing would be worse than no link.
 */
function TxReceipt() {
  const sig = useChain((s) => s.lastSignature);
  const mode = useChain((s) => s.mode);
  const explorer = useChain((s) => s.explorer);
  if (!sig || mode !== 'onchain') return null;
  return (
    <a
      href={explorer(sig)}
      target="_blank"
      rel="noopener noreferrer"
      className="well"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, marginTop: 8,
        padding: '9px 11px', minHeight: 44, textDecoration: 'none', color: 'inherit',
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--teal)', boxShadow: '0 0 7px var(--teal)', flexShrink: 0 }} />
      <span className="fine" style={{ fontSize: 12, minWidth: 0, flex: 1 }}>
        last tx <span className="mono">{sig.slice(0, 8)}…{sig.slice(-6)}</span>
      </span>
      <span className="label" style={{ fontSize: 12, color: 'var(--blue-pale)', flexShrink: 0 }}>
        explorer ↗
      </span>
    </a>
  );
}


/**
 * The wallet's $MEMPIRE. The game's only currency, and the only counter here.
 *
 * This used to sit beside a Crowns pill showing a different, offchain number,
 * and the Crowns one was bigger, gold, and had a `+` on it — so that is the
 * one players watched. They would spend 25 $MEMPIRE on a chest skip, see the
 * gold counter stay on 120, and conclude nothing had been charged. The
 * transfer had happened every time. There were simply two currencies on one
 * header and the wrong one looked like the token.
 *
 * Tapping it opens the Empire wallet panel, where the account's balances and
 * the honest answer to "how do I get more" live: staked wins pay it.
 */
function MempireBalance({ onGet }: { onGet: () => void }) {
  const address = useWallet((s) => s.address);
  const balance = useMempire((s) => s.balance);
  const refresh = useMempire((s) => s.refresh);

  useEffect(() => { void refresh(address || null); }, [address, refresh]);

  const pulse = usePulse(balance ?? 0, [
    { transform: 'scale(1)' },
    { transform: 'scale(1.28)', offset: 0.38 },
    { transform: 'scale(1)' },
  ], { duration: 440, easing: EASE_SNAP });

  return (
    <button
      onClick={onGet}
      aria-label={balance === null
        ? 'Get $MEMPIRE'
        : `${balance.toLocaleString()} MEMPIRE — get more`}
      className="btn-3d"
      style={{
        marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6,
        minHeight: 44, padding: '0 13px', borderRadius: 999,
        background: 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))',
        border: '2.5px solid var(--ink)',
        boxShadow: 'inset 0 2px 0 rgba(255,255,255,.45), 0 4px 0 var(--btn-blue-dark)',
      }}
    >
      <Token size={17} />
      <span
        ref={pulse as React.RefObject<HTMLSpanElement>}
        className="display display--sm"
        style={{ fontSize: 16, display: 'inline-block' }}
      >
        {/* An em dash until the first read lands. Rendering 0 here is the same
            lie the throttled-RPC bug told: a funded wallet reading empty. */}
        {balance === null ? '—' : balance.toLocaleString()}
      </span>
      <span className="display display--sm" style={{ fontSize: 16, opacity: 0.85 }}>+</span>
    </button>
  );
}

export function Cards() {
  const nav = useNavigate();
  const cards = useCollection((s) => s.cards);
  const connected = useWallet((s) => s.connected);
  const openPicker = useWallet((s) => s.openPicker);
  /** What actually exists on chain, so the header can stop guessing. */
  const chainCards = useChain((s) => s.cards);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const bagsRef = useRef<HTMLElement>(null);
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const shownCoins = useMemo(
    () => (kind === 'all' ? COINS : COINS.filter((c) => c.kind === kind)),
    [kind],
  );
  const detail = useMemo(() => cards.find((c) => c.id === openCard), [cards, openCard]);
  // Cards at level 2 or better — the ones that have actually been won up.
  const levelled = cards.filter((c) => !c.seeded && c.level > 1).length;

  if (!connected) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 16, padding: 30, textAlign: 'center',
      }}
      >
        <h1 className="display" style={{ fontSize: 30 }}>Cards</h1>
        <p style={{ color: 'var(--dim)', fontSize: 14 }}>
          Connect a wallet to mint fighters you keep. Minting costs a small fee
          and never touches the coins in your wallet.
        </p>
        <Pill onClick={openPicker} style={{ maxWidth: 260 }}>Connect Wallet</Pill>
      </div>
    );
  }

  return (
    <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <div>
          <h1 className="display" style={{ fontSize: 30 }}>Cards</h1>
          {/* "8 minted · $487 staked" was the same sentence whether or not a
              single card existed on chain — a new player's starter deck is
              local until they mint it, and both of those words are claims. The
              count says onchain only when `chainCards` backs it. */}
          <p className="fine">
            {chainCards.length > 0
              ? <>{chainCards.length} minted onchain{levelled > 0 && <> · <span className="money" style={{ fontSize: 14 }}>{levelled}</span> levelled up</>}</>
              : <>{cards.length} cards · not minted onchain yet</>}
          </p>
        </div>
        <MempireBalance onGet={() => nav('/empire')} />
      </header>

      <StarterKit />

      <ChestRail />

      <Shop />

      <section aria-label="Your cards">
        {/* This section is the point of the screen; its neighbours both carry a
            visible header, so without one it read as a gap between them. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span className="label">Your cards</span>
          <span className="label" style={{ fontSize: 12 }}>{cards.length} minted</span>
        </div>
        {cards.length === 0 ? (
          <div className="panel" style={{ padding: '20px 18px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 11, alignItems: 'center' }}>
            <span style={{ color: 'var(--dim-on-wood)', fontSize: 14 }}>
              bag is empty, anon — turn a coin you hold into a card
            </span>
            <Pill
              tone="blue"
              onClick={() => revealSection(bagsRef.current)}
              style={{ maxWidth: 220, fontSize: 15, minHeight: 46, padding: '10px 18px' }}
            >
              Show my bags
            </Pill>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
            {cards.map((c) => (
              <CardFrame key={c.id} card={c} width={104} fluid onClick={() => setOpenCard(c.id)} />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Your bags" ref={bagsRef} style={{ scrollMarginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
          <span className="label">Your bags · mint fee {fmtMon(FEES.mintMon)}</span>
          <ChainBadge compact />
        </div>

        {/* Memes, blue-chips and stocks are three different reasons to be here,
            and the list is long enough that scrolling past two of them to reach
            the third is the whole problem. Counts are on the chips so an empty
            class is visible before it is tapped. */}
        <div
          role="tablist"
          aria-label="Filter bags by asset class"
          style={{ display: 'flex', gap: 6, marginBottom: 7 }}
        >
          {FILTERS.map((f) => {
            const on = kind === f.id;
            const n = f.id === 'all' ? COINS.length : COINS.filter((c) => c.kind === f.id).length;
            return (
              <button
                key={f.id}
                role="tab"
                aria-selected={on}
                onClick={() => { click(); setKind(f.id); }}
                className="btn-3d"
                style={{
                  flex: 1, minWidth: 0, minHeight: 44, borderRadius: 9,
                  background: on
                    ? 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))'
                    : 'var(--recess)',
                  border: '2px solid var(--ink)',
                  boxShadow: on
                    ? 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-blue-dark)'
                    : 'var(--bevel-in)',
                  fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text)',
                  WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
                  transition: 'background 160ms var(--ease-snap)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                }}
              >
                {f.label}
                <span style={{ opacity: 0.8, fontSize: 12 }}>{n}</span>
              </button>
            );
          })}
        </div>

        <div className="panel" style={{ padding: '4px 14px' }}>
          {shownCoins.length === 0 ? (
            <p style={{ padding: '18px 0', textAlign: 'center', color: 'var(--dim-on-wood)', fontSize: 13 }}>
              nothing here yet, anon
            </p>
          ) : shownCoins.map((c, i) => (
            <div key={c.mint} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
              <CoinRow coin={c} />
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'var(--dim)', marginTop: 8 }}>
          A fighter can be minted only with a fresh Pyth price for it, posted in the
          mint transaction itself — no live price, no card. Today&apos;s ▲▼ is the
          market meta: Chainlink CRE (24h move) or Pyth momentum (spot vs its moving
          average) becomes a bounded (±15%) stat modifier on chain.
        </p>
        <TxReceipt />
      </section>

      {detail && (
        <CardDetail
          card={detail}
          onClose={() => setOpenCard(null)}
        />
      )}
    </div>
  );
}
