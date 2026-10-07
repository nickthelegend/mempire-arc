/**
 * Reads settled matches and payments off the chain so the relay never has to
 * believe a client about money.
 *
 * `/api/match` used to fold client-asserted pot and payout figures into the
 * public leaderboard's money column — one crafted POST per five minutes and the
 * top of the board is fiction. The signature middleware proves *who* is
 * talking, not that what they say happened happened. The chain is what
 * happened.
 *
 * Everything here is a `readContract` against `MempireArena`, whose ABI is the
 * single source of truth for the struct layout — no offsets to keep in step
 * with the contract by hand.
 */
import { formatUnits, parseEventLogs } from 'viem';
import { abis, currencyOf, deployment, publicClient, sameAddress } from './chain.js';

export const MATCH_STATE_SETTLED = 3;
const WINNER_TIE = 2;
const WINNER_NONE = 3;

/*
 * The arena's rake, cached for a few minutes.
 *
 * The rates can change (`setRules`), and the match struct does not record
 * which rate it settled under, so a match settled before a change and read
 * after it is credited at the new rate. That error is bounded by the
 * difference between two rakes on one pot; re-reading per match would spend
 * two RPC calls per report to shave it. Ten minutes keeps a change visible
 * quickly without a read per request.
 */
let rakeCache = null;
const RAKE_TTL_MS = 10 * 60_000;
async function rakeBps() {
  if (rakeCache && Date.now() - rakeCache.at < RAKE_TTL_MS) return rakeCache;
  const client = publicClient();
  const read = (functionName) => client.readContract({ address: deployment.arena, abi: abis.arena, functionName });
  const [rake, tieRake] = await Promise.all([read('rakeBps'), read('tieRakeBps')]);
  rakeCache = { at: Date.now(), rake: BigInt(rake), tieRake: BigInt(tieRake) };
  return rakeCache;
}

/**
 * The verified money facts for `address` in arena match `matchId`, or null when
 * the chain does not support the claim (no such match, not settled, an unknown
 * stake currency, or the address is not a seat). Callers treat null as "no
 * money moved".
 *
 * Returns `{ currency: 'MON'|'AUSD', net, netUnits, pot, won, draw, players }`,
 * where `net` is the player's change in display units (a JS number, for the
 * leaderboard's `$inc`) and `netUnits` the exact base-unit figure as a string.
 * MON and AUSD are reported separately and must be credited separately: adding
 * 0.05 MON to 5 AUSD gives a number that means nothing.
 */
export async function verifySettledMatch(matchId, address) {
  if (!deployment) return null;
  const id = Number(matchId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const m = await publicClient().readContract({
    address: deployment.arena,
    abi: abis.arena,
    functionName: 'getMatch',
    args: [BigInt(id)],
  });

  if (Number(m.state) !== MATCH_STATE_SETTLED) return null;
  const players = [m.p0, m.p1];
  const seat = players.findIndex((p) => sameAddress(p, address));
  if (seat === -1) return null;
  const currency = currencyOf(m.currency);
  if (!currency) return null;

  const stake = BigInt(m.stake);
  const pot = stake * 2n;
  const winner = Number(m.winner);

  /*
   * Every value `winner` can hold, and no `else`.
   *
   * The arena writes four: 0 or 1 for a seat, 2 for a tie, and 3 for a match
   * that paid nobody — cancelled before anyone joined, voided because the two
   * claims disagreed, or timed out with no claim at all. All three of those
   * refund every stake in full, so the honest figure is zero, not a loss. This
   * is the one column on the board that claims to be read from the chain, so
   * inventing a number for it is worse than declining to.
   */
  let net;
  let won = false;
  let draw = false;
  if (winner === WINNER_NONE) {
    net = 0n;
  } else if (winner === WINNER_TIE) {
    // Mirrors `_settle`: the tie rake comes off the pot, then each seat gets
    // half of what is left (the odd unit goes to the treasury).
    const { tieRake } = await rakeBps();
    const half = (pot - (pot * tieRake) / 10_000n) / 2n;
    draw = true;
    net = half - stake;
  } else if (winner === seat) {
    const { rake } = await rakeBps();
    won = true;
    net = pot - (pot * rake) / 10_000n - stake;
  } else if (winner === 0 || winner === 1) {
    net = -stake;
  } else {
    // A settled match with a winner the contract never writes. Report nothing
    // rather than guess at it.
    return null;
  }
  return {
    currency: currency.symbol,
    net: Number(formatUnits(net, currency.decimals)),
    netUnits: net.toString(),
    pot: Number(formatUnits(pot, currency.decimals)),
    won,
    draw,
    players: players.map((p) => p.toLowerCase()),
  };
}

/** The treasury game fees are paid to — `MempireCards.treasury()`. */
export async function treasuryAddress() {
  if (!deployment) throw new Error('no deployment for this chain');
  return publicClient().readContract({
    address: deployment.cards, abi: abis.cards, functionName: 'treasury',
  });
}

/**
 * Was transaction `hash` a payment of at least `minUnits` of `token` from
 * `payer` to `treasury`?
 *
 * The clan charter is charged by the browser, and the browser is not evidence.
 * `POST /api/clans` validated a wallet signature — which proves who is
 * talking, not that anyone paid. This is the check that makes the fee a fee.
 *
 * Transfer events rather than calldata: the sum of the token's own `Transfer`
 * logs from the payer to the treasury in that receipt is what actually
 * arrived, and it cannot be fooled by a router, a multicall, or a transfer
 * split across several calls. The transaction must also have been sent by the
 * payer, or anyone could cite somebody else's payment.
 *
 * Returns { ok: true, amount } or { ok: false, reason }.
 */
export async function verifyTokenPayment(hash, payer, token, treasury, minUnits) {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return { ok: false, reason: 'that is not a transaction hash' };
  }
  let receipt;
  try {
    receipt = await publicClient().getTransactionReceipt({ hash });
  } catch (e) {
    if (e?.name === 'TransactionReceiptNotFoundError') {
      return { ok: false, reason: 'that transaction is not on chain yet' };
    }
    return { ok: false, reason: `could not read that transaction: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 80)}` };
  }
  if (receipt.status !== 'success') return { ok: false, reason: 'that transaction failed on chain' };
  if (!sameAddress(receipt.from, payer)) {
    return { ok: false, reason: 'that payment was not sent by this wallet' };
  }

  const transfers = parseEventLogs({ abi: abis.erc20, eventName: 'Transfer', logs: receipt.logs });
  const delta = transfers
    .filter((l) => sameAddress(l.address, token)
      && sameAddress(l.args.from, payer) && sameAddress(l.args.to, treasury))
    .reduce((n, l) => n + l.args.value, 0n);
  if (delta < BigInt(minUnits)) {
    return { ok: false, reason: `the treasury received ${delta} of the required ${minUnits}` };
  }
  return { ok: true, amount: delta.toString() };
}
