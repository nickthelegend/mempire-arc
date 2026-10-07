/**
 * Mempire relay: persistence, onboarding, chain reads, and the PvP matchmaker.
 *
 * The browser cannot talk to Atlas directly, so player state lives behind this
 * thin service. One document per wallet address; the client owns game logic and
 * this only stores the result, so a compromised client can't do anything it
 * couldn't already do locally. Real balances move on chain, never here — the
 * one key this process signs with is the relayer's, and it can mint a starter
 * deck and pay a testnet drip, nothing more.
 */
import cors from 'cors';
import express from 'express';
import { MongoClient } from 'mongodb';
import { requireWallet, setReplayStore, setWalletLimiter } from './auth.js';
import { CHAIN_ID, RPC_URL, deployment, normAddress } from './chain.js';
import { verifySettledMatch } from './chain-verify.js';
import { registerClanRoutes } from './clans.js';
import { keeperStatus, startKeeper } from './keeper.js';
import { pythMode } from './pyth.js';
import { registerPrivyRoutes } from './privy.js';
import { registerLockerRoutes } from './locker.js';
import { createMemoryDb } from './memstore.js';
import { registerMarketRoutes } from './market.js';
import { registerAiRoutes } from './ai.js';
import { registerNftRoutes } from './nft.js';
import { registerOnboardRoutes } from './onboard.js';
import { registerPlayerRoutes } from './player.js';
import { registerPythRoutes } from './pyth.js';
import { relayerAddress } from './relayer.js';
import { recordEvent, registerTelemetryRoutes } from './telemetry.js';
import { registerInsightRoutes } from './insights.js';
import { errorRecorder, rateLimiter, registerOpsRoutes, walletLimiter } from './ops.js';
import { applyMatch, leagueFor } from './ranking.js';
import { registerMatchmaker } from './matchmaker.js';

const { MONGODB_URI, MONGODB_DB = 'mempire', PORT = 8787 } = process.env;

/*
 * Mongo when configured, process memory when not.
 *
 * A deployment sets MONGODB_URI and gets the database it always had. Without
 * one the relay used to exit, which made a local chain test depend on an Atlas
 * account; now it runs on `memstore.js` and says so on every boot and in
 * `/api/health`, because "everything vanished on restart" should never be a
 * surprise.
 */
const client = MONGODB_URI ? new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 }) : null;
if (!client) {
  console.warn('MONGODB_URI not set — running on an in-memory store; nothing persists across a restart');
}
let players;
let leaderboard;
let ladder;
// Pairings the matchmaker witnessed — what a ladder report has to cite.
let pairings;
/**
 * The database handle, at module scope.
 *
 * Routes defined above the startup block still need it — `recordEvent` takes a
 * `db`, and the player save is registered long before `client.connect()`
 * resolves. Assigned once at startup; every route that uses it only runs after
 * the server is listening, which is after that assignment.
 */
let db;

const app = express();
// The host terminates TLS at its edge proxy, so without this req.ip is the proxy
// for every client — one shared limiter bucket, and one noisy player 429s the
// whole playerbase. One hop only: trusting the whole chain would make the key
// a spoofable X-Forwarded-For.
app.set('trust proxy', 1);
// Locked to the deployed app's origin in production; open in development.
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined));
app.use(express.json({ limit: '256kb' }));

/*
 * A body this service could not parse is the caller's mistake, not a fault.
 *
 * `express.json` throws a SyntaxError on malformed input, and with no handler
 * for it that surfaced as a 500 — which tells the caller to retry, tells the
 * operator something is broken, and puts noise in the error recorder for what
 * is really just a bad request. Payloads over the limit get the same treatment
 * for the same reason.
 */
app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body too large' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'malformed JSON body' });
  }
  return next(err);
});

