import { IS_MAINNET, NETWORK_LABEL } from '../chain/provider';
import { useEffect, useState } from 'react';
import { click } from '../lib/audio';
import { useWallet } from '../state/wallet';
import { passkeyHint, passkeysSupported } from '../lib/passkey';
import { PRIVY_APP_ID, privyAvailable } from '../lib/privy';
import { Spinner } from './ui';

/** Guest mark — the only entry without an official adapter icon. */
function GuestMark({ size = 34 }: { size?: number }) {
  return (
    <img
      src="/art/avatar_guest.webp"
      alt=""
      aria-hidden
      width={size}
      height={size}
      style={{ display: 'block', borderRadius: 8 }}
    />
  );
}

/**
 * `busy` is the row the player actually tapped. Dimming every row equally while
 * one connects left no trace of which one was chosen — the only signal was a
 * 12px sub-line.
 */
function Row({
  onClick, disabled, busy, mark, title, sub, right, highlight,
}: {
  onClick: () => void; disabled?: boolean; busy?: boolean; mark: React.ReactNode;
  title: string; sub: string; right?: React.ReactNode; highlight?: boolean;
}) {
  return (
    <button
      onClick={() => { click(); onClick(); }}
      disabled={disabled}
      /* Every row here is an icon plus styled spans, and the tree was computing
         no accessible name at all from them — the whole connect step read as a
         stack of unlabelled buttons to a screen reader. */
      aria-label={`${title} — ${sub}`}
      className="btn-3d"
      style={{
        display: 'flex', alignItems: 'center', gap: 11, width: '100%',
        padding: '9px 13px', minHeight: 58, borderRadius: 'var(--r-card)',
        textAlign: 'left',
        background: highlight
          ? 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))'
          : 'var(--recess)',
        border: `2.5px solid ${busy ? 'var(--gold)' : 'var(--ink)'}`,
        boxShadow: highlight
          ? 'inset 0 2px 0 rgba(255,255,255,.45), 0 4px 0 var(--btn-blue-dark)'
          : 'var(--bevel-in)',
        opacity: disabled && !busy ? 0.45 : 1,
      }}
    >
      {mark}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="display display--sm" style={{ display: 'block', fontSize: 16 }}>
          {title}
        </span>
        <span className="fine" style={{ display: 'block', fontSize: 12, color: 'var(--dim)' }}>
          {sub}
        </span>
      </span>
      {right}
    </button>
  );
}

/** The passkey mark: a key, in the arcade's own frame. */
function KeyMark({ size = 34 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size, height: size, borderRadius: 8, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(180deg, var(--gold-hi), var(--gold))',
        border: '2px solid var(--ink)', fontSize: size * 0.55,
      }}
    >
      🔑
    </span>
  );
}

/*
 * Sign in.
 *
 * The passkey comes first because it is the whole account: one fingerprint or
 * face check creates it, the same check on any of the player's devices brings
 * it back, and there is no seed phrase, extension or custodian anywhere in the
 * path. Guest is the fallback for a browser whose passkey store cannot derive
 * keys. Browser wallets are listed as they announce themselves (EIP-6963), for
 * players who already have one.
 */
