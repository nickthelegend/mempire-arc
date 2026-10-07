/**
 * ERC-8004: the AI opponent as an on-chain agent with a public track record.
 *
 * Mempire's AI opponent ("vs Kimi": a Kimi-planned bot, see ai.js) is a
 * service the relay operates. On Arc it is registered in the ERC-8004
 * IdentityRegistry (an ERC-721 agent id whose URI is the agent card served
 * below), and players rate it in the ReputationRegistry after a match — from
 * their own passkey accounts, tagged "mempire.match" and "ai-won"/"player-won".
 * The operator can't rate its own agent (ERC-8004 forbids self-feedback), so
 * the score is only ever what players said.
 *
 * Registration is a one-off the operator runs (scripts/register-agent.mjs);
 * the agent id then goes in AI_AGENT_ID. Without it this route says so and the
 * app hides the rating buttons.
 */
import { ARC_TESTNET, CHAIN_ID, publicClient } from './chain.js';

export const ERC8004 = CHAIN_ID === ARC_TESTNET
  ? { identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e', reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713' }
  : { identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' };

const AGENT_ID = process.env.AI_AGENT_ID ? BigInt(process.env.AI_AGENT_ID) : null;
const PUBLIC_URL = (process.env.PUBLIC_API_URL || process.env.PUBLIC_APP_URL || 'https://mempire.fun').replace(/\/+$/, '');
export const TAG = 'mempire.match';

const IDENTITY_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'string' }] },
];
const REPUTATION_ABI = [
  { type: 'function', name: 'getClients', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address[]' }] },
  {
    type: 'function', name: 'getSummary', stateMutability: 'view',
    inputs: [{ type: 'uint256' }, { type: 'address[]' }, { type: 'string' }, { type: 'string' }],
    outputs: [{ type: 'uint64', name: 'count' }, { type: 'int128', name: 'summaryValue' }, { type: 'uint8', name: 'decimals' }],
  },
];

/** The ERC-8004 agent card (registration file) the identity's URI points at. */
export function agentCard() {
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Mempire AI opponent',
    description: 'Plays Mempire, the real-time card battler where the market is the meta, against human players on Arc. Strategy planned by Kimi (Moonshot) through tool calls; moves are validated by the same deterministic simulation as a human\'s.',
    image: `${PUBLIC_URL}/art/avatar_guest.png`,
    services: [{ name: 'web', endpoint: `${PUBLIC_URL}/api/ai/plan` }],
    registrations: AGENT_ID === null ? [] : [{ agentId: Number(AGENT_ID), agentRegistry: `eip155:${CHAIN_ID}:${ERC8004.identity}` }],
    supportedTrust: ['reputation'],
  };
}

export function registerAgentRoutes(app, gate) {
  const pass = (_req, _res, next) => next();

  app.get('/agents/mempire-ai.json', (_req, res) => res.json(agentCard()));

  app.get('/api/agent', gate ?? pass, async (_req, res) => {
    if (AGENT_ID === null) {
      return res.json({ registered: false, missing: 'AI_AGENT_ID', registries: ERC8004, tag: TAG });
    }
    try {
      const client = publicClient();
      const [owner, uri, clients] = await Promise.all([
        client.readContract({ address: ERC8004.identity, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [AGENT_ID] }),
        client.readContract({ address: ERC8004.identity, abi: IDENTITY_ABI, functionName: 'tokenURI', args: [AGENT_ID] }),
        client.readContract({ address: ERC8004.reputation, abi: REPUTATION_ABI, functionName: 'getClients', args: [AGENT_ID] }),
      ]);
      // getSummary takes an explicit rater list (ERC-8004's sybil guard) and the
      // deployed registry reverts on long lists, so the latest 50 raters are
      // summarised five at a time and combined (count-weighted average).
      let count = 0;
      let weighted = 0;
      const recent = clients.slice(-50);
      for (let i = 0; i < recent.length; i += 5) {
        try {
          const [n, value, decimals] = await client.readContract({
            address: ERC8004.reputation, abi: REPUTATION_ABI, functionName: 'getSummary', args: [AGENT_ID, recent.slice(i, i + 5), TAG, ''],
          });
          count += Number(n);
          weighted += Number(n) * (Number(value) / 10 ** Number(decimals));
        } catch { /* a batch the registry refuses is skipped, not invented */ }
      }
      const summary = { count, average: count ? weighted / count : null, over: recent.length };
      res.json({ registered: true, agentId: AGENT_ID.toString(), owner, uri, raters: clients.length, summary, registries: ERC8004, tag: TAG });
    } catch (e) {
      res.status(502).json({ error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160) });
    }
  });
}
