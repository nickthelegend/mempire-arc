import { useState } from 'react';
import { Pill, Spinner } from './ui';
import { coinByMint, coinByTicker } from '../lib/coins';
import { loadLocker, openLocker, saveLocker, type OpenLocker } from '../lib/locker';
import { passkeyErrorText } from '../lib/passkey';
import { useCollection } from '../state/collection';
import { useDeck } from '../state/deck';
import { useWallet } from '../state/wallet';

/*
 * The locker, on the Deck screen.
 *
 * Opening it is one passkey prompt for a namespace the account never uses.
 * Saving writes the deck slots and the notes as ciphertext under an id the
 * relay cannot tie to this account; restoring on another device with the same
 * passkey brings them back. The open locker lives in this component's state
 * only — closing the sheet or reloading forgets the key.
 */
export function PasskeyLocker() {
  const kind = useWallet((s) => s.kind);
  const [locker, setLocker] = useState<OpenLocker | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (kind !== 'passkey') return null;

  const decksAsTickers = (): string[][] => {
    const { cards } = useCollection.getState();
    const { slots } = useDeck.getState();
    return slots.map((slot) => slot
      .map((id) => cards.find((c) => c.id === id))
      .map((c) => (c ? coinByMint(c.mint)?.ticker : undefined))
      .filter((t): t is string => !!t));
  };

  const applyDecks = (decks: string[][]) => {
    const { cards } = useCollection.getState();
    const { slot } = useDeck.getState();
    const slots = decks.map((tickers) => tickers
      .map((t) => coinByTicker(t)?.mint)
      .map((mint) => cards.find((c) => c.mint === mint)?.id)
      .filter((id): id is string => !!id)
      .slice(0, 8));
    while (slots.length < 3) slots.push([]);
    useDeck.setState({ slots, active: slots[slot] ?? slots[0] });
  };

  const run = (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setMsg(null);
    void fn().then(setMsg).catch((e) => setMsg(passkeyErrorText(e))).finally(() => setBusy(null));
  };

  const ensureOpen = async (): Promise<OpenLocker> => {
    if (locker) return locker;
    const l = await openLocker();
    setLocker(l);
    return l;
  };

  return (
    <section className="panel" style={{ padding: 12, display: 'grid', gap: 8 }} aria-label="Passkey locker">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="label">🔐 Passkey locker</span>
        <span className="fine" style={{ marginLeft: 'auto', color: 'var(--dim-on-wood)', fontSize: 11 }}>
          {locker ? `open · id ${locker.id.slice(0, 8)}…` : 'end-to-end encrypted'}
        </span>
      </div>
      <p className="fine" style={{ margin: 0, color: 'var(--dim-on-wood)' }}>
        Your decks and scouting notes, encrypted by a key only your passkey can produce — a
        different key from your account&apos;s. The relay stores ciphertext under an id it
        cannot link to you. Same passkey on another device, same locker.
      </p>
      {locker && (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="Scouting notes — who you lost to, what beat you, what to try"
          style={{
            width: '100%', padding: 8, borderRadius: 8, border: '2px solid var(--ink)',
            background: 'var(--recess)', color: 'var(--text)', font: 'inherit', fontSize: 14, resize: 'vertical',
          }}
        />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Pill
          tone="blue"
          disabled={busy !== null}
          onClick={() => run('restore', async () => {
            const l = await ensureOpen();
            const got = await loadLocker(l);
            if (!got) return 'This passkey has no locker yet — save one first.';
            applyDecks(got.decks);
            setNotes(got.notes);
            return `Restored ${got.decks.filter((d) => d.length).length} deck(s) saved ${new Date(got.savedAt).toLocaleString()}.`;
          })}
        >
          {busy === 'restore' ? <Spinner /> : locker ? 'Restore' : 'Open locker'}
        </Pill>
        <Pill
          tone="gold"
          disabled={busy !== null}
          onClick={() => run('save', async () => {
            const l = await ensureOpen();
            await saveLocker(l, { v: 1, savedAt: Date.now(), decks: decksAsTickers(), notes });
            return 'Saved. Open the locker with this passkey on any device to get it back.';
          })}
        >
          {busy === 'save' ? <Spinner /> : 'Save to locker'}
        </Pill>
      </div>
      {msg && <p className="fine" role="status" style={{ margin: 0, color: 'var(--dim-on-wood)' }}>{msg}</p>}
    </section>
  );
}
