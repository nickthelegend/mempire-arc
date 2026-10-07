import type { CSSProperties } from 'react';
import { ClanCrest } from './ClanCrest';
import { ArchetypeIcon } from './ui';
import { ROLE_LABEL, type ClanMember, type ClanSummary } from '../state/clan';
import { shortAddr } from '../lib/format';
import type { Archetype } from '../sim/types';

/**
 * The small pieces the clan screens share.
 *
 * Kept together because they are only meaningful next to each other — a roster
 * row and a search row are the same grammar (crest, identity, two counts) at two
 * densities, and splitting them into separate files would hide that.
 */

/** Crowns count. Never gold: crowns are standing, and gold means SOL is moving. */
export function CrownCount({ n, size = 13 }: { n: number; size?: number }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontFamily: 'var(--font-display)', fontSize: size,
        color: 'var(--blue-pale)', whiteSpace: 'nowrap',
        WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
      }}
    >
      <span aria-hidden style={{ fontSize: size - 1, color: 'var(--gold)', WebkitTextStroke: '0' }}>♛</span>
      {n.toLocaleString()}
    </span>
  );
}

/** Members X/50. Turns red as the clan fills so a full clan reads before the tap. */
export function MemberCount({ count, cap }: { count: number; cap: number }) {
  const full = count >= cap;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontFamily: 'var(--font-display)', fontSize: 13,
        color: full ? 'var(--red-on-wood)' : 'var(--dim-on-wood)',
        whiteSpace: 'nowrap',
        WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
      }}
    >
      <span aria-hidden style={{ WebkitTextStroke: '0', fontSize: 12 }}>👥</span>
      {count}/{cap}
    </span>
  );
}

/** Position badge — gold, silver, bronze, then plain. */
export function RankChip({ rank }: { rank: number }) {
  const metal = [
    { face: 'linear-gradient(180deg,#ffe38a,#e0a913)', ink: '#4a3200' },
    { face: 'linear-gradient(180deg,#eef3fb,#a8b6cc)', ink: '#2b3444' },
    { face: 'linear-gradient(180deg,#e8b98a,#b3763c)', ink: '#43260c' },
  ][rank - 1];

  return (
    <span
      aria-hidden
      style={{
        width: 24, height: 24, borderRadius: 7, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: metal?.face ?? 'var(--recess)',
        border: '2px solid var(--ink)',
        boxShadow: metal
          ? 'inset 0 1px 0 rgba(255,255,255,.5)'
          : 'var(--bevel-in)',
        fontFamily: 'var(--font-display)', fontSize: 12,
        color: metal?.ink ?? 'var(--dim-on-wood)',
      }}
    >
      {rank}
    </span>
  );
}

/** One clan in the search list. Crest, identity, and the two numbers that decide. */
export function ClanRow({ clan, onClick }: { clan: ClanSummary; onClick: () => void }) {
  const full = clan.memberCount >= clan.memberCap;
  return (
    <button
      onClick={onClick}
      className="btn-3d well"
      aria-label={`${clan.name}, ${clan.memberCount} of ${clan.memberCap} members, ${clan.crowns} crowns`}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
        padding: '9px 11px', minHeight: 62, textAlign: 'left',
      }}
    >
      <ClanCrest crest={clan.crest} size={38} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          className="display display--sm"
          style={{
            display: 'block', fontSize: 15,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {clan.name}
        </span>
        <span
          className="fine"
          style={{
            display: 'block', fontSize: 12, color: 'var(--dim)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          <span className="mono">#{clan.tag}</span>
          {clan.requiredPower > 0 && ` · needs ${clan.requiredPower} power`}
          {clan.joinMode === 'closed' && ' · closed'}
        </span>
      </span>
      <span style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        gap: 3, flexShrink: 0,
      }}
      >
        <MemberCount count={clan.memberCount} cap={clan.memberCap} />
        <CrownCount n={clan.crowns} />
      </span>
      {full && (
        <span className="label" style={{ fontSize: 12, color: 'var(--red-on-wood)', flexShrink: 0 }}>
          full
        </span>
      )}
    </button>
  );
}

