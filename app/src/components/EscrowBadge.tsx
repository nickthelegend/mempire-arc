import { useEscrow, type EscrowPhase } from '../state/escrow';
import { useChain } from '../state/chain';
import { fmtStake } from '../lib/format';

/**
 * Where this match's money actually is.
 *
 * The whole reason this component exists: the Arena shows a stake tier, and
 * until the escrow was wired that number moved nothing. A player looking at
 * "POT 0.1 SOL" had no way to tell whether the chain had taken anything, and
 * the honest answer varied by match — a Guest stakes nothing, a wallet with an
 * un-minted deck stakes nothing, and a fully-minted ranked match stakes for
 * real.
 *
 * So the badge names the state instead of implying one. `failed` is not hidden
 * and not styled as an error: playing for the ladder is a legitimate outcome,
 * it just is not the same outcome as playing for a pot.
 */
const LOOK: Record<EscrowPhase, { dot: string; text: string; title: string }> = {
  none: { dot: 'var(--dim)', text: 'no stake', title: 'This match is for the ladder only' },
  opening: { dot: 'var(--gold)', text: 'staking…', title: 'Escrowing your stake onchain' },
  waiting: { dot: 'var(--gold)', text: 'stake in', title: 'Your stake is escrowed; waiting for your opponent' },
  joining: { dot: 'var(--gold)', text: 'matching…', title: 'Matching your opponent’s stake' },
  live: { dot: 'var(--teal)', text: 'pot live', title: 'Both stakes are escrowed onchain' },
  claiming: { dot: 'var(--gold)', text: 'reporting…', title: 'Recording this seat\u2019s result on Monad' },
  claimed: { dot: 'var(--gold)', text: 'reported', title: 'Your result is recorded; waiting for your opponent’s' },
  settled: { dot: 'var(--teal)', text: 'paid', title: 'The pot has been paid out onchain' },
  refunded: { dot: 'var(--teal)', text: 'refunded', title: 'Your stake came back' },
  failed: { dot: 'var(--dim)', text: 'ladder only', title: 'Nothing was staked — this match counts for rating only' },
};

export function EscrowBadge({ compact = false }: { compact?: boolean }) {
  const phase = useEscrow((s) => s.phase);
  const stake = useEscrow((s) => s.stake);
  const currency = useEscrow((s) => s.currency);
  const lastError = useEscrow((s) => s.lastError);
  const lastSignature = useEscrow((s) => s.lastSignature);
  const explorer = useChain((s) => s.explorer);

  const look = LOOK[phase];
  const staked = stake > 0 && ['waiting', 'live', 'claiming', 'claimed', 'settled'].includes(phase);
  const title = lastError ? `${look.title} — ${lastError}` : look.title;

  const body = (
    <>
      <span
        aria-hidden
        style={{
          width: 7, height: 7, borderRadius: '50%', background: look.dot, flexShrink: 0,
          boxShadow: `0 0 7px ${look.dot}`,
        }}
      />
      <span className="label" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
        {look.text}
        {staked && !compact && ` · ${fmtStake(stake, currency)}`}
      </span>
    </>
  );

  const style: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '3px 9px', borderRadius: 999,
    background: 'rgba(0,0,0,.34)', border: '1px solid var(--border)',
    color: 'var(--text)', textDecoration: 'none',
  };

  // A settled pot links to the transaction that paid it — the claim is
  // checkable rather than asserted.
  if (lastSignature && (phase === 'settled' || phase === 'refunded')) {
    return (
      <a
        href={explorer(lastSignature)}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        style={style}
      >
        {body}
      </a>
    );
  }

  return <span title={title} style={style}>{body}</span>;
}
