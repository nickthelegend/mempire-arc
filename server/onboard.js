/**
 * Onboarding: a starter deck and, on test chains, a little USDC, once per address.
 *
 * # Why this exists
 *
 * "Your bags are your army" is the premise, and a wallet that has just arrived
 * has no army. A staked match needs eight cards locked into the arena, gas to
 * create or join it, and a stake. On Arc the gas *is* the stake currency —
 * USDC — so a player only ever needs one token.
 *
 *  - **Cards.** `MempireCards.mintStarter` mints eight distinct fighters, once
 *    per address, and only the relayer may call it — so the deck exists before
 *    the player has ever held a cent. This runs on every chain, mainnet
 *    included: it costs the relayer only gas (fractions of a cent on Arc).
 *  - **USDC.** On a test chain only (Arc testnet, a local Arc fork), a drip
 *    (`ONBOARD_USDC_DRIP`, default 2 USDC) that covers a first $1 stake, its
 *    session-key gas float and a few card mints. It is sent as native value:
 *    Arc's native balance and its ERC-20 USDC are one balance, so the same
 *    transfer pays gas and funds the stake. On mainnet the drip is off
 *    regardless of configuration; players bring USDC (any wallet, an
 *    exchange, or CCTP from another chain — see /api/deposit).
 *
 * # Abuse
 *
 * Testnet tokens are worth nothing, so the threat is drain — one script
 * emptying the relayer so nobody else can start. Three guards: a signature
 * proving the caller controls the address, one claim per address ever
 * (recorded in Mongo, or in memory without it), and a per-IP rate limit. A
 * determined attacker with many keys can still drain it; the answer to that is
 * a refill, not a harder puzzle for real players.
 *
 * # Partial success
 *
 * Two transactions, not atomic. Each step's outcome is recorded on the claim,
 * and a claim with a failed step may be retried — which re-runs only the steps
 * that did not land. The starter mint is guarded by the chain itself
 * (`starterClaimed`), and the drip by the claim record, so a retry can finish a
 * half-delivered kit but never pays twice.
 */
import { formatEther, parseEther, parseEventLogs } from 'viem';
import { requireWallet } from './auth.js';
import {
  IS_TEST_CHAIN, abis, archetypeOf, coinById, deployment, normAddress, publicClient, roster,
} from './chain.js';
import { checkRelayer, relayerAddress, relayerRefusal, sendRelayerTx } from './relayer.js';
import { recordEvent } from './telemetry.js';

const DECK_SIZE = 8;

/**
 * Recognisable first, because a new player's first look at the game is these
 * eight cards. Anything not listed here comes after, in roster order.
 */
const PREFERRED = [
  'BTC', 'ETH', 'SOL', 'DOGE', 'LINK', 'BONK', 'PEPE', 'NVDA',
  'WIF', 'SHIB', 'TSLA', 'AAPL', 'XRP', 'LINK', 'POPCAT', 'SPY',
];

/**
 * The eight coin ids every new player starts with.
 *
 * Deterministic — the same roster always yields the same deck, so a support
 * question about "my starter cards" has one answer. Two passes over the
 * preference order: first take the best-known coin of each archetype not yet
 * covered, so the deck has a tank, a swarm, ranged, splash, support and a
 * spell wherever the roster allows it (a deck missing a role is a worse first
 * match, not just a different one); then fill the remaining slots with the
 * best-known coins left.
 */
export function chooseStarterDeck(coins, archetypeFor) {
  const order = [
    ...PREFERRED.map((t) => coins.find((c) => c.ticker === t)).filter(Boolean),
    ...coins.filter((c) => !PREFERRED.includes(c.ticker)),
  ];
  const picked = [];
  const covered = new Set();
  for (const c of order) {
    if (picked.length === DECK_SIZE) break;
    const a = archetypeFor(c);
    if (covered.has(a)) continue;
    covered.add(a);
    picked.push(c);
  }
  for (const c of order) {
    if (picked.length === DECK_SIZE) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.map((c) => c.coinId);
}

/**
 * Gas headroom the relayer must keep beyond the drip itself before it accepts
 * a claim. Eight mints cost well under a cent of USDC at Arc's ~20–25 gwei base
 * fee; this leaves a wide margin.
 */
const GAS_RESERVE = parseEther('0.05');

const short = (e) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 200);

