import {
  decodeEventLog, encodeFunctionData, erc20Abi, keccak256, maxUint256, parseSignature, toHex, type Abi, type Address, type Hash, type Hex,
} from 'viem';
import { track } from '../lib/track';
import {
  activeSigner, NoSignerError, readableChainError, send, type Call, type Signer, type TxResult,
} from './account';
import { CHAIN_ID, DEPLOYMENT, USDC, publicClient } from './provider';
import { ARENA_ABI, CARDS_ABI, fetchMatchById, type ChainMatch } from './read';

/*
 * Every transaction the game sends.
 *
 * All of them go through `send` (chain/account.ts), which simulates first, so a
 * call that would revert fails here with the contract's own reason and costs
 * nothing — a mined revert still pays its gas (in USDC, on Arc).
 */

export { NoSignerError, readableChainError };

/*
 * Arc's Memo predeploy (0x5294…e505, mainnet and testnet). Stakes and result
 * claims go through `Memo.memo(arena, call, memoId, memo)`: Arc's CallFrom
 * precompile keeps the player (or their session key) as msg.sender for the
 * arena, and the Memo event tags the USDC movement with the match id —
 * memoId = keccak256("mempire:match:<id>") — so any explorer, wallet or
 * accountant can reconcile a stake or a payout with the match it belongs to.
 * Memo needs an EOA caller; every Mempire signer is one. A chain without the
 * predeploy (none known) falls back to the plain call.
 */
const MEMO: Address = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
const MEMO_ABI = [{
  type: 'function', name: 'memo', stateMutability: 'nonpayable',
  inputs: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'memoId', type: 'bytes32' }, { name: 'memoData', type: 'bytes' }],
  outputs: [],
}] as const satisfies Abi;
let memoLive: boolean | null = null;
export const matchMemoId = (matchId: number | bigint): Hex => keccak256(toHex(`mempire:match:${matchId}`));

/** Send `call` wrapped in an Arc Memo tagged with the match. Value-less calls only (Memo forwards no value). */
async function sendTagged(call: Call, matchId: number | bigint, note: string, by?: Signer | null): Promise<TxResult> {
  memoLive ??= ((await publicClient().getCode({ address: MEMO }).catch(() => undefined)) ?? '0x') !== '0x';
  if (!memoLive || call.value) return send(call, by ?? activeSigner());
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args as unknown[] });
  return send({
    address: MEMO, abi: MEMO_ABI as unknown as Abi, functionName: 'memo',
    args: [call.address, data, matchMemoId(matchId), toHex(note)],
  }, by ?? activeSigner());
}
export type { TxResult };

const dep = () => {
  if (!DEPLOYMENT) throw new Error(`no Mempire deployment on chain ${CHAIN_ID} yet`);
  return DEPLOYMENT;
};

function eventArgs<T>(receipt: TxResult['receipt'], abi: Abi, name: string): T | null {
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === name) return ev.args as T;
    } catch { /* another contract's log */ }
  }
  return null;
}

/** Approve once, generously, so a merge or a chest skip is one transaction rather than two. */
export async function ensureAllowance(token: Address, spender: Address, amount: bigint): Promise<Hash | null> {
  const s = activeSigner();
  if (!s) throw new NoSignerError();
  const allowance = await publicClient().readContract({
    address: token, abi: erc20Abi, functionName: 'allowance', args: [s.address, spender],
  });
  if (allowance >= amount) return null;
  const { hash } = await send({ address: token, abi: erc20Abi as Abi, functionName: 'approve', args: [spender, maxUint256] });
  return hash;
}

// ──────────────────────────────────────────────────────────────── cards

export interface MintResult extends TxResult {
  cardId: number;
}

/**
 * Mint a fighter for USDC ($0.05) or for 250 $MEMPIRE. Either way the contract
 * reads the fighter's Chainlink Data Feed in the same transaction (fresh and
 * positive, or no card) and stamps the card with that answer.
 */
