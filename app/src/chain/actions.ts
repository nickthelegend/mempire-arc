import {
  decodeEventLog, encodeFunctionData, erc20Abi, maxUint256, parseSignature, zeroAddress, type Abi, type Address, type Hash, type Hex,
} from 'viem';
import { apiFetch } from '../lib/api';
import { track } from '../lib/track';
import {
  activeSigner, NoSignerError, readableChainError, send, type Signer, type TxResult,
} from './account';
import { CHAIN_ID, DEPLOYMENT, publicClient } from './provider';
import { ARENA_ABI, CARDS_ABI, fetchMatchById, type ChainMatch } from './read';

/*
 * Every transaction the game sends.
 *
 * All of them go through `send` (chain/account.ts), which simulates first, so a
 * call that would revert fails here with the contract's own reason and costs
 * nothing — Monad bills the gas limit of a mined revert in full.
 */

export { NoSignerError, readableChainError };
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

/**
 * A fresh Pyth price update for one fighter, from the relay.
 *
 * Hermes has needed an API key since Aug 2026; the relay holds it and proxies,
 * so it never ships to a browser. The update is posted in the mint transaction
 * itself — Pyth is a pull oracle, and the on-chain price is only as fresh as
 * the last time somebody posted one.
 */
export async function pythUpdate(coinIds: number[]): Promise<Hex[]> {
  const res = await apiFetch(`/api/pyth/update?coinIds=${coinIds.join(',')}`);
  if (!res) throw new Error('the price relay is unreachable');
  const body = await res.json().catch(() => ({})) as { updateData?: Hex[]; error?: string };
  if (!res.ok || !Array.isArray(body.updateData)) {
    throw new Error(body.error ? `price relay: ${body.error}` : 'the price relay returned no update');
  }
  return body.updateData;
}

export interface MintResult extends TxResult {
  cardId: number;
}

