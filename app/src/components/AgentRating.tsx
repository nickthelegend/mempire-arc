import { useEffect, useState } from 'react';
import { agentInfo, rateAgent, type AgentInfo } from '../lib/agent';
import { readableChainError } from '../chain/account';
import { explorerUrl } from '../chain/provider';

/**
 * After a match against the AI opponent: its ERC-8004 identity on Arc, its
 * score from players, and two buttons that write the player's own rating to the
 * ERC-8004 ReputationRegistry. Hidden when the agent is not registered.
 */
export function AgentRating({ aiWon, matchRef }: { aiWon: boolean; matchRef: string }) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState<string>('');
  useEffect(() => { void agentInfo().then(setInfo); }, []);
  if (!info?.registered) return null;

  const rate = async (score: number) => {
    setState('busy');
    try {
      const r = await rateAgent(info, score, aiWon, matchRef);
      setState('done');
      setMsg(r.hash);
      void agentInfo(true).then(setInfo);
    } catch (e) {
      setState('error');
      setMsg(readableChainError(e));
    }
  };

  return (
    <div className="well" style={{ padding: '10px 14px', display: 'grid', gap: 6, textAlign: 'left' }}>
      <span className="label" style={{ fontSize: 12 }}>
        AI opponent · ERC-8004 agent #{info.agentId}
        {info.summary?.count ? ` · ${info.summary.average?.toFixed(0)}/100 from ${info.summary.count} ratings` : ''}
      </span>
      {state === 'done' ? (
        <a className="fine" href={explorerUrl(msg)} target="_blank" rel="noreferrer" style={{ color: 'var(--teal)' }}>
          Rating recorded on Arc ↗
        </a>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          {[['👍 Good game', 100], ['👎 Not fun', 0]].map(([label, score]) => (
            <button key={String(score)} className="btn-3d" disabled={state === 'busy'} onClick={() => void rate(Number(score))}
              style={{ minHeight: 40, padding: '0 12px', borderRadius: 9, border: '2px solid var(--ink)', background: 'var(--recess)', fontWeight: 800 }}>
              {label}
            </button>
          ))}
        </div>
      )}
      {state === 'error' && <span className="fine" style={{ color: 'var(--red-on-wood)' }}>{msg}</span>}
    </div>
  );
}
