import { useState } from 'react';
import { Pill, Spinner } from './ui';
import { useWallet } from '../state/wallet';

/*
 * The one prompt a Privy player sees, once a day: letting the relay play their
 * moves. It says exactly what the session signer can do — and, more
 * importantly, what it cannot — because "allow this app to sign for you" is a
 * sentence nobody should accept without the list.
 */
export function PrivySigner() {
  const kind = useWallet((s) => s.kind);
  const consent = useWallet((s) => s.privyConsent);
  const grant = useWallet((s) => s.grantPrivySigner);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  if (kind !== 'privy' || dismissed) return null;

  if (consent) {
    return (
      <section className="well" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden>🛡️</span>
        <span className="fine" style={{ color: 'var(--dim)' }}>
          Session signer on · arena moves only · until {new Date(consent.expiresAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </section>
    );
  }

  return (
    <section className="well" style={{ padding: '10px 12px', display: 'grid', gap: 6 }} aria-label="Session signer">
      <span className="label">No popups mid-match?</span>
      <p className="fine" style={{ color: 'var(--dim)', margin: 0 }}>
        Let Mempire send your card plays and your result for 24 hours, gas paid. A Privy policy
        limits it to three arena calls — <b>play</b>, <b>checkpoint</b>, <b>claim</b> — with zero value.
        It can never move your stake, your cards or your tokens.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
        <Pill
          tone="gold"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setErr(null);
            void grant().catch((e) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
          }}
        >
          {busy ? <Spinner /> : 'Allow for 24h'}
        </Pill>
        <Pill tone="blue" onClick={() => setDismissed(true)}>Not now</Pill>
      </div>
      {err && <span className="fine" style={{ color: 'var(--red)' }}>{err}</span>}
    </section>
  );
}