export function registerOnboardRoutes(app, db, { ipGate, readGate } = {}) {
  const pass = (_req, _res, next) => next();
  const claims = db.collection('onboard_claims');

  // Native USDC has 18 decimals, so parseEther reads "2" as 2 USDC.
  const drip = (() => {
    const raw = process.env.ONBOARD_USDC_DRIP ?? '2';
    try { return parseEther(raw); } catch { return parseEther('2'); }
  })();

  /*
   * The starter deck, chosen once at boot from the vendored roster — and then
   * checked against the chain, because the roster file and the deployed
   * contract are two copies of one fact. `roster()` gives every registered
   * coin's feed id and stored archetype in one call; a coin id that names a
   * different feed on chain means the roster is stale, and minting from it
   * would hand players fighters the client draws as something else.
   */
  const archetypes = new Map(roster.map((c) => [c.coinId, archetypeOf(c.feedId)]));
  let starter = chooseStarterDeck(roster, (c) => archetypes.get(c.coinId));
  let canMint = false;
  let bootNote = null;

  const ready = (async () => {
    if (!deployment) { bootNote = `no deployment for this chain`; return; }
    if (!relayerAddress()) { bootNote = relayerRefusal(); return; }
    const relayer = await checkRelayer();
    if (!relayer.ok) { bootNote = relayer.reason; return; }
    canMint = relayer.canMint;
    if (!canMint) bootNote = relayer.reason;

    const client = publicClient();
    const onchain = await client.readContract({
      address: deployment.cards, abi: abis.cards, functionName: 'roster',
    });
    const stale = roster.filter((c) => {
      const oc = onchain[c.coinId];
      return !oc || oc.feedId.toLowerCase() !== c.feedId.toLowerCase();
    });
    if (stale.length) {
      canMint = false;
      bootNote = `roster.json disagrees with MempireCards for ${stale.map((c) => c.ticker).join(', ')} — run npm run sync-shared`;
      return;
    }
    // The formula, checked against the contract's own `archetypeFor` for the
    // coins we are about to mint. If they ever disagree, the chain wins.
    const chainArch = await Promise.all(starter.map((id) => client.readContract({
      address: deployment.cards, abi: abis.cards, functionName: 'archetypeFor', args: [coinById.get(id).feedId],
    })));
    const drift = starter.filter((id, i) => Number(chainArch[i]) !== archetypes.get(id));
    if (drift.length) {
      console.error(`onboard: archetype formula disagrees with the contract for coins ${drift.join(', ')} — using the chain's`);
      for (const c of onchain.entries()) archetypes.set(c[0], Number(c[1].archetype));
      starter = chooseStarterDeck(roster, (c) => archetypes.get(c.coinId));
    }
  })().catch((e) => { canMint = false; bootNote = `boot check failed: ${short(e)}`; })
    .finally(() => {
      const deck = starter.map((id) => coinById.get(id).ticker).join(' ');
      console.log(`onboard: relayer ${relayerAddress() ?? 'none'} · starter ${deck} · ${canMint ? 'minting' : `not minting (${bootNote})`}`
        + ` · drip ${IS_TEST_CHAIN ? `${formatEther(drip)} USDC` : 'off (not a test chain)'}`);
    });

  // ── the steps ─────────────────────────────────────────────────────────────

  async function stepStarter(address, client) {
    const claimed = await client.readContract({
      address: deployment.cards, abi: abis.cards, functionName: 'starterClaimed', args: [address],
    });
    if (claimed) return { status: 'already' };
    if (!canMint) return { status: 'failed', error: bootNote ?? 'starter minting is unavailable' };
    const { hash, receipt } = await sendRelayerTx({
      address: deployment.cards,
      abi: abis.cards,
      functionName: 'mintStarter',
      args: [address, starter],
    });
    const cardIds = parseEventLogs({ abi: abis.cards, eventName: 'CardMinted', logs: receipt.logs })
      .map((l) => l.args.cardId.toString());
    return { status: 'minted', tx: hash, cardIds };
  }

  async function stepUsdc(address, client) {
    if (!IS_TEST_CHAIN || drip === 0n) return { status: 'unconfigured' };
    const balance = await client.getBalance({ address });
    if (balance >= drip) return { status: 'skipped' };
    const { hash } = await sendRelayerTx({ to: address, value: drip });
    return { status: 'sent', tx: hash, amount: formatEther(drip) };
  }

  /** Steps whose outcome is final; anything else is retried on the next claim. */
  const settled = (s) => ['minted', 'already', 'sent', 'skipped', 'queued', 'unconfigured'].includes(s);

  // ── routes ─────────────────────────────────────────────────────────────────

  // The IP gate sits after the signature check, so a flood of junk signatures
  // (refused for the price of a hash) cannot spend an honest household's
  // claims; the global limiter already bounds that flood.
  app.post('/api/onboard', requireWallet('onboard'), ipGate ?? pass, async (req, res) => {
    await ready;
    if (!deployment) return res.status(503).json({ error: 'no contracts deployed on this chain' });
    if (!relayerAddress()) return res.status(503).json({ error: `onboarding unavailable: ${relayerRefusal()}` });
    const address = req.wallet;
    const client = publicClient();

    /*
     * Refuse before recording anything if the relayer cannot pay.
     *
     * The claim is one-per-address, so a dry relayer that recorded claims and
     * then failed would make every new player's "first try" a failure they
     * have to come back for. Checking first turns that into a message an
     * operator can act on, with nothing written.
     */
    const funds = await client.getBalance({ address: relayerAddress() }).catch(() => 0n);
    const needed = GAS_RESERVE + (IS_TEST_CHAIN ? drip : 0n);
    if (funds < needed) {
      return res.status(503).json({
        error: 'the onboarding relayer is out of USDC for gas — nothing was claimed, try again later',
        relayerUsdc: formatEther(funds),
      });
    }

    /*
     * One claim per address, taken before anything is sent.
     *
     * A unique `_id` makes the second concurrent claim a duplicate-key error
     * rather than a second drip. A claim whose earlier attempt left a step
     * unfinished is re-taken atomically by flipping `running` on, so two
     * retries cannot both run either. A `running` flag older than the longest
     * an attempt can take is a crash's leftover, not a live attempt, and is
     * taken over rather than locking the address out forever.
     */
    let doc;
    const now = new Date();
    try {
      await claims.insertOne({ _id: address, at: now, startedAt: now, running: true, steps: {}, txs: {} });
      doc = { steps: {}, txs: {} };
    } catch (e) {
      if (e?.code !== 11000) throw e;
      doc = await claims.findOneAndUpdate(
        {
          _id: address,
          complete: { $ne: true },
          $or: [{ running: { $ne: true } }, { startedAt: { $lt: new Date(Date.now() - 5 * 60_000) } }],
        },
        { $set: { running: true, startedAt: now } },
        { returnDocument: 'after' },
      );
      if (!doc) {
        const prior = await claims.findOne({ _id: address });
        return res.status(409).json({
          error: prior?.running ? 'onboarding for this address is already in progress' : 'this address is already onboarded',
          claimedAt: prior?.at ?? null,
          starter: prior?.steps?.starter ?? null,
          usdc: prior?.steps?.usdc ?? null,
          txs: prior?.txs ?? {},
        });
      }
    }

    const steps = { ...(doc.steps ?? {}) };
    const txs = { ...(doc.txs ?? {}) };
    const errors = {};
    let cardIds = null;
    const run = async (name, fn) => {
      if (settled(steps[name])) return;
      try {
        const r = await fn();
        steps[name] = r.status;
        if (r.tx) txs[name] = r.tx;
        if (r.cardIds) cardIds = r.cardIds;
        if (r.error) errors[name] = r.error;
      } catch (e) {
        // A transaction that reached the network and then failed still has a
        // hash worth reporting; one that never left has nothing to show.
        steps[name] = 'failed';
        if (e?.hash) txs[name] = e.hash;
        errors[name] = short(e);
      }
    };

    // The deck first: it is the one step without which nothing else matters.
    await run('starter', () => stepStarter(address, client));
    await run('usdc', () => stepUsdc(address, client));

    const complete = ['starter', 'usdc'].every((k) => settled(steps[k]));
    await claims.updateOne({ _id: address }, {
      $set: { running: false, complete, steps, txs, updatedAt: new Date(), ...(Object.keys(errors).length ? { errors } : {}) },
    }).catch(() => {});

    recordEvent(db, { type: 'onboard', address, props: { ...steps } });

    res.status(complete ? 200 : 502).json({
      ok: complete,
      address,
      starter: steps.starter,
      usdc: steps.usdc,
      txs,
      ...(cardIds ? { cardIds } : {}),
      starterCoins: starter,
      ...(Object.keys(errors).length ? { errors } : {}),
      ...(complete ? {} : { note: 'some steps did not land — onboarding again retries only those' }),
    });
  });

  /**
   * Where an address stands. Public — every number here is readable on any
   * explorer — but gated, because each call spends three RPC reads from the
   * same quota money verification uses.
   */
  app.get('/api/onboard/:address', readGate ?? pass, async (req, res) => {
    const address = normAddress(req.params.address);
    if (!address) return res.status(400).json({ error: 'bad address' });
    if (!deployment) return res.status(503).json({ error: 'no contracts deployed on this chain' });
    try {
      const client = publicClient();
      const [starterClaimed, native, claim] = await Promise.all([
        client.readContract({ address: deployment.cards, abi: abis.cards, functionName: 'starterClaimed', args: [address] }),
        client.getBalance({ address }),
        claims.findOne({ _id: address }),
      ]);
      // One balance, two views: native (18 decimals) and the ERC-20 (6 decimals, truncated).
      res.json({
        address,
        starterClaimed,
        usdc: { balance: formatEther(native), units: (native / 10n ** 12n).toString(), wei: native.toString() },
        claim: claim
          ? { at: claim.at, complete: !!claim.complete, steps: claim.steps ?? {}, txs: claim.txs ?? {} }
          : null,
      });
    } catch (e) {
      res.status(502).json({ error: `could not read the chain: ${short(e)}` });
    }
  });
}
