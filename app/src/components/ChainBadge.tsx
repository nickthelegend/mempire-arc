import { useChain } from '../state/chain';

/**
 * Says which reality the player is in.
 *
 * This exists because the app has three honest states and it would be very easy
 * — and dishonest — to let all three look like the same one. A judge tapping
 * "Mint" deserves to know whether that spends real testnet MON, and a Guest
 * deserves to know their pot is a number in memory.
 *
 * `live` links to the deployed program on the explorer, so the claim is
 * checkable rather than asserted.
 */
export function ChainBadge({ compact }: { compact?: boolean }) {
  const mode = useChain((s) => s.mode);
  const cluster = useChain((s) => s.cluster);
  const config = useChain((s) => s.config);
  const explorer = useChain((s) => s.explorer);
  const init = useChain((s) => s.init);
  const loading = useChain((s) => s.loading);

  const look = {
    onchain: { dot: 'var(--teal)', text: `live · ${cluster}`, title: 'Transactions are real' },
    simulated: { dot: 'var(--gold)', text: 'simulated', title: 'Reads are real; writes are local' },
    offline: { dot: 'var(--red)', text: loading ? 'retrying…' : 'offline · retry', title: 'Cluster unreachable — tap to retry' },
  }[mode];

  const body = (
    <>
      <span
        aria-hidden
        style={{
          width: 7, height: 7, borderRadius: '50%', background: look.dot, flexShrink: 0,
          boxShadow: `0 0 7px ${look.dot}`,
        }}
      />
      <span className="label" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{look.text}</span>
    </>
  );

  const shell: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: compact ? '3px 8px' : '5px 10px',
    borderRadius: 999, background: 'var(--recess)',
    border: '2px solid var(--ink)', boxShadow: 'var(--bevel-in)',
    textDecoration: 'none', color: 'inherit',
  };

  // Only the live state has something to link to.
  if (mode === 'onchain' && config) {
    return (
      <a
        href={explorer(config.address, 'address')}
        target="_blank"
        rel="noopener noreferrer"
        title={`${look.title} — view the program config on the explorer`}
        style={{ ...shell, minHeight: compact ? undefined : 32 }}
      >
        {body}
      </a>
    );
  }

  // Offline is actionable: a dead RPC at boot must not be a permanent state
  // that only a full reload can leave.
  if (mode === 'offline') {
    return (
      <button
        onClick={() => { void init(); }}
        disabled={loading}
        title={look.title}
        style={{ ...shell, cursor: loading ? 'wait' : 'pointer' }}
      >
        {body}
      </button>
    );
  }

  return <span title={look.title} style={shell}>{body}</span>;
}