/*
 * Rate limiting lives in `ops.js` and is installed at startup, because it needs
 * the database.
 *
 * It used to be a token bucket in a local Map. That is correct for exactly one
 * instance: every replica keeps its own counter, so a limit of 80 becomes 80 ×
 * replicas, and scaling out to absorb abuse loosens the limit in proportion to
 * the abuse. A rolling deploy also reset every bucket.
 *
 * The delegating shim is here rather than the limiter itself because order
 * matters: every route below is registered at module load, and middleware added
 * later would sit behind all of them and never run. This holds the slot.
 */
let credits = null;
let limit = null;
/*
 * A bucket for the public GETs that are not free to serve.
 *
 * Most reads here are a Mongo lookup and the shared limiter rightly waves them
 * through. Some are not: onboarding status, card metadata and the Pyth proxy
 * each spend the relay's RPC quota or its Hermes key, and the RPC quota is the
 * same one `chain-verify` needs to establish who was paid what. Leaving them on
 * the read exemption meant an anonymous loop against a status endpoint could
 * throttle our egress IP and take money verification down with it.
 */
let readLimit = null;
/*
 * And a much tighter one for the route that gives things away.
 *
 * `POST /api/onboard` is signed and once per address, but a script with a
 * thousand fresh keys passes both guards a thousand times. Per IP it gets a
 * handful of claims and then one a minute — slower than any honest
 * household of players, far too slow to drain a relayer.
 */
let onboardLimit = null;
app.use((req, res, next) => (limit ? limit(req, res, next) : next()));
const readGate = (req, res, next) => (readLimit ? readLimit(req, res, next) : next());
const onboardGate = (req, res, next) => (onboardLimit ? onboardLimit(req, res, next) : next());

/**
 * Route addresses arrive in whatever case the wallet produced. Every key this
 * service stores is lowercase (see `normAddress`), so params are normalised
 * once, here, and anything that is not a 20-byte hex address is refused before
 * it reaches a database.
 */
const paramAddress = (req) => normAddress(req.params.address);

/** The arena's stake currencies, and the leaderboard column each one ranks in. */
const CURRENCIES = ['MON', 'AUSD'];
const NET_FIELD = { MON: 'netMon', AUSD: 'netAusd' };

/*
 * Chain-facing reads that need no database: roster prices, the Pyth update
 * proxy, and card metadata. Registered at load so they sit ahead of the
 * catch-all error handler like everything else.
 */
registerMarketRoutes(app);
registerPythRoutes(app, readGate);
registerNftRoutes(app, readGate);
registerAiRoutes(app);

app.get('/api/health', async (_req, res) => {
  const chain = {
    chainId: CHAIN_ID,
    rpc: RPC_URL,
    deployment: Boolean(deployment),
    relayer: relayerAddress(),
    pyth: pythMode(),
    keeper: keeperStatus(),
  };
  if (!client) return res.json({ ok: true, db: 'memory', persistent: false, chain });
  try {
    await client.db(MONGODB_DB).command({ ping: 1 });
    res.json({ ok: true, db: MONGODB_DB, persistent: true, chain });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, chain });
  }
});

