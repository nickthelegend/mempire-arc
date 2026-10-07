import { generatePrivateKey, nonceManager, privateKeyToAccount } from 'viem/accounts';
import { type Address, type Hex } from 'viem';
import { localSigner, type Signer } from './account';

/*
 * Per-match session keys.
 *
 * A match writes every card drop to the chain as it happens. Asking the
 * player's wallet to approve each one would end the game at the first card, so
 * a match gets its own throwaway key: generated in the browser, named as the
 * seat's session in the create/join transaction, and funded in that same
 * transaction with a few cents of USDC for gas (Arc's gas token, so the float
 * comes out of the same balance as the stake). The arena accepts it for that
 * seat of that match and nothing else — it can log plays, post checkpoints and
 * record the result, and it can never move a stake or a card.
 *
 * It is kept in sessionStorage for the life of the tab, so a reload mid-match
 * can still record the result rather than stranding the seat's claim.
 */

/*
 * USDC forwarded to the session key for its gas, in native units (18 decimals).
 *
 * A logged play is ~30–50k gas; at Arc's ~25–40 gwei that is a tenth of a cent
 * or so. A three-minute match is ~20–25 plays, a checkpoint every 8 s (~22, and
 * they yield to plays when the float runs low) and the claim: ~45 transactions,
 * well under 0.08 USDC. 0.1 USDC covers it; whatever is left is swept back to
 * the player when the match ends, so the allowance is a float, not a fee. The
 * arena caps it at 0.25 USDC.
 */
export const SESSION_GAS_WEI = 100_000_000_000_000_000n; // 0.1 USDC
/**
 * USDC a wallet needs beyond the stake to open or join a staked match: the
 * session float plus the stake transaction's own gas (~400k gas). The relay's
 * testnet drip (2 USDC) covers a $1 stake and this several times over.
 */
export const STAKE_USDC_NEEDED = 0.12;
/** Kept back from logging so the seat can always afford to record its result. */
export const CLAIM_RESERVE_WEI = 5_000_000_000_000_000n; // 0.005 USDC

/** The USDC a create/join forwards to the seat's session key. */
export const sessionGasWei = (): bigint => SESSION_GAS_WEI;
/**
 * The same float in ERC-20 USDC units (6 decimals). The arena pulls it with the
 * stake (one permit) and transfers it to the session key as ERC-20 USDC — which
 * on Arc *is* the key's gas balance. No msg.value, so the stake can travel
 * through Arc's Memo tagged with the match id.
 */
export const sessionFloatUnits = (): bigint => SESSION_GAS_WEI / 1_000_000_000_000n;

const KEY = (matchId: number) => `mempire_session_${matchId}`;
const PENDING = 'mempire_session_pending';

interface Live {
  matchId: number;
  signer: Signer;
}

let live: Live | null = null;

/** A fresh key for the match about to be created or joined. Its id is not known yet. */
export function prepareSession(): Address {
  const k = generatePrivateKey();
  try { sessionStorage.setItem(PENDING, k); } catch { /* memory only */ }
  pending = k;
  return privateKeyToAccount(k).address;
}

let pending: Hex | null = null;

/** Bind the prepared key to the match id the chain assigned. */
export function bindSession(matchId: number): Signer | null {
  const k = pending ?? (() => {
    try { return sessionStorage.getItem(PENDING) as Hex | null; } catch { return null; }
  })();
  if (!k) return null;
  pending = null;
  try {
    sessionStorage.setItem(KEY(matchId), k);
    sessionStorage.removeItem(PENDING);
  } catch { /* memory only */ }
  live = { matchId, signer: localSigner('guest', privateKeyToAccount(k, { nonceManager }), 'Session') };
  return live.signer;
}

/** The session signer for a match, recovered from this tab's storage if needed. */
export function sessionFor(matchId: number): Signer | null {
  if (live?.matchId === matchId) return live.signer;
  try {
    const k = sessionStorage.getItem(KEY(matchId)) as Hex | null;
    if (!k) return null;
    live = { matchId, signer: localSigner('guest', privateKeyToAccount(k, { nonceManager }), 'Session') };
    return live.signer;
  } catch {
    return null;
  }
}

export const hasSession = (matchId: number): boolean => sessionFor(matchId) !== null;

/**
 * Return a finished match's unspent gas float to the player, then forget the key.
 * Best effort: a sweep that fails leaves dust on a key nobody will use again.
 */
export async function sweepSession(matchId: number, to: Address): Promise<void> {
  const s = sessionFor(matchId);
  if (!s) { forgetSession(matchId); return; }
  try {
    const { publicClient } = await import('./provider');
    const client = publicClient();
    const [balance, fees, gas] = await Promise.all([
      client.getBalance({ address: s.address }),
      client.estimateFeesPerGas(),
      client.estimateGas({ account: s.address, to, value: 1n }),
    ]);
    // Sized so the whole float but the fee goes home; maxFee bounds what the fee can be.
    const fee = fees.maxFeePerGas * gas;
    if (balance > fee * 2n) {
      await s.wallet.sendTransaction({
        account: s.account, chain: s.wallet.chain, to, value: balance - fee, gas,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
    }
  } catch { /* dust */ }
  forgetSession(matchId);
}

/** Forget a finished match's key. What USDC it has left is dust by design. */
export function forgetSession(matchId?: number): void {
  if (matchId !== undefined) {
    try { sessionStorage.removeItem(KEY(matchId)); } catch { /* nothing */ }
  }
  live = null;
}