/** One member in the roster. Rank, identity, contribution, standing. */
export function MemberRow({
  member, rank, isMe, onTap,
}: { member: ClanMember; rank: number; isMe: boolean; onTap?: () => void }) {
  const inner = (
    <>
      <RankChip rank={rank} />
      <img
        src="/art/avatar_guest.webp"
        alt=""
        aria-hidden
        width={28}
        height={28}
        draggable={false}
        style={{ display: 'block', flexShrink: 0, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.5))' }}
      />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            display: 'block', fontSize: 13, fontWeight: 800,
            color: isMe ? 'var(--gold-hi)' : 'var(--text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {member.name ?? shortAddr(member.address)}
          {isMe && <span className="label" style={{ fontSize: 12, marginLeft: 5 }}>you</span>}
        </span>
        <span className="fine" style={{ display: 'block', fontSize: 12 }}>
          {ROLE_LABEL[member.role]}
        </span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
        <span
          title={`${member.lent} cards lent`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            fontSize: 12, fontWeight: 800, color: 'var(--dim)',
          }}
        >
          <span aria-hidden>🤝</span>
          {member.lent}
        </span>
        <CrownCount n={member.crowns} />
      </span>
    </>
  );

  const style: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 9, width: '100%',
    padding: '9px 10px', minHeight: 52, textAlign: 'left',
    borderRadius: 'var(--r-card)',
    background: isMe ? 'rgba(255,196,34,.12)' : 'transparent',
  };

  if (!onTap) return <div style={style}>{inner}</div>;
  return (
    <button className="menu-item" onClick={onTap} style={style} aria-label={`Manage ${member.name ?? member.address}`}>
      {inner}
    </button>
  );
}

const ARCH_NAMES = ['Tank', 'Swarm', 'Ranged', 'Splash', 'Support', 'Spell'];

/**
 * A lend request in the clan feed.
 *
 * The copy is careful on purpose: answering a request is a favour that is
 * *counted*, not an onchain transfer of the card. Cards are NFTs backed by staked
 * tokens and cannot be duplicated on request, so promising a transfer here would
 * be a lie the program cannot honour.
 */
export function LendRequest({
  item, isMine, canLend, onLend,
}: {
  item: { id?: string; address: string; archetype?: number; note?: string | null; filledBy?: string | null };
  isMine: boolean; canLend: boolean; onLend: () => void;
}) {
  const filled = Boolean(item.filledBy);
  return (
    <div
      className="well"
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px' }}
    >
      <ArchetypeIcon archetype={(item.archetype ?? 0) as Archetype} size={20} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 800 }}>
          {ARCH_NAMES[item.archetype ?? 0]} wanted
        </span>
        <span className="fine" style={{ display: 'block', fontSize: 12 }}>
          {isMine ? 'your request' : shortAddr(item.address)}
          {item.note ? ` · ${item.note}` : ''}
        </span>
      </span>
      {filled ? (
        <span className="label" style={{ fontSize: 12, color: 'var(--teal)', flexShrink: 0 }}>
          answered
        </span>
      ) : isMine ? (
        <span className="label" style={{ fontSize: 12, flexShrink: 0 }}>open</span>
      ) : (
        <button
          onClick={onLend}
          disabled={!canLend}
          className="btn-3d"
          style={{
            flexShrink: 0, minHeight: 44, padding: '0 13px', borderRadius: 9,
            background: canLend
              ? 'linear-gradient(180deg,var(--btn-green-hi),var(--btn-green))'
              : 'var(--recess)',
            border: '2px solid var(--ink)',
            boxShadow: canLend
              ? 'inset 0 2px 0 rgba(255,255,255,.4), 0 3px 0 var(--btn-green-dark)'
              : 'var(--bevel-in)',
            fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--text)',
            WebkitTextStroke: '1.8px var(--ink)', paintOrder: 'stroke fill',
            whiteSpace: 'nowrap',
          }}
        >
          Lend
        </button>
      )}
    </div>
  );
}
