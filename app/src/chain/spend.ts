import { erc20Abi, formatEther, parseEther, type Abi, type Address } from 'viem';
import { activeSigner, send } from './account';
import { DEPLOYMENT, publicClient } from './provider';
import { fetchConfig } from './read';

/*
 * $MEMPIRE sinks that are plain transfers to the treasury.
 *
 * Chest skips, chest purchases, merges and $MEMPIRE mints are contract calls
 * with their prices fixed in the contract (chain/actions.ts). What is left here
 * — shop offers, rerolls, a clan charter — has no on-chain object to attach
 * to, so it is an ordinary ERC-20 transfer to the treasury the arena names.
 * Anyone can read the treasury's token history and see exactly what the game
 * has taken.
 */

export const PRICES = {
  chestSkip: 25,
  chestBuy: 100,
  clanCharter: 250,
} as const;

/** Mirrors `MempireCards.MINT_FEE_MEMPIRE`. Display only — the contract decides. */
export const MINT_PRICE_MEMPIRE = 250;

export type SpendKind = keyof typeof PRICES;
export type SpendPrice = SpendKind | number;

export const priceOf = (p: SpendPrice): number => (typeof p === 'number' ? p : PRICES[p]);

export interface SpendCheck {
  balance: number;
  price: number;
  affordable: boolean;
  shortfall: number;
  blocker: string;
}

export async function mempireBalance(address: string): Promise<number> {
  if (!DEPLOYMENT) return 0;
  const raw = await publicClient().readContract({
    address: DEPLOYMENT.token, abi: erc20Abi, functionName: 'balanceOf', args: [address as Address],
  });
  return Number(formatEther(raw));
}

export async function checkSpend(_legacy: unknown, kind: SpendPrice, address: string | null): Promise<SpendCheck> {
  const price = priceOf(kind);
  const base: SpendCheck = { balance: 0, price, affordable: false, shortfall: price, blocker: '' };
  if (!activeSigner()) return { ...base, blocker: 'Sign in to spend $MEMPIRE.' };
  if (!address) return { ...base, blocker: 'No account signed in.' };
  try {
    const balance = Math.floor(await mempireBalance(address));
    const shortfall = Math.max(0, price - balance);
    return {
      balance, price, affordable: shortfall === 0, shortfall,
      blocker: shortfall === 0 ? ''
        : `You hold ${balance.toLocaleString()} $MEMPIRE and this costs ${price.toLocaleString()} — ${shortfall.toLocaleString()} short. Wins pay 50 each.`,
    };
  } catch {
    return { ...base, blocker: 'Could not read your $MEMPIRE balance.' };
  }
}

/** Pay `kind` in $MEMPIRE to the treasury. Returns the transaction hash. */
export async function spendMempire(_legacy: unknown, kind: SpendPrice, address: string): Promise<string> {
  const check = await checkSpend(null, kind, address);
  if (!check.affordable) throw new Error(check.blocker || 'Not enough $MEMPIRE.');
  const cfg = await fetchConfig();
  if (!cfg || !DEPLOYMENT) throw new Error('No Mempire deployment on this chain');
  const { hash } = await send({
    address: DEPLOYMENT.token,
    abi: erc20Abi as Abi,
    functionName: 'transfer',
    args: [cfg.treasury as Address, parseEther(String(priceOf(kind)))],
  });
  return hash;
}
