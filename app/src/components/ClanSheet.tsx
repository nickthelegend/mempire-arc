import { useEffect, useRef } from 'react';
import { ClanCrest } from './ClanCrest';
import { CrownCount, MemberCount, MemberRow } from './ClanBits';
import { Pill } from './ui';
import { click } from '../lib/audio';
import { useClan } from '../state/clan';
import { useDeck } from '../state/deck';
import { useWallet } from '../state/wallet';

/**
 * Clan preview before joining.
 *
 * The reference puts the crest on a hanging banner, three stats in a strip, then
 * the roster under a Join button. That order is right and kept: identity, then
 * the facts that decide whether you can join, then who is already inside.
 *
 * The Join button states the reason it is unavailable rather than just going
 * grey — "needs 240 power" is actionable, a disabled button is not.
 */
export function ClanSheet({ onJoin }: { onJoin: (tag: string) => void }) {
  const { preview, closePreview, busy } = useClan();
  const address = useWallet((s) => s.address);
  const myPower = useDeck((s) => s.power());
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePreview(); };
    window.addEventListener('keydown', onKey);
    sheet.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, closePreview]);

  if (!preview) return null;

  const full = preview.memberCount >= preview.memberCap;
  const underPowered = myPower < preview.requiredPower;
  const closed = preview.joinMode === 'closed';
  const alreadyIn = preview.members.some((m) => m.address === address);

  const blocker = alreadyIn ? 'You are already in this clan'
    : closed ? 'This clan is closed to new members'
      : full ? 'This clan is full'
        : underPowered ? `Needs ${preview.requiredPower} deck power — yours is ${myPower}`
          : null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 56, display: 'flex', justifyContent: 'center' }}>
      <div aria-hidden onClick={closePreview} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }} />
      <div
        ref={sheet}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${preview.name} clan details`}
        className="panel sheet"
        style={{ maxHeight: '92dvh', overflowY: 'auto', gap: 11 }}
      >
        {/* identity */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <ClanCrest crest={preview.crest} size={62} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="display" style={{ fontSize: 23, lineHeight: 1.1 }}>{preview.name}</h2>
            <p className="fine" style={{ color: 'var(--dim-on-wood)', fontSize: 12 }}>
              <span className="mono">#{preview.tag}</span>
            </p>
            <p style={{ fontSize: 12.5, color: 'var(--dim-on-wood)', marginTop: 3, lineHeight: 1.3 }}>
              {preview.description}
            </p>
          </div>
          <button
            onClick={() => { click(); closePreview(); }}
            aria-label="Close"
            className="icon-btn"
            style={{ fontSize: 26, width: 44, height: 44, color: 'var(--dim-on-wood)', flexShrink: 0 }}
          >
            ×
          </button>
        </div>

        {/* the facts that decide */}
        <div className="well" style={{ display: 'flex', padding: '10px 4px', textAlign: 'center' }}>
          {([
            ['Region', <span key="r" className="display display--sm" style={{ fontSize: 14 }}>{preview.region}</span>],
            ['Needs power', (
              <span
                key="p"
                className="display display--sm"
                style={{ fontSize: 16, color: underPowered ? 'var(--red-on-wood)' : undefined }}
              >
                {preview.requiredPower || '—'}
              </span>
            )],
            ['Lent weekly', <span key="l" className="display display--sm" style={{ fontSize: 16 }}>{preview.weeklyLent}</span>],
          ] as const).map(([label, node]) => (
            <div key={label} style={{ flex: 1, minWidth: 0, padding: '0 4px' }}>
              {node}
              <div className="label" style={{ fontSize: 12, marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>

        {/* standing + join */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <MemberCount count={preview.memberCount} cap={preview.memberCap} />
            <CrownCount n={preview.crowns} size={15} />
          </span>
          <span style={{ marginLeft: 'auto', width: 'min(56%, 190px)' }}>
            <Pill
              tone="green"
              disabled={busy || blocker !== null}
              onClick={() => onJoin(preview.tag)}
              style={{ fontSize: 17, minHeight: 46, padding: '10px 16px' }}
            >
              {busy ? 'Joining…' : 'Join'}
            </Pill>
          </span>
        </div>

        {blocker && (
          <p
            className="well"
            style={{
              color: 'var(--red-on-wood)', fontSize: 12.5, fontWeight: 700,
              padding: '8px 10px', textAlign: 'center',
            }}
          >
            {blocker}
          </p>
        )}

        {/* roster */}
        <div>
          <div className="label" style={{ marginBottom: 5 }}>Members</div>
          <div style={{ background: 'var(--recess)', borderRadius: 'var(--r-card)', boxShadow: 'var(--bevel-in)', border: '2px solid rgba(0,0,0,.4)', padding: '2px 4px' }}>
            {preview.members.map((m, i) => (
              <div key={m.address} style={{ borderTop: i === 0 ? 'none' : '2px solid rgba(0,0,0,.26)' }}>
                <MemberRow member={m} rank={i + 1} isMe={m.address === address} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