export async function mintCardTx(coinId: number, payWith: 'usdc' | 'mempire' = 'usdc'): Promise<MintResult> {
  const d = dep();
  let r: TxResult;
  if (payWith === 'mempire') {
    await ensureAllowance(d.token, d.cards, 250n * 10n ** 18n);
    r = await send({ address: d.cards, abi: CARDS_ABI, functionName: 'mintWithMempire', args: [coinId] });
  } else {
    const s = activeSigner();
    if (!s) throw new NoSignerError();
    const mintFee = await publicClient().readContract({ address: d.cards, abi: CARDS_ABI, functionName: 'mintFee' }) as bigint;
    // The USDC fee rides in the mint tx as an EIP-2612 permit: one transaction, no approve.
    const permit = await permitFor(s, d.cards, mintFee);
    r = await send({ address: d.cards, abi: CARDS_ABI, functionName: 'mint', args: [coinId, permit] });
  }
  const ev = eventArgs<{ cardId: bigint }>(r.receipt, CARDS_ABI, 'CardMinted');
  track('card.mint', { coinId, payWith });
  return { ...r, cardId: Number(ev?.cardId ?? 0) };
}

/** Merge `dupeId` into `keepId` for one level. Priced 100 × current level in $MEMPIRE. */
export async function upgradeCardTx(keepId: number, dupeId: number, level: number): Promise<TxResult> {
  const d = dep();
  await ensureAllowance(d.token, d.cards, upgradeCostWei(level));
  const r = await send({ address: d.cards, abi: CARDS_ABI, functionName: 'merge', args: [BigInt(keepId), BigInt(dupeId)] });
  track('card.merge', { keepId, level: level + 1 });
  return r;
}

export const upgradeCost = (level: number): number => 100 * level;
const upgradeCostWei = (level: number): bigint => BigInt(upgradeCost(level)) * 10n ** 18n;

// ──────────────────────────────────────────────────────────────── chests

export async function startUnlockTx(chestId: number): Promise<TxResult> {
  return send({ address: dep().cards, abi: CARDS_ABI, functionName: 'startUnlock', args: [BigInt(chestId)] });
}

export async function skipChestTx(chestId: number): Promise<TxResult> {
  const d = dep();
  await ensureAllowance(d.token, d.cards, 25n * 10n ** 18n);
  return send({ address: d.cards, abi: CARDS_ABI, functionName: 'skip', args: [BigInt(chestId)] });
}

export async function buyChestTx(): Promise<TxResult & { chestId: number }> {
  const d = dep();
  await ensureAllowance(d.token, d.cards, 100n * 10n ** 18n);
  const r = await send({ address: d.cards, abi: CARDS_ABI, functionName: 'buyChest' });
  const ev = eventArgs<{ chestId: bigint }>(r.receipt, CARDS_ABI, 'ChestGranted');
  return { ...r, chestId: Number(ev?.chestId ?? 0) };
}

export interface OpenedChest {
  seed: Hex;
  cardIds: number[];
  hashes: Hash[];
}

/**
 * Open a chest: commit to the next block, wait for it, then reveal.
 *
 * Two transactions, a block apart — under a second or two on Arc. The contents are
 * a function of a block hash that did not exist when the chest was committed,
 * and of the chest id, so the reveal is something anyone can re-derive.
 */
