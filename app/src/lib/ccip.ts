import {
  createPublicClient, createWalletClient, erc20Abi, http, parseSignature,
  type Abi, type Address, type Chain, type Hex, type LocalAccount,
} from 'viem';
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains';
import remoteAbiJson from '../shared/abi/MempireRemoteEntry.json';
import { CHAIN_ID, DEPLOYMENT, IS_MAINNET, USDC, publicClient } from '../chain/provider';
import { ARENA_ABI } from '../chain/read';
import type { Signer } from '../chain/account';

/*
 * Play from Base or Ethereum: "CCTP moves the dollars, CCIP carries the
 * instruction".
 *
 * The passkey account has the same address on every EVM chain. From Base (or
 * Ethereum) one transaction to MempireRemoteEntry burns the player's USDC with
 * CCTP V2 Fast Transfer to that same address on Arc, and sends a Chainlink
 * CCIP message to MempireCCIPGateway on Arc saying "open a $1 match with these
 * cards" — the stake permit (Arc USDC, signed here) rides inside it. Whichever
 * lands first, the relay completes the instruction once the dollars are there.
 * The CCIP fee is paid in the source chain's native token.
 *
 * Remote entries are deployed per source chain (scripts/deploy-remote.sh) and
 * configured with VITE_REMOTE_ENTRY_BASE / VITE_REMOTE_ENTRY_ETHEREUM.
 */

const REMOTE_ABI = remoteAbiJson as Abi;

export interface RemoteChain {
  key: 'base' | 'ethereum';
  label: string;
  chain: Chain;
  entry: Address | null;
  usdc: Address;
  cctpDomain: number;
}

const env = (k: string): Address | null => {
  const v = (import.meta.env as Record<string, string | undefined>)[k];
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? v as Address : null;
};

export const REMOTE_CHAINS: RemoteChain[] = IS_MAINNET || CHAIN_ID === 31337
  ? [
    { key: 'base', label: 'Base', chain: base, entry: env('VITE_REMOTE_ENTRY_BASE'), usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', cctpDomain: 6 },
    { key: 'ethereum', label: 'Ethereum', chain: mainnet, entry: env('VITE_REMOTE_ENTRY_ETHEREUM'), usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', cctpDomain: 0 },
  ]
  : [
    { key: 'base', label: 'Base Sepolia', chain: baseSepolia, entry: env('VITE_REMOTE_ENTRY_BASE'), usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', cctpDomain: 6 },
    { key: 'ethereum', label: 'Ethereum Sepolia', chain: sepolia, entry: env('VITE_REMOTE_ENTRY_ETHEREUM'), usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', cctpDomain: 0 },
  ];

/** The source-chain balances that matter for a cross-chain entry. */
export async function remoteBalances(rc: RemoteChain, who: Address) {
  const c = createPublicClient({ chain: rc.chain, transport: http() });
  const [native, usdc] = await Promise.all([
    c.getBalance({ address: who }),
    c.readContract({ address: rc.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] }),
  ]);
  return { native, usdc };
}

/**
 * Open (matchId 0) or join a match on Arc from `rc`, bridging `bridgeUnits`
 * USDC with CCTP in the same source transaction. Signs the Arc stake permit
 * with the passkey account, approves the remote entry for the bridged USDC if
 * needed, quotes the CCIP fee and sends. Returns the source tx and CCIP message id.
 */
export async function enterFromRemote(
  s: Signer, rc: RemoteChain, opts: { matchId?: bigint; tier: number; cardIds: bigint[]; bridgeUnits: bigint },
): Promise<{ hash: Hex; explorer: string }> {
  if (!rc.entry) throw new Error(`no Mempire entry deployed on ${rc.label} yet`);
  if (!DEPLOYMENT) throw new Error('no arena on this network');
  const account = s.account as LocalAccount;
  if (typeof account === 'string') throw new Error('cross-chain entry needs the passkey (or guest) account');
  const arc = publicClient();
  const stake = await arc.readContract({ address: DEPLOYMENT.arena, abi: ARENA_ABI, functionName: 'stakeFor', args: [opts.tier] }) as bigint;
  const nonce = await arc.readContract({
    address: USDC, abi: [{ type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'nonces', args: [s.address],
  }) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const sig = await account.signTypedData({
    domain: { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC },
    types: { Permit: [
      { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ] },
    primaryType: 'Permit',
    message: { owner: s.address, spender: DEPLOYMENT.arena, value: stake, nonce, deadline },
  });
  const { r, s: ss, v, yParity } = parseSignature(sig);
  const order = {
    matchId: opts.matchId ?? 0n, tier: opts.tier, cardIds: opts.cardIds, session: '0x0000000000000000000000000000000000000000' as Address,
    permitDeadline: deadline, v: Number(v ?? BigInt(yParity + 27)), r, s: ss,
  };

  const src = createPublicClient({ chain: rc.chain, transport: http() });
  const wallet = createWalletClient({ account, chain: rc.chain, transport: http() });
  if (opts.bridgeUnits > 0n) {
    const allowance = await src.readContract({ address: rc.usdc, abi: erc20Abi, functionName: 'allowance', args: [s.address, rc.entry] });
    if (allowance < opts.bridgeUnits) {
      const h = await wallet.writeContract({ address: rc.usdc, abi: erc20Abi, functionName: 'approve', args: [rc.entry, opts.bridgeUnits] });
      await src.waitForTransactionReceipt({ hash: h });
    }
  }
  const fee = await src.readContract({ address: rc.entry, abi: REMOTE_ABI, functionName: 'quoteEnter', args: [order] }) as bigint;
  // Fast Transfer allowance: CCTP's fee is a few basis points; cap it at 0.5%.
  const cctpMaxFee = opts.bridgeUnits / 200n;
  const hash = await wallet.writeContract({
    address: rc.entry, abi: REMOTE_ABI, functionName: 'enter', args: [order, opts.bridgeUnits, cctpMaxFee], value: (fee * 11n) / 10n,
  });
  await src.waitForTransactionReceipt({ hash });
  return { hash, explorer: `https://ccip.chain.link/tx/${hash}` };
}
