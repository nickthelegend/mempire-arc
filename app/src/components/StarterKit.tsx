import { useEffect, useRef, useState } from 'react';
import { IS_MAINNET } from '../chain/provider';
import { fetchStarterClaimed } from '../chain/read';
import { Pill, Spinner } from './ui';
import { apiPost } from '../lib/api';
import { useChain } from '../state/chain';
import { useWallet } from '../state/wallet';

/*
 * The first thirty seconds of an account.
 *
 * A brand-new passkey account holds nothing — no MON for gas, no cards, no
 * currency — and a game that answers that with "go find a faucet" has lost the
 * player before the first match. So the first time an account signs in, the
 * relay does it for them, without being asked: it mints the eight-fighter
 * starter deck straight to the account (the contract allows it once per
 * address, and only from the relayer), requests 10,000 test AUSD from Agora's
 * testnet faucet, and drips a little MON for gas. The player watches it land.
 *
 * Testnet only. Nothing here exists on mainnet, where the starter deck would
 * be something a player buys.
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
  // What the relay did about AUSD: 'sent', or 'queued' inside Agora's faucet
  // cooldown (the relay retries on its own about a minute later).
  const [ausd, setAusd] = useState<string | null>(null);
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
      setAusd(typeof j?.ausd === 'string' ? j.ausd : null);
      setPhase('done');
      if (j?.ausd === 'queued') {
        // The relay's retry lands ~65 s later; refresh balances after it.
        setTimeout(() => { void refreshSettled().then(() => setAusd('sent')); }, 75_000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    }
  };

  useEffect(() => {
    if (IS_MAINNET || !connected || !address || mode === 'offline') return;
    if (cards.length > 0 || started.current || triedThisSession.has(address)) return;
    started.current = true;
    triedThisSession.add(address);
    void fetchStarterClaimed(address).then((claimed) => {
      if (!claimed) void claim();
    }).catch(() => { /* the button below is the fallback */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, address, mode, cards.length]);

  if (IS_MAINNET || phase === 'gone' || phase === 'idle') return null;

  return (
    <section className="well" style={{ padding: '10px 12px', display: 'grid', gap: 6 }} aria-live="polite">
      {phase === 'busy' && (
        <>
          <span className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Spinner size={14} /> Minting your starter deck on Monad…
          </span>
          <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
            Eight fighters to your account, test AUSD for stakes, and a little MON for gas.
          </p>
        </>
      )}
      {phase === 'done' && (
        <>
          <span className="label" style={{ color: 'var(--teal)' }}>
            Your deck is on chain{took !== null ? ` · ${(took / 1000).toFixed(1)}s` : ''}
          </span>
          <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
            {ausd === 'queued'
              ? 'Eight ERC-721 fighters and gas are yours. Your test AUSD is on its way: Agora\'s faucet pays one account a minute, and the relay retries on its own.'
              : 'Eight ERC-721 fighters are yours, plus test AUSD and gas. Pick a tier in the Arena and put a dollar on your first match.'}
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
