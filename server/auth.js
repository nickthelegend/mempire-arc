import { parseSignature, verifyMessage } from 'viem';
import { normAddress } from './chain.js';

/**
 * Wallet-signature auth.
 *
 * Every mutating route used to identify its caller by a wallet address in the
 * URL or the body — and the API publishes those addresses itself, through
 * /api/ladder and /api/clans/:tag. So anyone could read a rival's address off
 * a public endpoint and then write to their record: set their Elo, grant
 * themselves ten million crowns, or kick an entire clan roster by claiming to
 * be the leader whose address the clan page prints.
 *
 * A wallet address identifies, it does not authenticate. The holder has to
 * prove they hold the matching secret key, which they do by signing something
 * only they could have signed: an EIP-191 `personal_sign` over the message
 * below, which every EVM wallet produces without a custom prompt.
 *
 * The signed message carries a timestamp, and the server rejects anything more
 * than five minutes old in either direction. Without that, one captured
 * signature is a permanent credential — the same request could be replayed
 * forever. Clock skew in both directions is allowed because a client's clock
 * being a minute fast is not an attack.
 *
 * There is no nonce store. A signature is replayable within its five-minute
 * window, which is a real but bounded weakness: the alternative is a
 * server-side nonce per request, which needs a round trip before every write
 * and a store to expire. For a testnet game where the worst outcome is a
 * repeated ladder update, the window is the right trade. It is NOT the right
 * trade once real value moves through here, and that is written down rather
 * than discovered later.
 */

const MAX_SKEW_MS = 5 * 60 * 1000;

/** secp256k1 group order / 2. A signature with `s` above it is the malleated twin. */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** The exact bytes a client must sign. Any drift here fails every request. */
export function authMessage(address, action, ts) {
  return `Mempire\naction: ${action}\nwallet: ${address}\nts: ${ts}`;
}

/**
 * The canonical spelling of a signature, or null if it is not one.
 *
 * The replay store below keys on the signature, so it must have exactly one
 * spelling. Hex is case-insensitive, so `0xAB…` and `0xab…` would be two keys
 * for one signature; and ECDSA is malleable — from any valid (r, s) anyone can
 * compute (r, n − s), which also verifies. Either would let a captured request
 * be replayed once more as a "new" signature. So: lowercase, exactly 65 bytes,
 * and low-s only (EIP-2; every mainstream wallet already signs this way).
 */
export function canonicalSignature(signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    const { s } = parseSignature(signature);
    if (BigInt(s) > HALF_N) return null;
  } catch {
    return null;
  }
  return signature.toLowerCase();
}

/**
 * Verifies that `address` signed `action` at `ts`.
 *
 * Resolves null on success or a string reason on failure. A string rather than
 * a thrown error because every caller wants to turn it into a 401 body.
 *
 * The message is rebuilt from the address exactly as the client sent it —
 * checksummed or not — because that is the text the wallet displayed and
 * signed. Recovery compares addresses case-insensitively, and the caller
 * normalises for storage afterwards.
 */
export async function verifySignature({ address, action, ts, signature }) {
  if (!address || !signature || !action) return 'missing address, action or signature';
  if (!normAddress(address)) return 'address is not a 0x-prefixed 20-byte address';

  const when = Number(ts);
  if (!Number.isFinite(when)) return 'bad timestamp';
  if (Math.abs(Date.now() - when) > MAX_SKEW_MS) return 'signature expired';

  if (!canonicalSignature(signature)) return 'signature is not a 65-byte low-s hex signature';
  try {
    const ok = await verifyMessage({
      address,
      message: authMessage(address, action, when),
      signature,
    });
    return ok ? null : 'signature does not verify';
  } catch {
    // Malformed points throw rather than returning false; input an attacker
    // controls must be a 401, never a 500.
    return 'signature does not verify';
  }
}

/**
 * Express middleware. `action` must match what the client signed, so a
 * signature captured for one route cannot be replayed against another —
 * without it, a signature for a harmless read would authorise a clan kick.
 *
 * The address is taken from the route param or the body and then, once
 * verified, written to `req.wallet`. Handlers must read `req.wallet` and never
 * the raw param again: that is the whole point.
 */
export function requireWallet(action) {
  return async (req, res, next) => {
    const address = req.params.address || req.body?.address;
    const { signature, ts } = req.body ?? {};
    const bad = await verifySignature({ address, action, ts, signature });
    if (bad) return res.status(401).json({ error: `unauthorised: ${bad}` });
    /*
     * A valid signature must also be a *fresh* one. The skew window alone
     * left five minutes in which a captured request could be replayed
     * verbatim — tolerable for a test ladder, written down as such, and
     * not tolerable once these routes gate anything real. The store is a
     * TTL'd unique index on the signature itself: the second submission of
     * the same bytes fails the insert and the request. Absent a database
     * (tests, cold boot) this passes through, which only ever widens back
     * to the documented window rather than opening anything new.
     */
    if (replaySeen && await replaySeen(canonicalSignature(signature))) {
      return res.status(401).json({ error: 'unauthorised: signature already used' });
    }
    // Lowercase, always: this is the key every handler stores under.
    req.wallet = normAddress(address);
    // Per-wallet rate limiting, once the wallet is proven. Installed at startup
    // via `setWalletLimiter`; absent in tests and before the database is up, in
    // which case this is a pass-through.
    if (walletLimit) return walletLimit(req, res, next);
    return next();
  };
}

/**
 * The per-wallet limiter, injected once there is a database to hold it.
 *
 * Kept here rather than composed at each route because every mutating route
 * already goes through `requireWallet`, and a limit that has to be remembered
 * at thirty call sites is a limit that will be missing from one of them.
 */
let walletLimit = null;
export function setWalletLimiter(fn) { walletLimit = fn; }

/** Injected like the limiter: returns true when this signature was seen before. */
let replaySeen = null;
export function setReplayStore(fn) { replaySeen = fn; }

/**
 * The same check for a WebSocket message, where there is no Express request.
 * Resolves true when the message is properly signed for `action`.
 */
export async function wsVerified(msg, action) {
  return (await verifySignature({
    address: msg?.address, action, ts: msg?.ts, signature: msg?.signature,
  })) === null;
}
