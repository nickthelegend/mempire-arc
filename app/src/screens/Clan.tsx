import { useEffect, useMemo, useState } from 'react';
import { ClanCreateSheet } from '../components/ClanCreate';
import { ClanCrest } from '../components/ClanCrest';
import { ClanRow, CrownCount, LendRequest, MemberCount, MemberRow } from '../components/ClanBits';
import { ClanSheet } from '../components/ClanSheet';
import { PRICES } from '../chain/spend';
import { ArchetypeIcon, Pill, Spinner } from '../components/ui';
import { click, play } from '../lib/audio';
import { ARCHETYPES } from '../sim/archetypes';
import { ARCHETYPE_NAMES, type Archetype } from '../sim/types';
import { useClan, type ClanSummary } from '../state/clan';
import { useDeck } from '../state/deck';
import { useMempire } from '../state/mempire';
import { useWallet } from '../state/wallet';
import { Token, TokenAmount } from '../components/Token';

/**
 * The Clan tab.
 *
 * Three states, one screen: not connected, no clan (browse and create), and in a
 * clan (roster, lend feed, management). Clash Royale splits these across a stack
 * of modals; a single centred column reads better as one screen that changes.
 */

// ── browse ─────────────────────────────────────────────────────────────────
function Browse({ onFounded }: { onFounded: (name: string) => void }) {
  const address = useWallet((s) => s.address);
  const power = useDeck((s) => s.power());
  const balance = useMempire((s) => s.balance);
  const { results, loading, offline, error, search, open, join, busy } = useClan();

  const [term, setTerm] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);
  const [hasRoom, setHasRoom] = useState(true);
  const [withinPower, setWithinPower] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const filters = useMemo(() => ({
    q: term.trim() || undefined,
    openOnly,
    hasRoom,
    maxRequiredPower: withinPower ? power : undefined,
  }), [term, openOnly, hasRoom, withinPower, power]);

  // Runs once on mount and whenever a filter toggles — but not per keystroke,
  // which is what the Search button is for.
  useEffect(() => { void search(filters); }, [openOnly, hasRoom, withinPower, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const doJoin = async (tag: string) => {
    setJoinError(await join(address, tag, power));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section className="panel" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ display: 'flex', gap: 7 }}>
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(filters); }}
            placeholder="Clan name or #TAG"
            aria-label="Search clans by name or tag"
            maxLength={24}
            style={{
              flex: 1, minWidth: 0, minHeight: 44, padding: '0 12px',
              borderRadius: 9, background: 'var(--recess)',
              border: '2px solid var(--ink)', boxShadow: 'var(--bevel-in)',
              color: 'var(--text)', fontFamily: 'var(--font-ui)',
              fontSize: 14, fontWeight: 700,
            }}
          />
          <button
            onClick={() => { click(); void search(filters); }}
            className="btn-3d"
            style={{
              flexShrink: 0, minHeight: 44, padding: '0 16px', borderRadius: 9,
              background: 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))',
              border: '2px solid var(--ink)',
              boxShadow: 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-blue-dark)',
              fontFamily: 'var(--font-display)', fontSize: 14, color: 'var(--text)',
              WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
            }}
          >
            Search
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="label" style={{ flex: 1 }}>
            <span aria-hidden>🔍</span> Filters
          </span>
          <button
            onClick={() => { click(); setAdvanced((v) => !v); }}
            aria-expanded={advanced}
            className="btn-3d"
            style={{
              minHeight: 44, padding: '0 14px', borderRadius: 9,
              background: advanced
                ? 'linear-gradient(180deg, var(--btn-blue-hi), var(--btn-blue))'
                : 'var(--recess)',
              border: '2px solid var(--ink)',
              boxShadow: advanced
                ? 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-blue-dark)'
                : 'var(--bevel-in)',
              fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text)',
              WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
            }}
          >
            {advanced ? 'Hide' : 'Show'}
          </button>
        </div>

        {advanced && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {([
              ['Has room', hasRoom, setHasRoom],
              ['Open to join', openOnly, setOpenOnly],
              [`My power (${power})`, withinPower, setWithinPower],
            ] as const).map(([label, on, setter]) => (
              <button
                key={label}
                onClick={() => { click(); setter(!on); }}
                aria-pressed={on}
                className="btn-3d"
                style={{
                  minHeight: 44, padding: '0 12px', borderRadius: 9,
                  background: on
                    ? 'linear-gradient(180deg, var(--btn-green-hi), var(--btn-green))'
                    : 'var(--recess)',
                  border: '2px solid var(--ink)',
                  boxShadow: on
                    ? 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-green-dark)'
                    : 'var(--bevel-in)',
                  fontSize: 12.5, fontWeight: 800, color: 'var(--text)',
                  letterSpacing: '.03em',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </section>

      {joinError && (
        <p role="alert" className="well" style={{ color: 'var(--red-on-wood)', fontSize: 13, padding: '9px 11px', textAlign: 'center', fontWeight: 700 }}>
          {joinError}
        </p>
      )}

      <section aria-label="Clan search results" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {loading && !results.length ? (
          <div className="well" style={{ padding: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
            <Spinner size={16} />
            <span className="fine">searching…</span>
          </div>
        ) : offline ? (
          <div className="panel" style={{ padding: 20, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 9 }}>
            <span className="display display--sm" style={{ fontSize: 17 }}>Clans are offline</span>
            <span className="fine" style={{ color: 'var(--dim-on-wood)' }}>
              {error ?? 'The clan service is unreachable.'} Everything else keeps working.
            </span>
          </div>
        ) : !results.length ? (
          <div className="panel" style={{ padding: 20, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 11, alignItems: 'center' }}>
            <ClanCrest crest={{ shape: 2, emblem: 0, hue: 212, tone: 0 }} size={54} />
            <span style={{ color: 'var(--dim-on-wood)', fontSize: 14, maxWidth: 260 }}>
              {term ? `nothing matches "${term}"` : 'no clans yet, anon — found the first one'}
            </span>
            <Pill onClick={() => { click(); setCreating(true); }} style={{ maxWidth: 220, fontSize: 15, minHeight: 46, padding: '10px 18px' }}>
              Create a clan
            </Pill>
          </div>
        ) : (
          results.map((c: ClanSummary) => (
            <ClanRow key={c.tag} clan={c} onClick={() => { click(); void open(c.tag); }} />
          ))
        )}
      </section>

      {!!results.length && (
        <Pill
          onClick={() => { click(); setCreating(true); }}
          tone="gold"
          disabled={busy}
          style={{ fontSize: 18 }}
        >
          Create new · <TokenAmount amount={PRICES.clanCharter} size={14} />
        </Pill>
      )}

      <p className="fine" style={{ textAlign: 'center', fontSize: 12 }}>
        You hold {balance === null ? '—' : balance.toLocaleString()} $MEMPIRE · one clan per wallet
      </p>

      <ClanSheet onJoin={doJoin} />
      {creating && (
        <ClanCreateSheet
          onClose={() => setCreating(false)}
          onFounded={(name) => { setCreating(false); onFounded(name); }}
        />
      )}
    </div>
  );
}

// ── in a clan ──────────────────────────────────────────────────────────────
function Home() {
  const address = useWallet((s) => s.address);
  const {
    mine, busy, error, leave, requestCard, lend, myRole,
  } = useClan();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [asking, setAsking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (!mine) return null;
  const role = myRole(address);
  const canManage = role === 'leader' || role === 'coleader';

  const openRequests = mine.feed.filter((f) => f.kind === 'request' && !f.filledBy);
  const myOpen = openRequests.find((f) => f.address === address);

  const doLend = async (id: string) => {
    const err = await lend(address, id);
    setLocalError(err);
    // The lend reward used to be 5 Crowns mirrored locally. Crowns are gone,
    // and $MEMPIRE cannot be minted client-side — it is a real SPL balance, so
    // the only honest way to pay this is a transfer from the treasury. Until
    // the relay does that, lending is thanks and standing, not a payout.
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* identity */}
      <section className="panel" style={{ padding: '12px 13px', display: 'flex', gap: 12, alignItems: 'center' }}>
        <ClanCrest crest={mine.crest} size={64} title={`${mine.name} crest`} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2
            className="display display--sm"
            style={{ fontSize: 18, lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {mine.name}
          </h2>
          <p className="fine" style={{ color: 'var(--dim-on-wood)', fontSize: 12 }}>
            <span className="mono">#{mine.tag}</span> · {mine.region}
          </p>
          <p style={{ fontSize: 12.5, color: 'var(--dim-on-wood)', marginTop: 3, lineHeight: 1.3 }}>
            {mine.description}
          </p>
        </div>
      </section>

      {/* the three numbers, matching the reference's stat strip */}
      <section className="well" style={{ display: 'flex', padding: '10px 4px', textAlign: 'center' }}>
        {([
          ['Crowns', <CrownCount key="c" n={mine.crowns} size={16} />],
          ['Members', <MemberCount key="m" count={mine.memberCount} cap={mine.memberCap} />],
          ['Lent weekly', (
            <span key="l" className="display display--sm" style={{ fontSize: 16 }}>
              {mine.weeklyLent}
            </span>
          )],
        ] as const).map(([label, node]) => (
          <div key={label} style={{ flex: 1, minWidth: 0 }}>
            {node}
            <div className="label" style={{ fontSize: 12, marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </section>

      {(error || localError) && (
        <p role="alert" className="well" style={{ color: 'var(--red-on-wood)', fontSize: 13, padding: '9px 11px', textAlign: 'center', fontWeight: 700 }}>
          {error ?? localError}
        </p>
      )}

      {/* lend feed */}
      <section aria-label="Lend requests">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span className="label">Lend requests</span>
          <span className="label" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              +5<Token size={12} /> to lend
            </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {openRequests.length === 0 ? (
            <div className="well" style={{ padding: 16, textAlign: 'center' }}>
              <span className="fine">nobody needs a card right now</span>
            </div>
          ) : (
            openRequests.map((f) => (
              <LendRequest
                key={f.id}
                item={f}
                isMine={f.address === address}
                canLend={!busy}
                onLend={() => { click(); void doLend(f.id!); }}
              />
            ))
          )}
          {!myOpen && (
            <button
              onClick={() => { click(); setAsking(true); }}
              className="btn-3d"
              style={{
                minHeight: 46, borderRadius: 9, background: 'var(--recess)',
                border: '2px solid var(--ink)', boxShadow: 'var(--bevel-in)',
                fontFamily: 'var(--font-display)', fontSize: 14, color: 'var(--text)',
                WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
              }}
            >
              Ask for a card
            </button>
          )}
        </div>
      </section>

      {/* roster */}
      <section aria-label="Clan members">
        <div className="label" style={{ marginBottom: 6 }}>
          Roster · {mine.memberCount}/{mine.memberCap}
        </div>
        <div className="panel" style={{ padding: '3px 5px' }}>
          {mine.members.map((m, i) => (
            <div
              key={m.address}
              style={{ borderTop: i === 0 ? 'none' : '2px solid rgba(0,0,0,.26)' }}
            >
              <MemberRow
                member={m}
                rank={i + 1}
                isMe={m.address === address}
                onTap={canManage && m.address !== address ? () => { /* management sheet */ } : undefined}
              />
            </div>
          ))}
        </div>
      </section>

      {asking && (
        <AskSheet
          onClose={() => setAsking(false)}
          onAsk={async (arch) => {
            const err = await requestCard(address, arch);
            setLocalError(err);
            if (!err) setAsking(false);
          }}
        />
      )}

      {confirmLeave ? (
        <div className="panel" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
          <p style={{ fontSize: 14, textAlign: 'center', color: 'var(--dim-on-wood)' }}>
            {role === 'leader' && mine.memberCount > 1
              ? 'Leave? The top-ranked member becomes leader.'
              : mine.memberCount === 1
                ? 'You are the last member — leaving disbands the clan.'
                : 'Leave this clan? Your crowns stay with it.'}
          </p>
          <Pill danger disabled={busy} onClick={() => { void leave(address); }}>
            {mine.memberCount === 1 ? 'Disband clan' : 'Leave clan'}
          </Pill>
          <Pill ghost onClick={() => setConfirmLeave(false)}>Stay</Pill>
        </div>
      ) : (
        <button
          onClick={() => { click(); setConfirmLeave(true); }}
          style={{
            minHeight: 44, fontSize: 13, fontWeight: 700,
            color: 'var(--red-on-wood)', textDecoration: 'underline',
          }}
        >
          Leave clan
        </button>
      )}

      <p className="fine" style={{ fontSize: 12, textAlign: 'center' }}>
        Lending is a favour the clan counts, not an onchain transfer — a card is
        an account you own, and nothing here moves it.
      </p>
    </div>
  );
}

/** Pick the role your deck is missing. A request names a role, not a coin. */
function AskSheet({ onClose, onAsk }: { onClose: () => void; onAsk: (a: number) => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 55, display: 'flex', justifyContent: 'center' }}>
      <div aria-hidden onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)' }} />
      <div role="dialog" aria-modal="true" aria-label="Ask for a card" className="panel sheet" style={{ gap: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 className="display" style={{ fontSize: 22 }}>Ask for a card</h2>
          <button onClick={onClose} aria-label="Close" className="icon-btn" style={{ marginLeft: 'auto', fontSize: 26, width: 44, height: 44, color: 'var(--dim-on-wood)' }}>×</button>
        </div>
        <p className="fine" style={{ color: 'var(--dim-on-wood)', marginTop: -4 }}>
          Pick the role your deck is short of. One open request at a time.
        </p>
        {ARCHETYPE_NAMES.map((label, i) => (
          <button
            key={label}
            onClick={() => onAsk(i)}
            className="btn-3d well"
            style={{
              display: 'flex', alignItems: 'center', gap: 10, minHeight: 52,
              padding: '8px 12px', textAlign: 'left',
            }}
          >
            <ArchetypeIcon archetype={i as Archetype} size={20} />
            <span className="display display--sm" style={{ fontSize: 15, flex: 1 }}>{label}</span>
            <span className="label" style={{ fontSize: 12 }}>
              {ARCHETYPES[i as Archetype].elixir} elixir
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── the screen ─────────────────────────────────────────────────────────────
export function Clan() {
  const connected = useWallet((s) => s.connected);
  const address = useWallet((s) => s.address);
  const openPicker = useWallet((s) => s.openPicker);
  const { mine, loadMine, clear } = useClan();
  /*
   * Founding no longer owes anything.
   *
   * This used to hold "the clan just founded whose charter has not been paid
   * yet", and render a till for it after the fact. The server now refuses to
   * found a clan without the signature of a payment it can see on chain, so by
   * the time this switch flips the charter is already paid — there is nothing
   * left to collect, and nothing to undo by quietly calling `leave` if the
   * player declines.
   */

  useEffect(() => {
    if (connected && address) void loadMine(address);
    else clear();
  }, [connected, address, loadMine, clear]);

  if (!connected) {
    return (
      <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <header>
          <h1 className="display" style={{ fontSize: 30 }}>Clan</h1>
        </header>
        <div className="panel" style={{ padding: '22px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
          <img src="/art/clan_badge.webp" alt="" aria-hidden width={72} height={72} draggable={false} style={{ display: 'block' }} />
          <span style={{ color: 'var(--dim-on-wood)', fontSize: 14, maxWidth: 260 }}>
            Clans pool crowns and lend cards. Connect a wallet to found one or join.
          </span>
          <div style={{ width: 'min(100%, 240px)' }}>
            <Pill onClick={openPicker}>Connect Wallet</Pill>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <div>
          <h1 className="display" style={{ fontSize: 30 }}>Clan</h1>
          <p className="fine">
            {mine ? `${mine.memberCount} strong` : 'find your people'}
          </p>
        </div>
        <img
          src="/art/clan_badge.webp"
          alt=""
          aria-hidden
          width={44}
          height={44}
          draggable={false}
          style={{ display: 'block', marginLeft: 'auto' }}
        />
      </header>

      {mine ? <Home /> : <Browse onFounded={() => play('reward')} />}
    </div>
  );
}
