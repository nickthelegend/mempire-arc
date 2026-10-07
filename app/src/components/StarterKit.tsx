import { useEffect, useRef, useState } from 'react';
import { IS_MAINNET } from '../chain/provider';
import { fmtUsdc } from '../lib/format';
import { fetchStarterClaimed } from '../chain/read';
import { Pill, Spinner } from './ui';
import { apiPost } from '../lib/api';
import { useChain } from '../state/chain';
import { useWallet } from '../state/wallet';

/*
 * The first thirty seconds of an account.
 *
 * A brand-new passkey account holds nothing — no USDC, no cards — and a game
 * that answers that with "go find a faucet" has lost the player before the
 * first match. So the first time an account signs in on testnet, the relay does
 * it for them, without being asked: it mints the eight-fighter starter deck
 * straight to the account (the contract allows it once per address, and only
 * from the relayer) and sends 2 test USDC — on Arc that one token is both the
 * stake and the gas. The player watches it land.
 *
 * On Arc mainnet the deck is still free, but only for an account that already
 * holds a dollar of USDC (the relayer's gas is real money there), and there is
 * no drip: the player brings USDC — see the Deposit panel.
 */

type Phase = 'idle' | 'busy' | 'done' | 'failed' | 'gone';

const triedThisSession = new Set<string>();

export function StarterKit() {
  const address = useWallet((s) => s.address);
  const connected = useWallet((s) => s.connected);
  const mode = useChain((s) => s.mode);
  const cards = useChain((s) => s.cards);
  const refreshSettled = useChain((s) => s.refreshSettled);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [took, setTook] = useState<number | null>(null);
  // What the relay did about USDC: 'sent' (testnet drip), 'skipped' (already
  // funded) or 'unconfigured' (mainnet: no drip).
  const [usdc, setUsdc] = useState<string | null>(null);
  const balance = useWallet((s) => s.usdc);
  const started = useRef(false);

  const claim = async () => {
    setPhase('busy');
    setError(null);
    const t0 = performance.now();
    try {
      const r = await apiPost('/api/onboard', 'onboard', {});
      if (!r) throw new Error('could not reach the relay, or this account could not sign');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `the relay answered ${r.status}`);
      await refreshSettled();
      setTook(performance.now() - t0);
      setUsdc(typeof j?.usdc === 'string' ? j.usdc : null);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  };

  useEffect(() => {
    if (!connected || !address || mode === 'offline') return;
    // Mainnet: the relay mints the free deck only once the account holds $1.
    if (IS_MAINNET && balance < 1) return;
    if (cards.length > 0 || started.current || triedThisSession.has(address)) return;
    started.current = true;
    triedThisSession.add(address);
    void fetchStarterClaimed(address).then((claimed) => {
      if (!claimed) void claim();
    }).catch(() => { /* the button below is the fallback */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, address, mode, cards.length, balance >= 1]);

  if (phase === 'gone' || phase === 'idle') return null;

  return (
    <section className="well" style={{ padding: '10px 12px', display: 'grid', gap: 6 }} aria-live="polite">
      {phase === 'busy' && (
        <>
          <span className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Spinner size={14} /> Minting your starter deck on Arc…
          </span>
          <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
            {IS_MAINNET ? 'Eight fighters to your account, gas on us.' : 'Eight fighters to your account, and 2 test USDC: stakes and gas, one token.'}
          </p>
        </>
      )}
      {phase === 'done' && (
        <>
          <span className="label" style={{ color: 'var(--teal)' }}>
            Your deck is on chain{took !== null ? ` · ${(took / 1000).toFixed(1)}s` : ''}
          </span>
          <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
            {usdc === 'sent'
              ? `Eight ERC-721 fighters and ${fmtUsdc(2)} of test USDC are yours. Pick a tier in the Arena and put a dollar on your first match.`
              : 'Eight ERC-721 fighters are yours. Pick a tier in the Arena and put a dollar on your first match.'}
          </p>
          <button
            type="button"
            className="fine"
            onClick={() => setPhase('gone')}
            style={{ background: 'none', border: 0, color: 'var(--dim)', cursor: 'pointer', padding: 0, textAlign: 'left' }}
          >
            dismiss
          </button>
        </>
      )}
      {phase === 'failed' && (
        <>
          <span className="label">Starter deck didn&apos;t land</span>
          <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
            {error} — practice matches still work while this is sorted.
          </p>
          <Pill tone="gold" onClick={() => void claim()}>Try again</Pill>
        </>
      )}
    </section>
  );
}