export async function openChestTx(chestId: number, favoredCoinIds: number[]): Promise<OpenedChest> {
  const d = dep();
  const client = publicClient();
  const chest = await client.readContract({
    address: d.cards, abi: CARDS_ABI, functionName: 'chests', args: [BigInt(chestId)],
  }) as readonly [Address, number, number, number, bigint];
  const hashes: Hash[] = [];
  let revealBlock = chest[4];
  if (Number(chest[2]) !== 3) {
    const r = await send({ address: d.cards, abi: CARDS_ABI, functionName: 'open', args: [BigInt(chestId)] });
    hashes.push(r.hash);
    const ev = eventArgs<{ revealBlock: bigint }>(r.receipt, CARDS_ABI, 'ChestOpening');
    revealBlock = ev?.revealBlock ?? r.receipt.blockNumber + 1n;
  }
  for (let i = 0; i < 40; i += 1) {
    if (await client.getBlockNumber() > revealBlock) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  const favored = favoredCoinIds.slice(0, 8);
  const r = await send({ address: d.cards, abi: CARDS_ABI, functionName: 'reveal', args: [BigInt(chestId), favored] });
  hashes.push(r.hash);
  const ev = eventArgs<{ seed: Hex; cardIds: bigint[] }>(r.receipt, CARDS_ABI, 'ChestOpened');
  if (!ev) {
    // The reveal block aged out and the chest re-committed; one more pass reveals it.
    return openChestTx(chestId, favoredCoinIds);
  }
  track('chest.open', { chestId, cards: ev.cardIds.length });
  return { seed: ev.seed, cardIds: ev.cardIds.map(Number), hashes };
}

// ──────────────────────────────────────────────────────────────── matches

/** The arena's one stake currency on Arc. */
export type Currency = 'USDC';

export async function stakeFor(tier: number): Promise<bigint> {
  return await publicClient().readContract({
    address: dep().arena, abi: ARENA_ABI, functionName: 'stakeFor', args: [tier],
  }) as bigint;
}

interface PermitArg { deadline: bigint; v: number; r: Hex; s: Hex }
const NO_PERMIT: PermitArg = { deadline: 0n, v: 0, r: `0x${'0'.repeat(64)}`, s: `0x${'0'.repeat(64)}` };

const NONCES_ABI = [
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address', name: 'o' }], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * An EIP-2612 permit for `spender` to pull `amount` of USDC.
 *
 * Signed, not sent: the permit rides inside the create/join/mint transaction,
 * so a dollar stake is one transaction rather than approve-then-stake. Arc's
 * USDC is Circle's FiatToken: EIP-712 domain name "USDC", version "2", this
 * chain's id. With enough allowance already, the permit is skipped.
 */
async function permitFor(s: Signer, spender: Address, amount: bigint): Promise<PermitArg> {
  if (amount === 0n) return NO_PERMIT;
  const client = publicClient();
  const allowance = await client.readContract({
    address: USDC, abi: erc20Abi, functionName: 'allowance', args: [s.address, spender],
  });
  if (allowance >= amount) return NO_PERMIT;
  const nonce = await client.readContract({ address: USDC, abi: NONCES_ABI, functionName: 'nonces', args: [s.address] });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const signature = await s.wallet.signTypedData({
    account: s.account,
    domain: { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner: s.address, spender, value: amount, nonce, deadline },
  });
  const { r, s: sig, v, yParity } = parseSignature(signature);
  return { deadline, v: Number(v ?? BigInt(yParity + 27)), r, s: sig };
}

/** Escrow a stake and open a match. Returns the id the chain assigned. */
export async function createMatchTx(
  tier: number, currency: Currency, cardIds: number[], session: Address, sessionFloat: bigint,
): Promise<{ matchId: number; hash: Hash }> {
  const s = activeSigner();
  if (!s) throw new NoSignerError();
  const d = dep();
  const stake = await stakeFor(tier);
  // One permit covers the stake and the session key's gas float (both ERC-20
  // USDC), so there is no msg.value and the stake goes through Arc's Memo,
  // tagged with the match id it will get (a race with another creator only
  // mislabels the tag; MatchCreated is the record).
  const permit = await permitFor(s, d.arena, stake + sessionFloat);
  const call = {
    address: d.arena, abi: ARENA_ABI, functionName: 'createMatch',
    args: [tier, cardIds.map(BigInt), session, sessionFloat, permit],
  };
  const predicted = await publicClient().readContract({ address: d.arena, abi: ARENA_ABI, functionName: 'nextMatchId' }) as bigint;
  const r = await sendTagged(call, predicted, `stake:open:tier${tier}`, s);
  const ev = eventArgs<{ matchId: bigint }>(r.receipt, ARENA_ABI, 'MatchCreated');
  if (!ev) throw new Error('match created but no MatchCreated event was found');
  track('match.staked', { seat: 0, tier, currency });
  return { matchId: Number(ev.matchId), hash: r.hash };
}

/** Take the second seat of an open match. */
export async function joinMatchTx(
  m: ChainMatch, cardIds: number[], session: Address, sessionFloat: bigint,
): Promise<{ hash: Hash }> {
  const s = activeSigner();
  if (!s) throw new NoSignerError();
  const permit = await permitFor(s, dep().arena, m.stakeRaw + sessionFloat);
  const r = await sendTagged({
    address: dep().arena, abi: ARENA_ABI, functionName: 'joinMatch',
    args: [BigInt(m.id), cardIds.map(BigInt), session, sessionFloat, permit],
  }, m.id, 'stake:join', s);
  track('match.staked', { seat: 1, tier: m.tier, currency: m.currency });
  return { hash: r.hash };
}

export async function cancelMatchTx(matchId: number): Promise<TxResult> {
  return send({ address: dep().arena, abi: ARENA_ABI, functionName: 'cancelMatch', args: [BigInt(matchId)] });
}

/**
 * Record this seat's result — by the session key when there is one, so no
 * prompt. Tagged through Arc's Memo with the match id: the second claim is the
 * one that pays the pot, so the payout itself carries the tag.
 */
export async function claimTx(matchId: number, winner: number, finalHash: Hex, by?: Signer | null): Promise<TxResult> {
  return sendTagged({
    address: dep().arena, abi: ARENA_ABI, functionName: 'claim', args: [BigInt(matchId), winner, finalHash],
  }, matchId, `result:${winner === 2 ? 'tie' : `seat${winner}`}`, by);
}

/** Finish a match whose deadline passed. Permissionless; the stored claims decide it. */
export async function claimTimeoutTx(matchId: number): Promise<TxResult> {
  return send({ address: dep().arena, abi: ARENA_ABI, functionName: 'claimTimeout', args: [BigInt(matchId)] });
}

export async function withdrawOwedTx(): Promise<TxResult> {
  return send({ address: dep().arena, abi: ARENA_ABI, functionName: 'withdraw' });
}

/**
 * Log one card play on chain, from the match's session key.
 *
 * Gas is estimated per call, plus 15%. A fixed limit looked attractive — the
 * call is the same every time — but it is not the same cost every time: the
 * first play of a match writes the play counters from zero, which is ~22k gas
 * more than every later one, and a fixed 48k limit reverted exactly that play
 * (and a reverted transaction still pays its gas). The estimate is one round
 * trip, and the play is never awaited by the battle.
 */
async function sendLogged(session: Signer, data: Hex, fallbackGas: bigint): Promise<Hash> {
  const to = dep().arena;
  let gas = fallbackGas;
  try {
    gas = ((await publicClient().estimateGas({ account: session.address, to, data })) * 115n) / 100n;
  } catch { /* the fallback is sized for a first play */ }
  return session.wallet.sendTransaction({ account: session.account, chain: session.wallet.chain, to, data, gas });
}

export async function playTx(session: Signer, matchId: number, tick: number, cardIndex: number, x: number, y: number): Promise<Hash> {
  const data = encodeFunctionData({ abi: ARENA_ABI, functionName: 'play', args: [BigInt(matchId), tick, cardIndex, x, y] });
  return sendLogged(session, data, 75_000n);
}

export async function checkpointTx(session: Signer, matchId: number, tick: number, stateHash: bigint): Promise<Hash> {
  const data = encodeFunctionData({ abi: ARENA_ABI, functionName: 'checkpoint', args: [BigInt(matchId), tick, stateHash] });
  return sendLogged(session, data, 45_000n);
}

export async function readMatch(matchId: number): Promise<ChainMatch | null> {
  return fetchMatchById(matchId);
}
