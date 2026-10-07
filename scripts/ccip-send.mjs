#!/usr/bin/env node
/**
 * USER-RUN, TESTNET ONLY: open a $1 Mempire match on Arc testnet from Base Sepolia
 * (or Ethereum Sepolia) — CCTP V2 moves the dollar, Chainlink CCIP carries the instruction.
 *
 *   PLAYER_PRIVATE_KEY=0x… node scripts/ccip-send.mjs [base-sepolia|sepolia] [--bridge 1.00]
 *
 * The player key needs: a starter deck on Arc testnet (onboard it in the app once), Sepolia ETH
 * on the source chain for gas + the CCIP fee, and USDC there to bridge (faucet.circle.com). The
 * key is read from the environment and never printed. Refuses any mainnet: live sends on
 * mainnet are never part of this repo's tooling. Prints the CCIP message and an Explorer link;
 * the relay's ccip-watch completes the match once the CCTP transfer has minted on Arc.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { createPublicClient, createWalletClient, decodeEventLog, erc20Abi, http, parseSignature, parseUnits } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia, sepolia } = require('viem/chains');

const SRC = { 'base-sepolia': { chain: baseSepolia, usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }, sepolia: { chain: sepolia, usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' } };
const name = process.argv[2] ?? 'base-sepolia';
if (!SRC[name]) { console.error('source must be base-sepolia or sepolia (testnet only)'); process.exit(1); }
const bridge = parseUnits(process.argv.includes('--bridge') ? process.argv[process.argv.indexOf('--bridge') + 1] : '1.00', 6);
const key = process.env.PLAYER_PRIVATE_KEY;
if (!key) { console.error('set PLAYER_PRIVATE_KEY'); process.exit(1); }
const entry = process.env.REMOTE_ENTRY ?? process.env[`VITE_REMOTE_ENTRY_${name === 'sepolia' ? 'ETHEREUM' : 'BASE'}`];
if (!entry) { console.error('set REMOTE_ENTRY (from scripts/deploy-remote.sh)'); process.exit(1); }

const dep = JSON.parse(readFileSync(new URL('../shared/deployments/5042002.json', import.meta.url), 'utf8'));
const abi = (n) => JSON.parse(readFileSync(new URL(`../shared/abi/${n}.json`, import.meta.url), 'utf8'));
const me = privateKeyToAccount(key);
const arc = createPublicClient({ transport: http('https://rpc.testnet.arc.io') });
const [ids, data, locked] = await arc.readContract({ address: dep.cards, abi: abi('MempireCards'), functionName: 'cardsOf', args: [me.address] });
const seen = new Set();
const deck = ids.filter((_, i) => !locked[i] && !seen.has(data[i].coinId) && seen.add(data[i].coinId)).slice(0, 8);
if (deck.length < 8) { console.error('this key has fewer than eight free cards on Arc testnet — onboard it in the app first'); process.exit(1); }
const stake = await arc.readContract({ address: dep.arena, abi: abi('MempireArena'), functionName: 'stakeFor', args: [0] });
const nonce = await arc.readContract({ address: '0x3600000000000000000000000000000000000000', abi: [{ type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'nonces', args: [me.address] });
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const sig = await me.signTypedData({
  domain: { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: '0x3600000000000000000000000000000000000000' },
  types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Permit', message: { owner: me.address, spender: dep.arena, value: stake, nonce, deadline },
});
const { r, s, v, yParity } = parseSignature(sig);
const order = { matchId: 0n, tier: 0, cardIds: deck, session: '0x0000000000000000000000000000000000000000', permitDeadline: deadline, v: Number(v ?? BigInt(yParity + 27)), r, s };

const { chain, usdc } = SRC[name];
const src = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account: me, chain, transport: http() });
const remoteAbi = abi('MempireRemoteEntry');
const fee = await src.readContract({ address: entry, abi: remoteAbi, functionName: 'quoteEnter', args: [order] });
console.log(`CCIP fee ${Number(fee) / 1e18} ETH · bridging ${Number(bridge) / 1e6} USDC from ${name} to ${me.address} on Arc testnet`);
const allowance = await src.readContract({ address: usdc, abi: erc20Abi, functionName: 'allowance', args: [me.address, entry] });
if (allowance < bridge) await src.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdc, abi: erc20Abi, functionName: 'approve', args: [entry, bridge] }) });
const hash = await wallet.writeContract({ address: entry, abi: remoteAbi, functionName: 'enter', args: [order, bridge, bridge / 200n], value: (fee * 11n) / 10n });
const rc = await src.waitForTransactionReceipt({ hash });
const ev = rc.logs.map((l) => { try { return decodeEventLog({ abi: remoteAbi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === 'EnterSent');
console.log(`source tx  ${hash}`);
console.log(`messageId  ${ev?.args.messageId}`);
console.log(`track it   https://ccip.chain.link/msg/${ev?.args.messageId}`);