/** Mint a fighter for MON (0.01) or for 250 $MEMPIRE. Either way the card records its Pyth price. */
export async function mintCardTx(coinId: number, payWith: 'mon' | 'mempire' = 'mon'): Promise<MintResult> {
  const d = dep();
  const update = await pythUpdate([coinId]);
  const client = publicClient();
  const mintFee = await client.readContract({
    address: d.cards, abi: CARDS_ABI, functionName: 'mintFee',
  }) as bigint;
  const pythFee = await client.readContract({
    address: d.pyth,
    abi: [{ type: 'function', name: 'getUpdateFee', stateMutability: 'view', inputs: [{ type: 'bytes[]', name: 'u' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'getUpdateFee',
    args: [update],
  }) as bigint;
  let r: TxResult;
  if (payWith === 'mempire') {
    await ensureAllowance(d.token, d.cards, 250n * 10n ** 18n);
    r = await send({ address: d.cards, abi: CARDS_ABI, functionName: 'mintWithMempire', args: [coinId, update], value: pythFee });
  } else {
    r = await send({ address: d.cards, abi: CARDS_ABI, functionName: 'mint', args: [coinId, update], value: mintFee + pythFee });
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
 * Two transactions, a block apart — about a second on Monad. The contents are
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

export type Currency = 'MON' | 'AUSD';

export const currencyAddress = (c: Currency): Address => (c === 'MON' ? zeroAddress : dep().ausd);

export async function stakeFor(currency: Currency, tier: number): Promise<bigint> {
  return await publicClient().readContract({
    address: dep().arena, abi: ARENA_ABI, functionName: 'stakeFor', args: [currencyAddress(currency), tier],
  }) as bigint;
}

interface PermitArg { deadline: bigint; v: number; r: Hex; s: Hex }
const NO_PERMIT: PermitArg = { deadline: 0n, v: 0, r: `0x${'0'.repeat(64)}`, s: `0x${'0'.repeat(64)}` };

/**
 * An EIP-2612 permit for the arena to pull an AUSD stake.
 *
 * Signed, not sent: the permit rides inside the create/join transaction, so a
 * dollar stake is one transaction rather than approve-then-stake. If the token
 * already has enough allowance the permit is skipped.
 */
async function permitFor(s: Signer, amount: bigint): Promise<PermitArg> {
  const d = dep();
  const client = publicClient();
  const allowance = await client.readContract({
    address: d.ausd, abi: erc20Abi, functionName: 'allowance', args: [s.address, d.arena],
  });
  if (allowance >= amount) return NO_PERMIT;
  const permitAbi = [
    { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address', name: 'o' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'eip712Domain', stateMutability: 'view', inputs: [], outputs: [
      { type: 'bytes1', name: 'fields' }, { type: 'string', name: 'name' }, { type: 'string', name: 'version' },
      { type: 'uint256', name: 'chainId' }, { type: 'address', name: 'verifyingContract' },
      { type: 'bytes32', name: 'salt' }, { type: 'uint256[]', name: 'extensions' }] },
  ] as const;
  const [nonce, domain] = await Promise.all([
    client.readContract({ address: d.ausd, abi: permitAbi, functionName: 'nonces', args: [s.address] }),
    client.readContract({ address: d.ausd, abi: permitAbi, functionName: 'eip712Domain' }),
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const signature = await s.wallet.signTypedData({
    account: s.account,
    domain: { name: domain[1], version: domain[2], chainId: Number(domain[3]), verifyingContract: domain[4] },
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
    message: { owner: s.address, spender: d.arena, value: amount, nonce, deadline },
  });
  const { r, s: sig, v, yParity } = parseSignature(signature);
  return { deadline, v: Number(v ?? BigInt(yParity + 27)), r, s: sig };
}

/** Escrow a stake and open a match. Returns the id the chain assigned. */
export async function createMatchTx(
  tier: number, currency: Currency, cardIds: number[], session: Address, sessionGas: bigint,
): Promise<{ matchId: number; hash: Hash }> {
  const s = activeSigner();
  if (!s) throw new NoSignerError();
  const d = dep();
  const stake = await stakeFor(currency, tier);
  const permit = currency === 'AUSD' ? await permitFor(s, stake) : NO_PERMIT;
  const value = currency === 'MON' ? stake + sessionGas : sessionGas;
  const r = await send({
    address: d.arena, abi: ARENA_ABI, functionName: 'createMatch',
    args: [tier, currencyAddress(currency), cardIds.map(BigInt), session, permit],
    value,
  }, s);
  const ev = eventArgs<{ matchId: bigint }>(r.receipt, ARENA_ABI, 'MatchCreated');
  if (!ev) throw new Error('match created but no MatchCreated event was found');
  track('match.staked', { seat: 0, tier, currency });
  return { matchId: Number(ev.matchId), hash: r.hash };
}

/** Take the second seat of an open match. */
export async function joinMatchTx(
  m: ChainMatch, cardIds: number[], session: Address, sessionGas: bigint,
): Promise<{ hash: Hash }> {
  const s = activeSigner();
  if (!s) throw new NoSignerError();
  const permit = m.currency === 'AUSD' ? await permitFor(s, m.stakeRaw) : NO_PERMIT;
  const value = m.currency === 'MON' ? m.stakeRaw + sessionGas : sessionGas;
  const r = await send({
    address: dep().arena, abi: ARENA_ABI, functionName: 'joinMatch',
    args: [BigInt(m.id), cardIds.map(BigInt), session, permit],
    value,
  }, s);
  track('match.staked', { seat: 1, tier: m.tier, currency: m.currency });
  return { hash: r.hash };
}

export async function cancelMatchTx(matchId: number): Promise<TxResult> {
  return send({ address: dep().arena, abi: ARENA_ABI, functionName: 'cancelMatch', args: [BigInt(matchId)] });
}

/** Record this seat's result — by the session key when there is one, so no prompt. */
export async function claimTx(matchId: number, winner: number, finalHash: Hex, by?: Signer | null): Promise<TxResult> {
  return send({
    address: dep().arena, abi: ARENA_ABI, functionName: 'claim', args: [BigInt(matchId), winner, finalHash],
  }, by ?? activeSigner());
}

/** Finish a match whose deadline passed. Permissionless; the stored claims decide it. */
export async function claimTimeoutTx(matchId: number): Promise<TxResult> {
  return send({ address: dep().arena, abi: ARENA_ABI, functionName: 'claimTimeout', args: [BigInt(matchId)] });
}

export async function withdrawOwedTx(currency: Currency): Promise<TxResult> {
  return send({ address: dep().arena, abi: ARENA_ABI, functionName: 'withdraw', args: [currencyAddress(currency)] });
}

/**
 * Log one card play on chain, from the match's session key.
 *
 * Gas is estimated per call, plus 15%. A fixed limit looked attractive — the
 * call is the same every time — but it is not the same cost every time: the
 * first play of a match writes the play counters from zero, which is ~22k gas
 * more than every later one, and a fixed 48k limit reverted exactly that play
 * (and Monad bills a reverted transaction its whole limit). The estimate is one
 * round trip, and the play is never awaited by the battle.
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
