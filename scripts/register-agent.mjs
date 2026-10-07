#!/usr/bin/env node
/**
 * USER-RUN, once per network: register Mempire's AI opponent as an ERC-8004 agent on Arc.
 *
 *   node scripts/register-agent.mjs testnet|mainnet
 *
 * Reads AGENT_OWNER_PRIVATE_KEY from server/.env.local (scripts/testnet-setup.sh makes it) or the
 * environment — never the deployer, never the relayer — and PUBLIC_API_URL for the agent card URI
 * (<relay>/agents/mempire-ai.json). Prints the agent id: set AI_AGENT_ID to it on the relay.
 * Mainnet needs CONFIRM_MAINNET=yes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, parseEventLogs } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const net = process.argv[2] ?? 'testnet';
const NETS = {
  testnet: { id: 5042002, rpc: 'https://rpc.testnet.arc.io', identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e' },
  mainnet: { id: 5042, rpc: 'https://rpc.mainnet.arc.io', identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' },
};
const n = NETS[net];
if (!n) { console.error('usage: node scripts/register-agent.mjs testnet|mainnet'); process.exit(1); }
if (net === 'mainnet' && process.env.CONFIRM_MAINNET !== 'yes') { console.error('mainnet: re-run with CONFIRM_MAINNET=yes'); process.exit(1); }
const local = new URL('../server/.env.local', import.meta.url);
const env = existsSync(local) ? Object.fromEntries(readFileSync(local, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) : {};
const key = process.env.AGENT_OWNER_PRIVATE_KEY ?? env.AGENT_OWNER_PRIVATE_KEY;
const api = (process.env.PUBLIC_API_URL ?? env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
if (!key) { console.error('no AGENT_OWNER_PRIVATE_KEY (run scripts/testnet-setup.sh)'); process.exit(1); }
if (!/^https:\/\//.test(api)) { console.error('set PUBLIC_API_URL to the hosted relay (https://…), which serves the agent card'); process.exit(1); }
const chain = { id: n.id, name: `Arc ${net}`, nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [n.rpc] } } };
const account = privateKeyToAccount(key);
const abi = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ type: 'string', name: 'agentURI' }], outputs: [{ type: 'uint256' }] },
  { type: 'event', name: 'Transfer', inputs: [{ type: 'address', name: 'from', indexed: true }, { type: 'address', name: 'to', indexed: true }, { type: 'uint256', name: 'tokenId', indexed: true }] },
];
const pub = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account, chain, transport: http() });
const hash = await wallet.writeContract({ address: n.identity, abi, functionName: 'register', args: [`${api}/agents/mempire-ai.json`] });
const rc = await pub.waitForTransactionReceipt({ hash });
const [t] = parseEventLogs({ abi, eventName: 'Transfer', logs: rc.logs });
console.log(`registered: agent #${t.args.tokenId} owned by ${account.address} (tx ${hash})`);
console.log(`set on the relay: AI_AGENT_ID=${t.args.tokenId}`);
