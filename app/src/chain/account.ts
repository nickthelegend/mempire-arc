import {submitCall,recoverCall} from "./durable-call";
import {
  keccak256,BaseError, ContractFunctionRevertedError, createWalletClient, custom, encodeFunctionData, http,
  type Abi, type Account, type Address, type EIP1193Provider, type Hash, type Hex,
  type TransactionReceipt, type WalletClient,
} from 'viem';
import { CHAIN, CHAIN_ID, RPC_URL, publicClient } from './provider';

/*
 * Who is signing.
 *
 * Three kinds of signer, one interface:
 *
 *  - `passkey` — one WebAuthn ceremony derives a secp256k1 key from the
 *    authenticator's PRF output (lib/passkey.ts); it lives in a signing session
 *    in memory and nowhere else. Signing never prompts while the session is open.
 *  - `guest` — a key generated in this browser, for the "play in fifteen
 *    seconds" path on a device whose authenticator has no PRF. Testnet only.
 *  - `injected` — a browser wallet found through EIP-6963 (MetaMask, Rabby,
 *    Phantom, Backpack…). Every transaction is the wallet's own prompt.
 *
 * Everything that sends a transaction goes through `send` below, which is the
 * one place gas is sized: every limit is an estimate plus a small margin, and
 * fees are kept above Arc's 20 gwei mempool floor (below it a transaction is
 * dropped silently). Gas is paid in USDC from the same balance as stakes.
 */

export type SignerKind = 'passkey' | 'guest' | 'injected';

export interface Signer {
  kind: SignerKind;
  address: Address;
  /** A viem LocalAccount for passkey/guest; the bare address for injected wallets. */
  account: Account | Address;
  wallet: WalletClient;
  label: string;
  icon: string | null;
}

let current: Signer | null = null;
/** Told after every signature, so a passkey session stays open while it is in use. */
let afterSign: (() => void) | null = null;
export const onSigned = (fn: () => void): void => { afterSign = fn; };

export const activeSigner = (): Signer | null => current;
export const canSign = (): boolean => current !== null;

export function setSigner(s: Signer | null): void {
  current = s;
}

/** A signer for a viem LocalAccount — passkey sessions, guests, and match session keys. */
export function localSigner(kind: SignerKind, account: Account, label: string, icon: string | null = null): Signer {
  return {
    kind,
    address: account.address,
    account,
    wallet: createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) }),
    label,
    icon,
  };
}

/** A signer for an EIP-1193 browser wallet, switched (or added) to this chain first. */
export async function injectedSigner(provider: EIP1193Provider, label: string, icon: string | null): Promise<Signer> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' }) as Address[];
  if (!accounts?.length) throw new Error('the wallet returned no account');
  const hexId = `0x${CHAIN_ID.toString(16)}` as Hex;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
  } catch (e) {
    // 4902: the wallet has never heard of this chain. Offer it, then switch.
    if ((e as { code?: number })?.code !== 4902) throw e;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hexId,
        chainName: CHAIN.name,
        nativeCurrency: CHAIN.nativeCurrency,
        rpcUrls: [RPC_URL],
        blockExplorerUrls: CHAIN.blockExplorers ? [CHAIN.blockExplorers.default.url] : undefined,
      }],
    });
  }
  return {
    kind: 'injected',
    address: accounts[0],
    account: accounts[0],
    wallet: createWalletClient({ account: accounts[0], chain: CHAIN, transport: custom(provider) }),
    label,
    icon,
  };
}

export class NoSignerError extends Error {
  constructor() {
    super('no signer — sign in with a passkey, play as guest, or connect a wallet');
  }
}

/** EIP-191 personal_sign over plain text, as the relay's auth expects. */
export async function signText(text: string, s: Signer | null = current): Promise<Hex> {
  if (!s) throw new NoSignerError();
  const sig = await s.wallet.signMessage({ account: s.account, message: text });
  if (s === current) afterSign?.();
  return sig;
}

export interface TxResult {
  hash: Hash;
  receipt: TransactionReceipt;
}

export interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

/** Margin over the estimate. */
const GAS_MARGIN_NUM = 120n;
const GAS_MARGIN_DEN = 100n;

/**
 * Simulate, size gas, send, and wait for the receipt.
 *
 * The simulation runs first so a call that would revert fails here with the
 * contract's own error name — rather than as an opaque wallet failure, or worse,
 * as a mined revert that still paid for its whole gas limit.
 */
export async function send(call: Call, s: Signer | null = current): Promise<TxResult> {
  if (!s) throw new NoSignerError();
  const client = publicClient();
  const from = s.address;
  await client.simulateContract({
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args as unknown[] | undefined,
    value: call.value,
    account: from,
  });
  const data = encodeFunctionData({
    abi: call.abi, functionName: call.functionName, args: call.args as unknown[] | undefined,
  });
  const gas = ((await client.estimateGas({ account: from, to: call.address, data, value: call.value })) * GAS_MARGIN_NUM)
    / GAS_MARGIN_DEN;
  const fees=await arcFees();
  const receipt=await durableWalletSend(s,call.address,data,call.value??0n,gas,fees);
  if(s===current)afterSign?.();
  return {hash:receipt.transactionHash,receipt};
}

