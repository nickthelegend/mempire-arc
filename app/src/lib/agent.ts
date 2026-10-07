import { keccak256, toHex, type Abi, type Address } from 'viem';
import { apiFetch } from './api';
import { activeSigner, NoSignerError, send, type TxResult } from '../chain/account';

/*
 * ERC-8004: the AI opponent is a registered agent on Arc (IdentityRegistry),
 * and players rate it in the ReputationRegistry from their own accounts after
 * a match against it. See server/agent.js.
 */

export interface AgentInfo {
  registered: boolean;
  agentId?: string;
  owner?: string;
  raters?: number;
  summary?: { count: number; average: number | null };
  registries: { identity: Address; reputation: Address };
  tag: string;
}

let cached: Promise<AgentInfo | null> | null = null;
export function agentInfo(fresh = false): Promise<AgentInfo | null> {
  if (fresh || !cached) {
    cached = apiFetch('/api/agent').then((r) => (r?.ok ? r.json() as Promise<AgentInfo> : null)).catch(() => null);
  }
  return cached;
}

const REPUTATION_ABI = [{
  type: 'function', name: 'giveFeedback', stateMutability: 'nonpayable',
  inputs: [
    { name: 'agentId', type: 'uint256' }, { name: 'value', type: 'int128' }, { name: 'valueDecimals', type: 'uint8' },
    { name: 'tag1', type: 'string' }, { name: 'tag2', type: 'string' }, { name: 'endpoint', type: 'string' },
    { name: 'feedbackURI', type: 'string' }, { name: 'feedbackHash', type: 'bytes32' },
  ],
  outputs: [],
}] as const satisfies Abi;

/**
 * Rate the AI opponent 0–100 after a match against it. One transaction from
 * the player's own account (a passkey session signs it without a prompt), so
 * the agent's score is only ever what players said.
 */
export async function rateAgent(info: AgentInfo, score: number, aiWon: boolean, matchRef: string): Promise<TxResult> {
  if (!activeSigner()) throw new NoSignerError();
  if (!info.registered || !info.agentId) throw new Error('the AI opponent is not registered on this network');
  return send({
    address: info.registries.reputation,
    abi: REPUTATION_ABI as unknown as Abi,
    functionName: 'giveFeedback',
    args: [BigInt(info.agentId), BigInt(Math.max(0, Math.min(100, Math.round(score)))), 0, info.tag, aiWon ? 'ai-won' : 'player-won', '', '', keccak256(toHex(matchRef))],
  });
}
