import { generatePrivateKey, nonceManager, privateKeyToAccount } from 'viem/accounts';
import { zeroAddress, type Address, type Hex } from 'viem';
import { activeSigner, localSigner, type Signer } from './account';
import { privyActorWallet, privyConsent } from '../lib/privy';

/*
 * Per-match session keys.
 *
 * A match writes every card drop to the chain as it happens. Asking the
 * player's wallet to approve each one would end the game at the first card, so
 * a match gets its own throwaway key: generated in the browser, named as the
 * seat's session in the create/join transaction, and funded in that same
 * transaction with a few cents of MON for gas. The arena accepts it for that
 * seat of that match and nothing else — it can log plays, post checkpoints and
 * record the result, and it can never move a stake or a card.
 *
 * It is kept in sessionStorage for the life of the tab, so a reload mid-match
 * can still record the result rather than stranding the seat's claim.
 */

/*
 * MON forwarded to the session key for its gas.
 *
 * A logged transaction is a ~45k gas limit (Monad bills the limit) at testnet's
 * 100 gwei floor, about 0.005 MON. A three-minute match is ~20–25 plays, a
 * checkpoint every 8 s (~22, and they yield to plays when the float runs low)
 * and the claim: ~45 transactions, ~0.22 MON at worst. 0.2 MON covers every
 * play with the checkpoints trimmed; whatever is left is swept back to the
 * player when the match ends, so the allowance is a float, not a fee.
 */
export const SESSION_GAS_WEI = 200_000_000_000_000_000n; // 0.2 MON
/**
 * MON a wallet needs to open or join a staked match: the session float plus
 * the stake transaction's own gas (~300k at 100 gwei). The relay's onboarding
 * drip (0.25) is sized to cover it.
 */
export const STAKE_MON_NEEDED = 0.23;
/** Kept back from logging so the seat can always afford to record its result. */
export const CLAIM_RESERVE_WEI = 15_000_000_000_000_000n; // 0.015 MON

/*
 * Privy players need none of this. Their wallet has the relay as a session
 * signer under the match policy, so the relay sends their plays and claim as
 * them — sponsored, and limited to exactly those arena calls. No throwaway key,
 * no gas float, nothing to sweep.
 */
export const usesPrivySigner = (): boolean =>
  activeSigner()?.kind === 'privy' && privyConsent() !== null;

function privyActor(): Signer {
  const me = activeSigner()!;
  return { kind: 'privy', address: me.address, account: me.address, wallet: privyActorWallet(), label: 'Privy session signer', icon: null };
}

/** The MON a create/join forwards to the seat's session key. None for Privy. */
export const sessionGasWei = (): bigint => (usesPrivySigner() ? 0n : SESSION_GAS_WEI);

const KEY = (matchId: number) => `mempire_session_${matchId}`;
const PENDING = 'mempire_session_pending';

interface Live {
  matchId: number;
  signer: Signer;
}

let live: Live | null = null;

/** A fresh key for the match about to be created or joined. Its id is not known yet. */
export function prepareSession(): Address {
  if (usesPrivySigner()) return zeroAddress; // the seat's own wallet speaks for it
  const k = generatePrivateKey();
  try { sessionStorage.setItem(PENDING, k); } catch { /* memory only */ }
  pending = k;
  return privateKeyToAccount(k).address;
}

let pending: Hex | null = null;

/** Bind the prepared key to the match id the chain assigned. */
export function bindSession(matchId: number): Signer | null {
  if (usesPrivySigner()) {
    live = { matchId, signer: privyActor() };
    return live.signer;
  }
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
  if (usesPrivySigner()) {
    live = { matchId, signer: privyActor() };
    return live.signer;
  }
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
  if (!s || s.kind === 'privy') { forgetSession(matchId); return; }
  try {
    const { publicClient } = await import('./provider');
    const client = publicClient();
    const [balance, gasPrice] = await Promise.all([
      client.getBalance({ address: s.address }),
      client.getGasPrice(),
    ]);
    const fee = gasPrice * 21_000n;
    if (balance > fee * 2n) {
      await s.wallet.sendTransaction({
        account: s.account, chain: s.wallet.chain, to, value: balance - fee, gas: 21_000n, gasPrice,
      });
    }
  } catch { /* dust */ }
  forgetSession(matchId);
}

/** Forget a finished match's key. What MON it has left is dust by design. */
export function forgetSession(matchId?: number): void {
  if (matchId !== undefined) {
    try { sessionStorage.removeItem(KEY(matchId)); } catch { /* nothing */ }
  }
  live = null;
}