/** Arc drops anything under a 20 gwei maxFeePerGas without a receipt; never go below 2× that. */
const MIN_MAX_FEE = 40_000_000_000n;
export async function arcFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | Record<string, never>> {
  try {
    const f = await publicClient().estimateFeesPerGas();
    const maxFeePerGas = f.maxFeePerGas > MIN_MAX_FEE ? f.maxFeePerGas : MIN_MAX_FEE;
    const tip = f.maxPriorityFeePerGas < maxFeePerGas ? f.maxPriorityFeePerGas : maxFeePerGas;
    return { maxFeePerGas, maxPriorityFeePerGas: tip };
  } catch {
    return {};
  }
}

/** A plain USDC transfer (native value), sized by estimate: Arc's native transfers are not always 21k. */
export async function sendValue(to: Address, value: bigint, s: Signer | null = current): Promise<TxResult> {
  if (!s) throw new NoSignerError();
  const gas = await publicClient().estimateGas({ account: s.address, to, value });
  const receipt=await durableWalletSend(s,to,'0x',value,gas,await arcFees());
  return {hash:receipt.transactionHash,receipt};
}

async function durableWalletSend(s:Signer,to:Address,data:Hex,value:bigint,gas:bigint,fees:{maxFeePerGas?:bigint;maxPriorityFeePerGas?:bigint}){
 const wasCurrent=s===current;
 const context=async()=>{const [addresses,id]=await Promise.all([s.wallet.getAddresses(),s.wallet.getChainId()]);if(id!==CHAIN_ID||!addresses.some(a=>a.toLowerCase()===s.address.toLowerCase())||(wasCurrent&&current!==s))throw Error('Original wallet or network changed. No transaction was requested.');};
 return submitCall(publicClient(),localStorage,{chainId:CHAIN_ID,from:s.address,to,dataHash:keccak256(data),value:value.toString(),gas:gas.toString(),maxFeePerGas:fees.maxFeePerGas?.toString(),maxPriorityFeePerGas:fees.maxPriorityFeePerGas?.toString()},context,nonce=>s.wallet.sendTransaction({account:s.account,chain:CHAIN,to,data,value,gas,nonce,...fees}));
}
/** Read-only recovery of the original owner call, never a retry or signature. */
export async function recoverOriginalTransaction(s:Signer|null=current){if(!s)throw new NoSignerError();return recoverCall(publicClient(),localStorage,CHAIN_ID,s.address);}

/** Contract error names, said the way a player needs to hear them. */
const REASONS: Record<string, string> = {
  CardLocked: 'one of those cards is still in a live match',
  NotOwner: 'that card is not yours',
  DuplicateCoin: 'a deck can hold only one card per fighter',
  BadDeck: 'a deck needs exactly eight cards',
  SameCard: 'a card cannot merge into itself',
  DifferentCoins: 'only two cards of the same fighter can merge',
  MaxLevel: 'that card is already level 10',
  WrongPayment: 'the payment did not match the price',
  Paused: 'new matches are paused right now — open matches still settle',
  TierClosed: 'that stake tier is not open on this network yet',
  CoinInactive: 'that fighter is not being minted right now',
  UnknownCoin: 'that fighter is not on the roster',
  StarterTaken: 'this account already has its starter deck',
  BadChest: 'that chest is not in a state to do that',
  ChestNotReady: 'that chest is still unlocking',
  AnotherChestUnlocking: 'another chest is already unlocking',
  TooEarly: 'too early — wait a moment and try again',
  BadStake: 'that stake is not one of the fixed tiers',
  BadSessionGas: 'the session key gas allowance is out of range',
  BadState: 'that match is not in a state to do that',
  NotASeat: 'you are not seated in that match',
  SelfMatch: 'you cannot play against yourself',
  PowerMismatch: 'the two decks are too far apart in power',
  AlreadyClaimed: 'this seat has already recorded its result',
  TooLate: 'the match deadline has passed',
  BadTick: 'that play is out of order',
  TooManyPlays: 'this seat has played its maximum',
  NothingOwed: 'nothing is owed to this account',
  ERC20InsufficientBalance: 'not enough tokens for that',
  ERC20InsufficientAllowance: 'the token allowance is too small',
  StalePrice: 'the price update was too old — try again',
  PriceFeedNotFound: 'no fresh price was posted for that fighter',
};

/** A sentence for the UI, never an empty string. */
export function readableChainError(e: unknown): string {
  if (e instanceof NoSignerError) return e.message;
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason ?? '';
      if (name && REASONS[name]) return REASONS[name];
      if (name) return name;
    }
    const msg = e.shortMessage || e.message;
    if (/insufficient funds/i.test(msg)) return 'not enough USDC for gas — add USDC (testnet: faucet.circle.com)';
    if (/blocklisted/i.test(msg)) return 'this address is blocklisted by USDC and cannot move funds';
    if (/rejected|denied/i.test(msg)) return 'you declined the request';
    return msg;
  }
  const s = e instanceof Error ? e.message : String(e ?? '');
  for (const [k, v] of Object.entries(REASONS)) if (s.includes(k)) return v;
  return s || 'the transaction failed for an unknown reason';
}