export function WalletPicker() {
  const {
    pickerOpen, closePicker, connect, connectGuest, createPasskey, signInPasskey,
    connecting, error, wallets, locked, connectPrivy,
  } = useWallet();
  const [name, setName] = useState('');
  // Email sign-in is offered only when the build and the relay both have Privy.
  const [privyOn, setPrivyOn] = useState(false);
  useEffect(() => {
    if (pickerOpen && PRIVY_APP_ID) void privyAvailable().then(setPrivyOn);
  }, [pickerOpen]);
  const hint = passkeyHint();
  const passkeys = passkeysSupported();

  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePicker(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen, closePicker]);

  if (!pickerOpen) return null;
  const busy = connecting !== null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'center' }}>
      <div aria-hidden onClick={closePicker} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sign in"
        className="panel sheet"
        style={{ maxHeight: '90dvh', overflowY: 'auto', gap: 9 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
          <div>
            <h2 className="display" style={{ fontSize: 25, lineHeight: 1.1 }}>
              {locked && hint ? 'Welcome back' : 'Play Mempire'}
            </h2>
            <p className="fine" style={{ color: 'var(--dim-on-wood)' }}>
              {IS_MAINNET ? 'Monad mainnet · real funds move' : `${NETWORK_LABEL} · no real funds move`}
            </p>
          </div>
          <button
            onClick={() => { click(); closePicker(); }}
            aria-label="Close"
            className="icon-btn"
            style={{ marginLeft: 'auto', color: 'var(--dim-on-wood)', fontSize: 27, width: 44, height: 44, flexShrink: 0 }}
          >
            ×
          </button>
        </div>

        {passkeys && hint && (
          <Row
            highlight
            disabled={busy}
            busy={connecting === 'passkey'}
            onClick={() => void signInPasskey()}
            mark={<KeyMark />}
            title={locked ? `Unlock as ${hint.name}` : `Sign in as ${hint.name}`}
            sub={connecting === 'passkey' ? 'Confirm with your passkey…' : `${hint.address.slice(0, 6)}…${hint.address.slice(-4)} · one passkey prompt`}
            right={connecting === 'passkey' ? <Spinner size={16} /> : undefined}
          />
        )}

        {passkeys && (
          <div className="well" style={{ padding: 10, borderRadius: 'var(--r-card)', display: 'grid', gap: 8 }}>
            <label className="label" htmlFor="pk-name" style={{ fontSize: 12 }}>
              {hint ? 'Or make a new account' : 'Create your account — no seed phrase, no extension'}
            </label>
            <input
              id="pk-name"
              value={name}
              maxLength={24}
              placeholder="Player name"
              onChange={(e) => setName(e.target.value)}
              style={{
                minHeight: 44, padding: '0 12px', borderRadius: 8, border: '2px solid var(--ink)',
                background: 'var(--recess)', color: 'var(--text)', font: 'inherit', fontSize: 16,
              }}
            />
            <Row
              highlight={!hint}
              disabled={busy}
              busy={connecting === 'passkey'}
              onClick={() => void createPasskey(name || 'Player')}
              mark={<KeyMark />}
              title="Create with passkey"
              sub="Face ID, fingerprint or device PIN — the passkey is the account"
            />
            {!hint && (
              <button
                type="button"
                className="fine"
                disabled={busy}
                onClick={() => { click(); void signInPasskey(); }}
                style={{ background: 'none', border: 'none', color: 'var(--teal)', cursor: 'pointer', fontWeight: 800, minHeight: 32 }}
              >
                I already have a Mempire passkey
              </button>
            )}
          </div>
        )}

        {privyOn && (
          <Row
            disabled={busy}
            busy={connecting === 'privy'}
            onClick={() => void connectPrivy()}
            mark={<span aria-hidden style={{ width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', border: '2px solid var(--ink)', fontSize: 18 }}>✉️</span>}
            title="Continue with email"
            sub="Privy embedded wallet · gas sponsored · no popups mid-match"
            right={connecting === 'privy' ? <Spinner size={16} /> : undefined}
          />
        )}

        <Row
          disabled={busy}
          onClick={connectGuest}
          mark={<GuestMark />}
          title="Play as Guest"
          sub={IS_MAINNET
            ? 'Play-only on mainnet — sign in to mint or stake'
            : `A key kept in this browser — plays and stakes · ${NETWORK_LABEL}`}
        />

        {wallets.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '3px 2px' }}>
            <span style={{ flex: 1, height: 2, background: 'rgba(0,0,0,.3)' }} />
            <span className="label" style={{ fontSize: 12, color: 'var(--dim-on-wood)' }}>or a browser wallet</span>
            <span style={{ flex: 1, height: 2, background: 'rgba(0,0,0,.3)' }} />
          </div>
        )}
        {wallets.map((w) => {
          const isBusy = connecting === w.name;
          return (
            <Row
              key={w.id}
              disabled={busy}
              busy={isBusy}
              onClick={() => void connect(w.id)}
              mark={(
                <img src={w.icon} alt="" aria-hidden width={34} height={34} style={{ display: 'block', borderRadius: 8 }} />
              )}
              title={w.name}
              sub={isBusy ? 'Approve in your wallet…' : `Detected · switches to ${NETWORK_LABEL}`}
              right={isBusy ? <Spinner size={16} /> : undefined}
            />
          );
        })}

        {error && (
          <p role="alert" className="fine" style={{ color: 'var(--red-on-wood)', textAlign: 'center' }}>{error}</p>
        )}
        <p className="fine" style={{ color: 'var(--dim-on-wood)', textAlign: 'center' }}>
          Mempire never asks for a seed phrase, and never touches anything you hold.
        </p>
      </div>
    </div>
  );
}
