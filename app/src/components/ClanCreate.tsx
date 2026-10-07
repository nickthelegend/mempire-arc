import { useEffect, useRef, useState } from 'react';
import {
  ClanCrest, CREST_EMBLEMS, CREST_SHAPES, type Crest,
} from './ClanCrest';
import { Pill } from './ui';
import { click, play } from '../lib/audio';
import { REGIONS, useClan, type JoinMode } from '../state/clan';
import { useDeck } from '../state/deck';
import { PRICES, checkSpend, spendMempire } from '../chain/spend';
import { signer, useWallet } from '../state/wallet';

/**
 * Found a clan.
 *
 * The crest builder is the point of this sheet: the crest is four integers, so
 * it can be previewed live at full size while you pick it, with no upload, no
 * crop step and no moderation queue. Cycling a facet is one tap.
 *
 * Founding costs $MEMPIRE, which is the honest monetisation here — it buys a
 * cosmetic and social privilege, never power.
 *
 * The order of operations is the whole design. Affordability is checked before
 * anything is created, the clan is created before anyone is charged, and a
 * founder who does not complete the payment loses the clan again. Each of those
 * closes a different hole: charging for a name the server then rejects, and
 * founding for free by walking away from the till.
 */
export function ClanCreateSheet({ onClose, onFounded }: {
  onClose: () => void;
  /**
   * The server accepted the clan; collect the charter fee.
   *
   * Handed upward rather than rendered here because founding flips the Clan
   * screen from "browse" to "your clan", which unmounts this sheet. A till
   * that lives inside the thing being replaced never opens — which is exactly
   * how the charter silently became free.
   */
  onFounded: (name: string) => void;
}) {
  const address = useWallet((s) => s.address);
  const power = useDeck((s) => s.power());
  const { create, busy } = useClan();
  const sheet = useRef<HTMLDivElement>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [region, setRegion] = useState<string>('Global');
  const [joinMode, setJoinMode] = useState<JoinMode>('open');
  const [requiredPower, setRequiredPower] = useState(0);
  const [crest, setCrest] = useState<Crest>({ shape: 0, emblem: 0, hue: 212, tone: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    sheet.current?.focus();

  return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nameOk = name.trim().length >= 3;

  const cycle = (key: keyof Crest, mod: number, step = 1) => {
    click();
    setCrest((c) => ({ ...c, [key]: (c[key] + step + mod) % mod }));
  };

  /*
   * Pay, then found.
   *
   * It used to be the other way round, for a good reason: discovering the name
   * is taken *after* the tokens have moved is the one outcome this flow must
   * never produce. But creating first made the fee optional — the server had
   * no evidence anybody had paid, and the undo it relied on was this browser
   * choosing to call `leave`. A founder who closed the tab kept the clan free.
   *
   * The original concern goes away because a failed attempt does not consume
   * the payment: the server records a signature only on a clan it actually
   * creates, and refuses one that has already chartered a clan. A rejected
   * name therefore leaves the receipt in hand, the next submit reuses it, and
   * nobody pays twice. `paid` is what holds it.
   */
  const [paid, setPaid] = useState<string | null>(null);

  const submit = async () => {
    if (!nameOk) { setError('name must be at least 3 characters'); return; }
    setError(null);

    let signature = paid;
    if (!signature) {
      // Ask about money before spending any, so somebody who cannot afford it
      // is told while the sheet is still theirs to edit.
      const afford = await checkSpend(signer(), 'clanCharter', address);
      if (!afford.affordable) { setError(afford.blocker); play('error'); return; }
      try {
        signature = await spendMempire(signer(), 'clanCharter', address);
        setPaid(signature);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'the charter payment did not go through');
        play('error');
        return;
      }
    }

    const err = await create(address, {
      name: name.trim(),
      description: description.trim(),
      region,
      crest,
      requiredPower,
      joinMode,
      power,
      paymentTx: signature,
    });
    if (err) {
      // Still paid, still unspent — say so, so a retry does not read as
      // "pay again".
      setError(`${err} — your charter is paid; pick another name and try again.`);
      play('error');
      return;
    }
    onFounded(name.trim());
  };

  const field: React.CSSProperties = {
    width: '100%', minHeight: 44, padding: '0 12px', borderRadius: 9,
    background: 'var(--recess)', border: '2px solid var(--ink)',
    boxShadow: 'var(--bevel-in)', color: 'var(--text)',
    fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 700,
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 58, display: 'flex', justifyContent: 'center' }}>
      <div aria-hidden onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }} />
      <div
        ref={sheet}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Create a clan"
        className="panel sheet"
        style={{ maxHeight: '94dvh', overflowY: 'auto', gap: 11 }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 className="display" style={{ fontSize: 23 }}>Found a clan</h2>
          <button
            onClick={() => { click(); onClose(); }}
            aria-label="Close"
            className="icon-btn"
            style={{ marginLeft: 'auto', fontSize: 26, width: 44, height: 44, color: 'var(--dim-on-wood)' }}
          >
            ×
          </button>
        </div>

        {/* crest builder — live preview beside the controls that change it */}
        <div className="well" style={{ padding: 11, display: 'flex', gap: 13, alignItems: 'center' }}>
          <ClanCrest crest={crest} size={78} title="Your clan crest preview" />
          <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
            {([
              ['Shield', 'shape', CREST_SHAPES],
              ['Emblem', 'emblem', CREST_EMBLEMS],
              ['Shade', 'tone', 3],
            ] as const).map(([label, key, mod]) => (
              <button
                key={key}
                onClick={() => cycle(key, mod)}
                className="btn-3d"
                aria-label={`Change ${label.toLowerCase()}`}
                style={{
                  minHeight: 44, borderRadius: 9, padding: '0 11px',
                  background: 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))',
                  border: '2px solid var(--ink)',
                  boxShadow: 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-blue-dark)',
                  fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text)',
                  WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                }}
              >
                <span>{label}</span>
                <span aria-hidden style={{ opacity: 0.85 }}>›</span>
              </button>
            ))}
          </div>
        </div>

        {/* hue is continuous, so it gets a slider rather than a cycle button */}
        <label style={{ display: 'block' }}>
          <span className="label" style={{ display: 'block', marginBottom: 5 }}>Colour</span>
          <input
            type="range"
            min={0}
            max={359}
            value={crest.hue}
            onChange={(e) => setCrest((c) => ({ ...c, hue: Number(e.target.value) }))}
            aria-label="Crest colour"
            style={{
              width: '100%', minHeight: 44, accentColor: `hsl(${crest.hue} 62% 52%)`,
            }}
          />
        </label>

        <label style={{ display: 'block' }}>
          <span className="label" style={{ display: 'block', marginBottom: 5 }}>Name</span>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            placeholder="Degen Dynasty"
            maxLength={22}
            style={field}
          />
        </label>

        <label style={{ display: 'block' }}>
          <span className="label" style={{ display: 'block', marginBottom: 5 }}>Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="we like alpha"
            maxLength={120}
            style={field}
          />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label style={{ display: 'block', minWidth: 0 }}>
            <span className="label" style={{ display: 'block', marginBottom: 5 }}>Region</span>
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              style={{ ...field, padding: '0 8px' }}
            >
              {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label style={{ display: 'block', minWidth: 0 }}>
            <span className="label" style={{ display: 'block', marginBottom: 5 }}>Min power</span>
            <input
              type="number"
              min={0}
              max={9999}
              value={requiredPower}
              onChange={(e) => setRequiredPower(Math.max(0, Math.min(9999, Number(e.target.value) || 0)))}
              style={field}
            />
          </label>
        </div>

        <div>
          <span className="label" style={{ display: 'block', marginBottom: 5 }}>Who can join</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['open', 'request', 'closed'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { click(); setJoinMode(m); }}
                aria-pressed={joinMode === m}
                className="btn-3d"
                style={{
                  flex: 1, minHeight: 44, borderRadius: 9,
                  background: joinMode === m
                    ? 'linear-gradient(180deg, var(--btn-green-hi), var(--btn-green))'
                    : 'var(--recess)',
                  border: '2px solid var(--ink)',
                  boxShadow: joinMode === m
                    ? 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-green-dark)'
                    : 'var(--bevel-in)',
                  fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text)',
                  WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
                  textTransform: 'capitalize',
                }}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p role="alert" className="fine" style={{ color: 'var(--red-on-wood)', textAlign: 'center' }}>
            {error}
          </p>
        )}

        <Pill
          onClick={() => { void submit(); }}
          disabled={busy || !nameOk}
          style={{ fontSize: 18 }}
        >
          {busy
            ? 'Founding…'
            : `Found clan · ${PRICES.clanCharter.toLocaleString()} $MEMPIRE`}
        </Pill>

        <p className="fine" style={{ color: 'var(--dim-on-wood)', textAlign: 'center', fontSize: 12 }}>
          A charter costs {PRICES.clanCharter.toLocaleString()} $MEMPIRE, paid to the
          treasury. Founding is cosmetic and social — it never buys power.
        </p>
      </div>
    </div>
  );
}
