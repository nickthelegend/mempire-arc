import { maxUint256, pad, toHex, type Address, type Hex } from 'viem';
import { apiFetch } from './api';
import type { Signer } from '../chain/account';
import { IS_MAINNET } from '../chain/provider';

/*
 * Circle Gateway: the player's USDC on any chain, spendable on Arc in a second.
 *
 * The passkey account is an ordinary EOA, so it has the same address on Base,
 * Ethereum, Arbitrum and Arc. USDC the player deposits into Circle's
 * GatewayWallet on any of them becomes one unified balance. To stake, the app
 * signs a burn intent per source chain (EIP-712, domain "GatewayWallet" v1 —
 * no chain id, so one passkey signature works for every source) with the
 * player's own Arc address as the recipient; the relay gets Circle's
 * attestation and calls GatewayMinter.gatewayMint on Arc, paying that gas.
 * Nothing here is custodial: the intent names its own recipient and Circle
 * signs the attestation.
 */

export const GATEWAY_WALLET: Address = IS_MAINNET
  ? '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE'
  : '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
export const GATEWAY_MINTER: Address = IS_MAINNET
  ? '0x2222222d7164433c4C09B0b0D809a9b52C04C205'
  : '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B';

/** USDC per Gateway domain (mainnet / testnet). Arc's is the 0x3600… ERC-20 interface. */
const USDC_BY_DOMAIN: Record<number, Address> = IS_MAINNET
  ? {
    0: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    3: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    6: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    26: '0x3600000000000000000000000000000000000000',
  }
  : {
    0: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    3: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    6: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    26: '0x3600000000000000000000000000000000000000',
  };

export const ARC_DOMAIN = 26;

export const BURN_INTENT_TYPES = {
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
} as const;

const b32 = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });

export interface GatewayBalance { domain: number; chain: string; balance: string }

export async function gatewayBalances(address: string): Promise<{ total: string; balances: GatewayBalance[] } | null> {
  const res = await apiFetch(`/api/gateway/balances/${address}`);
  if (!res?.ok) return null;
  return res.json();
}

/**
 * Sign burn intents moving `amounts` (USDC base units, per source domain) from
 * the unified balance to the player's own address on Arc.
 */
export async function signTopUp(s: Signer, amounts: { domain: number; units: bigint }[], maxFee = 20_000n) {
  return Promise.all(amounts.map(async ({ domain, units }) => {
    const burnIntent = {
      maxBlockHeight: maxUint256,
      maxFee,
      spec: {
        version: 1,
        sourceDomain: domain,
        destinationDomain: ARC_DOMAIN,
        sourceContract: b32(GATEWAY_WALLET),
        destinationContract: b32(GATEWAY_MINTER),
        sourceToken: b32(USDC_BY_DOMAIN[domain]),
        destinationToken: b32(USDC_BY_DOMAIN[ARC_DOMAIN]),
        sourceDepositor: b32(s.address),
        destinationRecipient: b32(s.address),
        sourceSigner: b32(s.address),
        destinationCaller: pad('0x00', { size: 32 }),
        value: units,
        salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
        hookData: '0x' as Hex,
      },
    };
    const signature = await s.wallet.signTypedData({
      account: s.account, domain: { name: 'GatewayWallet', version: '1' }, types: BURN_INTENT_TYPES, primaryType: 'BurnIntent', message: burnIntent,
    });
    return { burnIntent, signature };
  }));
}

/** Hand the signed intents to the relay: Circle attests, the relay mints on Arc. Returns the mint tx. */
export async function topUpArc(requests: Awaited<ReturnType<typeof signTopUp>>): Promise<{ hash: Hex }> {
  const body = JSON.stringify({ requests }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const res = await apiFetch('/api/gateway/mint', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (!res) throw new Error('the relay is unreachable');
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error ?? `the relay answered ${res.status}`);
  return { hash: j.hash };
}