/** Full saved state for a wallet, or null if this is their first visit. */
app.get('/api/player/:address', async (req, res) => {
  const address = paramAddress(req);
  if (!address) return res.status(400).json({ error: 'bad address' });
  try {
    const doc = await players.findOne({ _id: address }, { projection: { _id: 0 } });
    res.json(doc ?? null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Upsert the whole saved slice. Client sends it debounced after changes.
 *
 * Values are clamped, not trusted: this API stores game state for a client
 * that already owns the simulation, so nothing here is authoritative — but a
 * hostile PUT must not be able to poison a document with Infinity, negative
 * gems, or a megabyte of "chests" that every later load chokes on.
 */
const num = (v, lo, hi, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
};

app.put('/api/player/:address', requireWallet('player.put'), async (req, res) => {
  const address = req.wallet;
  const {
    cards, deck, tier, mon, history, nextId,
    slots, slot, gems, chests, nextChestId, gemsSpent, monSpentOnGems, shop,
  } = req.body ?? {};
  if (!Array.isArray(cards) || !Array.isArray(deck)) {
    return res.status(400).json({ error: 'cards and deck are required arrays' });
  }
  if (cards.length > 500 || deck.length > 8) {
    return res.status(400).json({ error: 'payload out of range' });
  }
  try {
    const now = new Date();
    await players.updateOne(
      { _id: address },
      {
        $set: {
          cards,
          deck,
          tier: num(tier, 0, 3),
          mon: num(mon, 0, 1_000_000),
          nextId: num(nextId, 1, 1_000_000, 1),
          history: Array.isArray(history) ? history.slice(0, 50) : [],
          slots: Array.isArray(slots) ? slots.slice(0, 3).map((s) => (Array.isArray(s) ? s.slice(0, 8) : [])) : [],
          slot: num(slot, 0, 2),
          gems: num(gems, 0, 10_000_000),
          chests: Array.isArray(chests) ? chests.slice(0, 4) : [],
          nextChestId: num(nextChestId, 1, 10_000_000, 1),
          gemsSpent: num(gemsSpent, 0, 100_000_000),
          monSpentOnGems: num(monSpentOnGems, 0, 1_000_000),
          shop: shop && typeof shop === 'object'
            ? {
              offers: Array.isArray(shop.offers) ? shop.offers.slice(0, 8) : [],
              day: num(shop.day, 0, 1_000_000),
              rerollsUsed: num(shop.rerollsUsed, 0, 1_000),
            }
            : null,
          updatedAt: now,
          // The analytics window counts distinct wallets by these two fields,
          // and this route — the one the client actually calls — never wrote
          // them. So the dashboard reported 27 players, 0 new and 0 active,
          // which is a chart that looks broken because it was reading a column
          // nothing filled in.
          lastSeenAt: now,
        },
        $setOnInsert: { createdAt: now, firstSeenAt: now },
      },
      { upsert: true },
    );

    recordEvent(db, { type: 'player.save', address });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Append one settled match and bump the player's standing. */
app.post('/api/match/:address', requireWallet('match.post'), async (req, res) => {
  const address = req.wallet;
  const {
    won, draw, pot, payout, rake, currency, crowns, escrowed, voided, hashes, matchId,
  } = req.body ?? {};
  try {
    const now = new Date();

    /*
     * Money facts come from the chain or they do not count.
     *
     * The signature on this request proves who sent it, not that the match
     * it describes happened — `escrowed: true, payout: 999` was accepted at
     * face value and ranked on the public board. Now an escrowed claim must
     * name its arena match, and the currency, the pot, the winner and the net
     * movement are read from `MempireArena.getMatch` itself; a claim the
     * chain does not support ranks as zero. W/L and crowns still record
     * either way — rating is the relay's to keep, money is not.
     */
    let verified = null;
    /*
     * One match id, one spelling.
     *
     * The idempotency key below was built from the raw body value while
     * `verifySettledMatch` canonicalised it with `Number(matchId)`. Those two
     * disagree on everything JavaScript is happy to coerce: `90`, `"90"`,
     * `" 90"`, `"90.0"`, `"9e1"` and `"0x5a"` are six different `_id` strings
     * naming one settled match, so the "counted once" guard could be walked
     * straight past six times — and the same pot credited six times — by a
     * caller who only had to retype its own match id. Canonicalise once, here,
     * and let both the claim and the chain read use that single value.
     */
    const mid = Number(matchId);
    const validId = Number.isSafeInteger(mid) && mid >= 0;
    if (escrowed && validId) {
      /*
       * Claim this match for this player before crediting anything. A unique
       * `_id` makes the second attempt a duplicate-key error rather than a
       * second `$inc`, and doing it first means a crash between the claim and
       * the credit loses a record rather than double-counting one.
       *
       * But the claim and the *money* are two different debts, and collapsing
       * them cost honest winners their pot on the board. A client reports the
       * moment its match ends, which is before settlement has landed on chain
       * — the second seat's `claim` is a separate transaction, sent after its
       * own sim finishes. So `verifySettledMatch` routinely finds nothing, the
       * net goes in as zero, and the slot is spent: every later attempt is a duplicate
       * and the money is never credited at all. The one column that is
       * chain-verified was the one column guaranteed to be wrong.
       *
       * So the row records that W/L was counted, and separately whether the
       * money was. A repeat post is still refused a second W/L — but if the
       * money is still owed, it is allowed to settle that and nothing else.
       */
      const creditId = `${mid}:${address}`;
      try {
        await credits.insertOne({ _id: creditId, at: new Date(), moneyCredited: false });
      } catch (e) {
        if (e?.code !== 11000) throw e;
        const prior = await credits.findOne({ _id: creditId });
        if (prior?.moneyCredited) {
          return res.json({ ok: true, duplicate: true, note: 'already recorded' });
        }
        const late = await verifySettledMatch(mid, address).catch(() => null);
        if (!late) {
          return res.json({
            ok: true, duplicate: true, pending: true,
            note: 'counted; the chain has not shown this settlement yet',
          });
        }
        await credits.updateOne(
          { _id: creditId },
          { $set: { moneyCredited: true, creditedAt: new Date() } },
        );
        await leaderboard.updateOne({ _id: address }, { $inc: { [NET_FIELD[late.currency]]: late.net } });
        return res.json({ ok: true, duplicate: true, credited: late.net, currency: late.currency });
      }
      verified = await verifySettledMatch(mid, address).catch(() => null);
      if (verified) {
        await credits.updateOne({ _id: creditId }, { $set: { moneyCredited: true } });
      }
    }
    await leaderboard.updateOne(
      { _id: address },
      {
        $inc: {
          matches: 1,
          wins: won ? 1 : 0,
          losses: !won && !draw ? 1 : 0,
          draws: draw ? 1 : 0,
          // Only when money actually moved, and only in the currency it moved
          // in. `pot` is what the tier says a pot is worth and is present
          // whether or not escrow opened, so counting it unconditionally made
          // this column a running total of money that never existed — a
          // guest's unstaked wins included.
          netMon: verified?.currency === 'MON' ? verified.net : 0,
          netAusd: verified?.currency === 'AUSD' ? verified.net : 0,
          /*
           * Bounded, because three towers is all there are.
           *
           * A side has two princess towers and a king, so a match can yield at
           * most three crowns. The clan route already clamps this exact value
           * to 0..3; this one took it straight from the body, so the same
           * number was bounded in one place and unbounded in the other and a
           * client could report `crowns: [999999]` to inflate its column on the
           * public board. Money on that board is chain-verified — this is the
           * one column that was not.
           */
          crowns: Array.isArray(crowns) ? num(crowns[0], 0, 3) : 0,
        },
        $set: { updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    await players.updateOne(
      { _id: address },
      {
        $push: {
          history: {
            $each: [{
              won: !!won,
              draw: !!draw,
              pot: Number(pot) || 0,
              payout: Number(payout) || 0,
              rake: Number(rake) || 0,
              currency: CURRENCIES.includes(currency) ? currency : null,
              crowns,
              at: now,
            }],
            $position: 0,
            $slice: 50,
          },
        },
      },
    );
    // The funnel's fourth step. Emitted here rather than from the client
    // because this route is the moment a match becomes a record — a browser
    // that closes on the result screen would otherwise never report having
    // played, and "played a match" would read zero while the leaderboard filled
    // up behind it.
    recordEvent(db, {
      type: 'match.end',
      address,
      /**
       * Enough to answer the operational questions without a second query.
       *
       * `voided` is the one that matters most: a lockstep game that silently
       * annuls matches is failing in the way its players will notice first, and
       * a rate nobody is watching is a rate nobody fixes. `hashes` is the
       * checkpoint count, which stands in for how long the match ran.
       */
      props: {
        won: !!won,
        draw: !!draw,
        staked: !!escrowed,
        voided: !!voided,
        currency: verified?.currency ?? (CURRENCIES.includes(currency) ? currency : null),
        pot: Number(pot) || 0,
        rake: Number(rake) || 0,
        hashes: Number(hashes) || 0,
      },
    });
    // An escrowed match the chain has not settled yet is the normal case for a
    // first report. Say so: the client retries only on `pending`, and without
    // it the money for this win would never be credited.
    if (escrowed && validId && !verified) {
      return res.json({ ok: true, pending: true, note: 'counted; the chain has not shown this settlement yet' });
    }
    res.json({ ok: true, ...(verified ? { credited: verified.net, currency: verified.currency } : {}) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Trophy ladder ───────────────────────────────────────────────────────────
// The server is the authority: it is the only party that sees both sides of a
// match. The client computes the same Elo optimistically so the result screen
// is instant, then reconciles with whatever comes back from here.

/** One player's ladder standing, plus their rank. */
app.get('/api/ladder/:address', async (req, res) => {
  const address = paramAddress(req);
  if (!address) return res.status(400).json({ error: 'bad address' });
  try {
    const doc = await ladder.findOne({ _id: address });
    const trophies = doc?.trophies ?? 0;
    // Rank is derived, never stored — a stored rank is stale the moment anyone
    // else plays a match.
    const above = await ladder.countDocuments({ trophies: { $gt: trophies } });
    res.json({
      address,
      trophies,
      best: doc?.best ?? trophies,
      wins: doc?.wins ?? 0,
      losses: doc?.losses ?? 0,
      draws: doc?.draws ?? 0,
      streak: doc?.streak ?? 0,
      bestStreak: doc?.bestStreak ?? 0,
      league: leagueFor(trophies).name,
      rank: doc ? above + 1 : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Apply one ranked result. Returns the new standing. */
app.post('/api/ladder/:address', requireWallet('ladder.post'), async (req, res) => {
  const address = req.wallet;
  const { outcome, pairKey } = req.body ?? {};
  if (!['win', 'loss', 'draw'].includes(outcome)) {
    return res.status(400).json({ error: 'bad outcome' });
  }
  try {
    /*
     * A rating change has to correspond to a pairing this relay made.
     *
     * The header of this file says the server "is the only party that sees
     * both sides of a match", and the client repeats it — but the ranked
     * ladder was written from a body the winner authored: `outcome` and
     * `opponentTrophies` both came from the caller, with no opponent, no match
     * reference and no idempotency. Any wallet could walk itself to rank one
     * without playing. Seeing both sides and writing none of it down is the
     * same as not seeing it.
     *
     * The matchmaker now records each pairing under a token only the two
     * sockets receive. A report cites it; the opponent's rating is read from
     * that record rather than the body; and the Elo is applied only once both
     * seats have reported and their accounts agree — the same "both must say
     * the same thing" rule settlement uses on chain. One seat cannot move its
     * own rating, and neither can two seats who disagree.
     */
    const pair = pairKey ? await pairings.findOne({ _id: String(pairKey) }) : null;
    if (!pair) {
      return res.status(409).json({ error: 'no such pairing — a rating needs a match the relay saw' });
    }
    const seat = (pair.seats ?? []).indexOf(address);
    if (seat === -1) return res.status(403).json({ error: 'you did not play in that match' });
    if (pair.reports?.[String(seat)]) {
      return res.json({ ok: true, duplicate: true, note: 'already reported' });
    }

    await pairings.updateOne({ _id: pair._id }, { $set: { [`reports.${seat}`]: outcome } });
    const mine = outcome;
    const theirs = pair.reports?.[String(1 - seat)] ?? null;
    if (!theirs) {
      // First to report. Nothing moves until the other seat agrees.
      return res.json({ ok: true, pending: true, note: 'waiting for your opponent to report' });
    }
    const agreed = (mine === 'win' && theirs === 'loss')
      || (mine === 'loss' && theirs === 'win')
      || (mine === 'draw' && theirs === 'draw');
    if (!agreed) {
      await pairings.updateOne({ _id: pair._id }, { $set: { disputed: true } });
      return res.status(409).json({ error: 'the two players reported different results — no rating change' });
    }

    /*
     * Score both seats, not just whoever spoke second.
     *
     * The agreement is what makes the result real, and it becomes true on the
     * second report — so scoring only the caller left the seat that reported
     * first with no rating at all. Their own report is the one that had to
     * wait; it should not also be the one that goes unpaid.
     */
    const now = new Date();
    const scoreSeat = async (who, theirOutcome, oppRating) => {
      const d = await ladder.findOne({ _id: who });
      const was = d?.trophies ?? 0;
      const r = applyMatch(was, num(oppRating, 0, 100_000), theirOutcome);
      const st = theirOutcome === 'win' ? (d?.streak ?? 0) + 1
        : theirOutcome === 'loss' ? 0
          : (d?.streak ?? 0);
      await ladder.updateOne(
        { _id: who },
        {
          $set: {
            trophies: r.after,
            best: Math.max(d?.best ?? 0, r.after),
            streak: st,
            bestStreak: Math.max(d?.bestStreak ?? 0, st),
            updatedAt: now,
          },
          $inc: {
            wins: theirOutcome === 'win' ? 1 : 0,
            losses: theirOutcome === 'loss' ? 1 : 0,
            draws: theirOutcome === 'draw' ? 1 : 0,
            matches: 1,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
      return { doc: d, ...r, streak: st };
    };

    // Both are scored against the ratings the relay recorded at pairing time,
    // so neither depends on the order the two reports happened to arrive in.
    const mineScored = await scoreSeat(address, mine, pair.trophies?.[1 - seat]);
    await scoreSeat(pair.seats[1 - seat], theirs, pair.trophies?.[seat]);
    await pairings.updateOne({ _id: pair._id }, { $set: { settled: true } });

    const { doc } = mineScored;
    const { delta, after, floored, streak } = mineScored;

    const above = await ladder.countDocuments({ trophies: { $gt: after } });
    res.json({
      trophies: after,
      delta,
      floored,
      best: Math.max(doc?.best ?? 0, after),
      wins: (doc?.wins ?? 0) + (outcome === 'win' ? 1 : 0),
      losses: (doc?.losses ?? 0) + (outcome === 'loss' ? 1 : 0),
      streak,
      league: leagueFor(after).name,
      rank: above + 1,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** The ladder itself — top players by trophies. */
app.get('/api/ladder', async (_req, res) => {
  try {
    const rows = await ladder.find({}).sort({ trophies: -1 }).limit(50).toArray();
    res.json({
      players: rows.map((r, i) => ({
        rank: i + 1,
        address: r._id,
        name: r.name ?? null,
        trophies: r.trophies ?? 0,
        best: r.best ?? 0,
        wins: r.wins ?? 0,
        losses: r.losses ?? 0,
        streak: r.streak ?? 0,
        league: leagueFor(r.trophies ?? 0).name,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Top players by chain-verified winnings — powers the Empire leaderboard.
 *
 * `?currency=MON` (default) or `?currency=AUSD` picks the column to rank by.
 * Both columns ride on every row; they are never added together.
 */
app.get('/api/leaderboard', async (req, res) => {
  const currency = String(req.query.currency ?? 'MON').toUpperCase();
  if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'currency must be MON or AUSD' });
  try {
    const rows = await leaderboard
      .find({}, { projection: { netMon: 1, netAusd: 1, wins: 1, losses: 1, crowns: 1, matches: 1 } })
      .sort({ [NET_FIELD[currency]]: -1 })
      .limit(25)
      .toArray();
    res.json(rows.map(({ _id, ...r }) => ({
      address: _id, netMon: 0, netAusd: 0, wins: 0, losses: 0, crowns: 0, matches: 0, ...r,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/*
 * Boot, and say why if it does not.
 *
 * This is a top-level await, so anything thrown inside surfaces as a bare
 * module-evaluation rejection: a raw stack trace, exit code 1, and nothing
 * naming which of the several things this block does actually failed. The
 * `uncaughtException` handlers installed further down are no help, because a
 * top-level-await rejection is not routed through them. On Railway that is
 * five silent restarts and a dead service.
 *
 * The most likely causes are ordinary and worth naming out loud: Mongo
 * unreachable, or a data file the image did not ship.
 */
const server = await (async () => {
  if (client) {
    await client.connect();
    db = client.db(MONGODB_DB);
  } else {
    db = createMemoryDb(MONGODB_DB);
  }
  players = db.collection('players');
  leaderboard = db.collection('leaderboard');
  ladder = db.collection('ladder');
  pairings = db.collection('ladder_pairings');
  /*
   * One settled match, counted once.
   *
   * `verifySettledMatch` proves a claimed pot really happened on chain, which
   * stopped invented payouts — but it says nothing about how many times the
   * same real match has been reported. Every field below is an `$inc`, and the
   * signature on the request proves identity rather than novelty, so a client
   * could sign a hundred fresh requests all describing its one genuine win and
   * add its payout to the money board a hundred times.
   *
   * The id is per (match, player) because both seats legitimately report the
   * same match from their own side.
   */
  credits = db.collection('match_credits');
  await credits.createIndex({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });
  await leaderboard.createIndex({ netMon: -1 });
  await leaderboard.createIndex({ netAusd: -1 });
  // Both the ladder listing and every rank lookup sort on this.
  await ladder.createIndex({ trophies: -1 });
  registerClanRoutes(app, db);

  // Onboarding: the starter deck, AUSD and the MON drip, signed by the
  // relayer. Registers either way and reports itself unavailable (503) when
  // this chain has no deployment or no relayer key, rather than 404ing.
  registerOnboardRoutes(app, db, { ipGate: onboardGate, readGate });
  registerPlayerRoutes(app, db);
  registerPrivyRoutes(app);
  registerLockerRoutes(app, db, { gate: (req, res, next) => (readLimit ? readLimit(req, res, next) : next()) });
  registerTelemetryRoutes(app, db, requireWallet);
  registerInsightRoutes(app, db);
  registerOpsRoutes(app, db);

  // Now that there is a database, the shared limiter can take over from the
  // pass-through installed at module load.
  limit = rateLimiter(db);
  // Generous — these are legitimate polls and card renders — but bounded, and
  // reads count because reads are what costs.
  readLimit = rateLimiter(db, { capacity: 60, refillPerSec: 2, includeReads: true });
  // Ten signed attempts, then one a minute, per IP.
  onboardLimit = rateLimiter(db, { capacity: 10, refillPerSec: 1 / 60 });
  setWalletLimiter(walletLimiter(db));

  // Replay protection: one row per seen signature, expiring shortly after the
  // auth skew window closes so the collection stays tiny. The unique index is
  // the actual check — a duplicate insert throws, and that throw means replay.
  const seen = db.collection('auth_signatures');
  await seen.createIndex({ sig: 1 }, { unique: true });
  await seen.createIndex({ at: 1 }, { expireAfterSeconds: 11 * 60 });
  setReplayStore(async (signature) => {
    try {
      await seen.insertOne({ sig: String(signature), at: new Date() });
      return false;
    } catch (e) {
      if (e?.code === 11000) return true; // duplicate key = replay
      return false; // store trouble must not lock every player out
    }
  });
  // Last, deliberately: Express only routes an error to a four-argument
  // handler registered after everything that could throw.
  app.use(errorRecorder(db).middleware);

  console.log(client ? `mongo connected → ${MONGODB_DB}` : 'store: in-memory');
  console.log(`chain ${CHAIN_ID} via ${RPC_URL} · ${deployment ? 'deployment loaded' : 'no deployment for this chain'}`);
  const httpServer = app.listen(PORT, () => console.log(`mempire api on :${PORT}`));
  registerMatchmaker(httpServer, db);
  startKeeper();
  return httpServer;
})().catch((e) => {
  console.error(`startup failed: ${e?.message ?? e}`);
  if (String(e?.name ?? '').startsWith('Mongo')) {
    console.error('  the database was unreachable — check MONGODB_URI and the Atlas IP allowlist');
  }
  if (e?.code === 'ENOENT') {
    console.error(`  a file this build needs is not in the image: ${e.path ?? '(unknown)'}`);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await client?.close();
    process.exit(0);
  });
}
