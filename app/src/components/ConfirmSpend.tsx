import { useEffect, useState } from 'react';
import { Pill, Spinner } from './ui';
import { PRICES, checkSpend, spendMempire, type SpendKind } from '../chain/spend';
import { explorerUrl } from '../chain/provider';
import { signer, useWallet } from '../state/wallet';
import { track } from '../lib/track';

/**
 * The dialog every $MEMPIRE purchase goes through.
 *
 * # Why a dialog at all
 *
 * These spends move a real token in a real transaction. A button that does
 * that on a single tap, with the price written somewhere else on the screen,
 * is how people end up spending something they did not mean to — and the
 * complaint afterwards is never "the transaction failed", it is "I didn't know
 * that was going to happen". So the amount, the balance, and what is bought
 * are all stated in one place, and nothing is signed until a second,
 * deliberate press.
 *
 * # Why it reads the balance itself
 *
 * The caller usually knows roughly what the player holds. "Roughly" is what
 * produces a disabled button with no reason, or worse a transaction that
 * reverts on chain with a raw SPL error. This re-reads on open and again
 * before signing, and when it is short it says by exactly how much.
 */
export function ConfirmSpend({
  kind,
  title,
  detail,
  onDone,
  onCancel,
  pay,
}: {
  kind: SpendKind;
  /**
   * Pay through a contract call instead of a plain transfer — a chest skip or
   * purchase charges inside `MempireCards`, and transferring as well would
   * charge the player twice. Returns the transaction hash.
   */
  pay?: () => Promise<string>;
  /** What is being bought, in the player's words. */
  title: string;
  /** One sentence on what they get for it. */
  detail: string;
  onDone: (signature: string) => void;
  onCancel: () => void;
}) {
  const address = useWallet((s) => s.address);
  const [state, setState] = useState<'checking' | 'ready' | 'short' | 'busy' | 'failed'>('checking');
  const [balance, setBalance] = useState(0);
  const [shortfall, setShortfall] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const price = PRICES[kind];

  useEffect(() => {
    let live = true;
    void checkSpend(signer(), kind, address).then((c) => {
      if (!live) return;
      setBalance(c.balance);
      setShortfall(c.shortfall);
      if (c.blocker && !c.affordable) setError(c.blocker);
      setState(c.affordable ? 'ready' : 'short');
    });
    return () => { live = false; };
  }, [kind, address]);

  const buy = () => {
    setState('busy');
    setError(null);
    void (pay ? pay() : spendMempire(signer(), kind, address))
      .then((sig) => {
        track('spend', { kind, price });
        // Tell the balance pill its number is stale. The transfer has confirmed
        // but this dialog is about to close, and without this the only surface
        // that shows $MEMPIRE would keep its pre-spend figure until a reload —
        // which is exactly how a real deduction looked like nothing happening.
        window.dispatchEvent(new Event('mempire-spent'));
        onDone(sig);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setState('failed');
      });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget && state !== 'busy') onCancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        background: 'rgba(0,0,0,.6)',
      }}
    >
      <div
        className="panel sheet"
        style={{
          width: 'min(100vw, 430px)', padding: '18px 16px 22px',
          display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, minWidth: 0,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>{title}</h2>
          <p className="fine" style={{ margin: '4px 0 0', color: 'var(--dim)' }}>{detail}</p>
        </div>

        <div className="well" style={{ padding: 12, borderRadius: 12, display: 'grid', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span className="label">Price</span>
            <span className="money" style={{ fontSize: 18 }}>
              {price.toLocaleString()} $MEMPIRE
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span className="fine" style={{ color: 'var(--dim)' }}>You hold</span>
            <span className="fine">
              {state === 'checking' ? 'reading…' : `${balance.toLocaleString()} $MEMPIRE`}
            </span>
          </div>
        </div>

        {state === 'short' && (
          <div
            role="alert"
            className="well"
            style={{ padding: 12, borderRadius: 10, minWidth: 0, borderColor: 'var(--red)' }}
          >
            <strong style={{ color: 'var(--red)' }}>Not enough $MEMPIRE.</strong>
            <p className="fine" style={{ margin: '4px 0 0', color: 'var(--dim)' }}>
              You need {shortfall.toLocaleString()} more. Staked wins pay 50
              $MEMPIRE each for your first sixteen.
            </p>
          </div>
        )}

        {state === 'failed' && error && (
          <div role="alert" className="fine" style={{ color: 'var(--red)' }}>{error}</div>
        )}

        <div style={{ display: 'grid', gap: 8 }}>
          <Pill
            tone="gold"
            disabled={state === 'checking' || state === 'short' || state === 'busy'}
            onClick={buy}
          >
            {state === 'busy' ? <Spinner /> : null}
            {state === 'busy'
              ? ' Confirming…'
              : state === 'short'
                ? `Need ${shortfall.toLocaleString()} more`
                : `Pay ${price.toLocaleString()} $MEMPIRE`}
          </Pill>
          <button
            type="button"
            className="fine"
            onClick={onCancel}
            disabled={state === 'busy'}
            style={{
              background: 'none', border: 0, color: 'var(--dim)',
              cursor: state === 'busy' ? 'default' : 'pointer', padding: '4px 0',
            }}
          >
            {state === 'busy' ? 'do not close this' : 'Cancel'}
          </button>
        </div>

        <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
          A real SPL transfer to the treasury. Nothing is signed until
          you press the button above.
        </p>
      </div>
    </div>
  );
}

/** The explorer link for a completed spend, for callers that show a receipt. */
export const spendReceiptUrl = (signature: string) => explorerUrl(signature);
