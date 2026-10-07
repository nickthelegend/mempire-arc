/**
 * Human matchmaking — the WebSocket half of the API.
 *
 * The clients run the same deterministic lockstep sim; this service never
 * simulates anything. It does exactly three jobs:
 *
 *  1. **Pair** two queued players in the same tier and hand both the same
 *     match id, seed and start time.
 *  2. **Relay** card-play inputs between them, untouched.
 *  3. **Referee hashes.** Both clients report a state hash every 40 ticks;
 *     the first mismatched pair means the sims diverged, and both sides are
 *     told to void the match. A voided match returns stakes and rakes nothing
 *     — divergence is detected and neutralised, never silently ignored.
 *
 * The seed mixes the match id, both deck commitments and a fresh server-side
 * random word, so neither player — nor this server picking who is player 0 —
 * can grind a favourable opening hand. It is chosen here at pairing time for
 * every match, staked or not: both clients start the battle at the shared
 * `startAt` while the arena's create and join transactions are still in
 * flight, so the seed has to exist before the chain knows about the match.
 */
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { wsVerified } from './auth.js';
import { abis, deployment, normAddress, publicClient } from './chain.js';

const TIERS = 4;
/** The arena's two stake currencies. Both seats of an escrow must use the same one. */
const CURRENCIES = ['MON', 'AUSD'];

/*
 * The market-meta epoch, read at most every thirty seconds.
 *
 * `MarketMeta` posts a bounded stat modifier per fighter each epoch, and the
 * sim applies them — so two clients simulating with different epochs are
 * simulating different games, which is a desync with extra steps. The relay
 * reads the epoch once per pairing and hands both seats the identical number.
 * A stale read is fine (an epoch lasts far longer than thirty seconds); a
 * failed one falls back to 0, the unmodified game, which both seats then
 * share as well.
 */
const EPOCH_TTL_MS = 30_000;
let epochCache = { at: 0, value: 0 };
let epochInflight = null;
async function currentMetaEpoch() {
  if (!deployment?.marketMeta) return 0;
  if (Date.now() - epochCache.at < EPOCH_TTL_MS) return epochCache.value;
  epochInflight ??= publicClient().readContract({
    address: deployment.marketMeta, abi: abis.marketMeta, functionName: 'currentEpoch',
  })
    .then((v) => { epochCache = { at: Date.now(), value: Number(v) }; return epochCache.value; })
    .catch(() => 0)
    .finally(() => { epochInflight = null; });
  // Bounded: a slow RPC must not hold two players on the pairing screen.
  return Promise.race([epochInflight, new Promise((r) => { setTimeout(() => r(0), 3_000).unref?.(); })]);
}

/**
 * How far apart two ratings may be, widening with wait time. Mirrors
 * `ratingBand` in `app/src/lib/ranking.ts`; uncapped after a minute so the
 * queue always drains — an empty ladder is the real failure, not an uneven match.
 */
function ratingBand(waitedMs) {
  if (waitedMs >= 60_000) return Number.POSITIVE_INFINITY;
  return 200 + Math.floor(Math.max(0, waitedMs) / 1000) * 25;
}
const HASH_WINDOW = 400; // remember this many recent checkpoint ticks per match

/**
 * A deck is eight {coinId, name, archetype, level} entries. Validated here not
 * to enforce game rules — the sims do that — but because this payload is
 * relayed verbatim into the *other* player's createMatch. Junk must fail at
 * the door of the sender, never in the runtime of their opponent.
 *
 * `coinId` is the roster's numeric id; a short string id is still accepted for
 * decks built from local, unminted cards.
 */
// A fighter is identified by its Pyth feed id: 0x plus 64 hex digits.
const validCoinId = (id) => (Number.isSafeInteger(id) && id >= 0)
  || (typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id));
function validDeck(deck) {
  return Array.isArray(deck) && deck.length === 8 && deck.every((c) => c
    && validCoinId(c.coinId)
    && typeof c.name === 'string' && c.name.length <= 24
    && Number.isInteger(c.archetype) && c.archetype >= 0 && c.archetype <= 5
    && Number.isInteger(c.level) && c.level >= 1 && c.level <= 10);
}

/** ~4 plays/second sustained is beyond any human; beyond it is a flood. */
const INPUT_BUCKET = { capacity: 12, refillPerSec: 4 };

/** FNV-1a over a string, matching the client's hash discipline. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

let nextMatchId = 1;

export function registerMatchmaker(server, db) {
  /*
   * What the relay saw, written down so the ladder can be checked against it.
   *
   * The header above claims "the server is the authority: it is the only party
   * that sees both sides of a match", and the ranked ladder was written from a
   * body the winner authored — no opponent, no match reference, no idempotency.
   * Seeing both sides and never recording it is the same as not seeing it. A
   * pairing row is the record: who was paired, at what ratings, under a token
   * neither client can guess.
   */
  const pairings = db ? db.collection('ladder_pairings') : null;
  if (pairings) {
    // A pairing is only interesting until both seats have reported.
    pairings.createIndex({ at: 1 }, { expireAfterSeconds: 3600 }).catch(() => {});
  }
  /*
   * Bound what one socket can make this process hold.
   *
   * `ws` defaults `maxPayload` to 100 MiB, and nothing here authenticates a
   * socket before it may send — so any anonymous client could open a handful
   * of connections and have the relay buffer hundreds of megabytes of frame
   * it was always going to reject, which is a memory kill on a small dyno for
   * the price of a few TCP handshakes. The largest legitimate message is a
   * queue entry carrying an eight-card deck; 64 KiB is orders of magnitude of
   * headroom over that, and anything past it is closed rather than buffered.
   */
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  /** tier → { ws, address, name, power, deck, deckHash } */
  const queues = new Map();
  /** matchId → { players: [wsA, wsB], addr: [a, b], hashes: Map<tick, [hA, hB]>, done } */
  const matches = new Map();

  const send = (ws, msg) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  function leaveQueue(ws) {
    for (const [key, list] of queues) {
      const i = list.findIndex((e) => e.ws === ws);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) queues.delete(key);
    }
  }

  /**
   * Players only meet inside the same pool.
   *
   * Format is non-negotiable — a 30-second Rush seated against a 3-minute
   * standard match would desync on the first tick, because the sim's timing
   * lives in the format. Ranked is separate so a ladder match is never paired
   * with a casual one, and tier and currency keep stakes equal: the arena
   * makes the joiner match the opener's stake exactly, so a MON player paired
   * with an AUSD player is a join that can only revert.
   */
  const queueKey = (tier, currency, format, ranked) => `${tier}:${currency}:${format}:${ranked ? 'r' : 'c'}`;

  /**
   * Picks the closest-rated waiting opponent inside the band.
   *
   * The band widens with wait time (see `ratingBand`), because a perfect match
   * nobody ever gets is worse than a slightly uneven one in twenty seconds.
   * Closest-first rather than first-in so a crowded queue still pairs fairly.
   */
  function findOpponent(list, address, trophies, now) {
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i];
      if (e.ws.readyState !== 1) continue;
      // Same wallet in both seats is a self-match; the arena refuses it on
      // chain (`SelfMatch`), so the matchmaker refuses it here too.
      if (e.address === address) continue;
      const gap = Math.abs((e.trophies ?? 0) - trophies);
      // Either side having waited long enough is sufficient — the player who
      // has been waiting is the one whose patience should widen the band.
      if (gap > Math.max(ratingBand(now - e.since), ratingBand(0))) continue;
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    return best;
  }

  function endMatch(id) {
    const m = matches.get(id);
    if (m) { m.done = true; matches.delete(id); }
  }

  function opponentOf(m, ws) {
    return m.players[0] === ws ? m.players[1] : m.players[0];
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    /**
     * Round-trip time, measured off the heartbeat we already send.
     *
     * The lockstep input delay has to cover a real round trip: client → here →
     * opponent. Guessing it as a client-side constant is how a match between
     * two distant players voided on the first card either of them played —
     * every remote input arrived after the tick it was stamped for. The server
     * is the only party that can see both connections, so it measures and
     * decides.
     */
    ws.rttMs = 0;
    ws.pingedAt = 0;

    /**
     * Measure immediately, not on the next heartbeat.
     *
     * The reaper pings every 30 seconds, and a player who connects and gets
     * matched inside that window has never been pinged — so `rttMs` was still
     * zero exactly when the input delay had to be chosen, and every match fell
     * back to the 20-tick floor no matter how far away the players were. The
     * adaptive delay was real and never once adapted.
     *
     * Three quick samples in the first two seconds: matchmaking takes longer
     * than that, so by the time a pairing happens there is a real number.
     */
    for (const delay of [0, 700, 1500]) {
      setTimeout(() => {
        if (ws.readyState !== ws.OPEN) return;
        ws.pingedAt = Date.now();
        try { ws.ping(); } catch { /* closing */ }
      }, delay);
    }
    ws.on('pong', () => {
      ws.isAlive = true;
      if (ws.pingedAt) {
        const sample = Date.now() - ws.pingedAt;
        // Exponential smoothing: one slow sample should nudge the estimate,
        // not redefine it.
        ws.rttMs = ws.rttMs ? Math.round(ws.rttMs * 0.6 + sample * 0.4) : sample;
        ws.pingedAt = 0;
      }
    });

    /*
     * Messages are handled strictly in arrival order, per socket.
     *
     * Verifying a queue signature is asynchronous, and without this a `queue`
     * followed at once by `cancel` could finish in the other order — the
     * player cancels, and is then queued anyway by the message they sent
     * first. Chaining each socket's handlers keeps the protocol sequential
     * without making one slow socket wait for any other.
     */
    ws.inbox = Promise.resolve();
    ws.on('message', (raw) => {
      ws.inbox = ws.inbox.then(() => handle(raw)).catch(() => { /* one bad frame must not stall the socket */ });
    });

    const handle = async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      switch (msg.t) {
        case 'queue': {
          const tier = Number(msg.tier);
          if (!Number.isInteger(tier) || tier < 0 || tier >= TIERS) return;
          /*
           * TODO(security): this address is asserted, not proved.
           *
           * History: requiring a signature here was deployed and reverted
           * twice, because the client never sent one and enforcement took
           * live PvP down with it. The client now signs its queue payload
           * (see match.ts), so verification finally lands below — as a
           * demotion to casual rather than a rejection, which keeps the
           * failure mode "cannot rank" instead of "cannot play".
           */
          const address = normAddress(msg.address);
          if (!address || !validDeck(msg.deck)) return;
          const currency = CURRENCIES.includes(String(msg.currency).toUpperCase())
            ? String(msg.currency).toUpperCase() : 'MON';

          /*
           * Ranked play requires a proven address; casual does not.
           *
           * The client now signs its queue (action 'queue', same scheme as
           * every HTTP write), so the enforcement that was reverted twice for
           * breaking pairing can land as a demotion instead of a rejection:
           * an unsigned or badly-signed queue still plays, it just cannot
           * touch the ladder — which is the thing an impersonated address
           * could damage. The `queued` ack already reports the ranked flag
           * back, so the client knows which game it is in.
           */
          if (msg.ranked && !(await wsVerified(msg, 'queue'))) msg.ranked = false;
          // A socket already in a live match cannot queue for another — that
          // would orphan the first match's opponent mid-battle.
          if (matches.has(ws.matchId)) return;
          leaveQueue(ws); // one queue slot per socket

          const format = msg.format === 'rush' ? 'rush' : 'standard';
          const ranked = Boolean(msg.ranked);
          const trophies = Number.isFinite(Number(msg.trophies)) ? Number(msg.trophies) : 0;
          const key = queueKey(tier, currency, format, ranked);
          const list = queues.get(key) ?? [];
          const now = Date.now();

          const idx = findOpponent(list, address, trophies, now);
          if (idx >= 0) {
            const waiting = list[idx];
            list.splice(idx, 1);
            if (!list.length) queues.delete(key); else queues.set(key, list);
            const id = nextMatchId;
            nextMatchId += 1;
            /*
             * Order-independent, and not grindable by either side.
             *
             * Every input to this used to be chosen by the players: `deckHash`
             * is a string the client sends and nothing here validates it
             * against the deck it claims to describe, so a player could resend
             * a queue message with a tweaked hash until the resulting seed
             * dealt them an opening hand they liked. The seed drives both
             * players' draw cycles, so that is a real edge bought with nothing
             * but retries.
             *
             * Mixing in a word neither client can see or predict removes the
             * grind entirely while keeping the property the two hashes were
             * there for: neither seat benefits from being the one who waited.
             */
            const seed = (
              fnv(`${id}`)
              ^ fnv(String(msg.deckHash ?? ''))
              ^ fnv(String(waiting.deckHash ?? ''))
              ^ randomBytes(4).readUInt32LE(0)
            ) >>> 0;
            // `startAt` is an instant on the *server's* clock, and each client
            // used to compare it against its own `Date.now()`. A wallet whose
            // machine is thirty seconds off then targets a tick six hundred
            // ahead of its opponent, the state hashes diverge, and a staked
            // match voids — for nothing but an unsynchronised clock, which is
            // ordinary on desktops that have been asleep.
            //
            // `serverNow` is stamped alongside it so each client can measure
            // its own offset and step against the same shared clock.
            const startAt = Date.now() + 2200; // both clients count down to this
            const serverNow = Date.now();

            /**
             * The input delay, in 50ms ticks, for this pairing.
             *
             * Sized to the *worse* of the two connections and doubled for
             * headroom, because a card has to reach the far client before the
             * tick it is stamped for or the match voids. Floors at 20 ticks
             * (1s) so a pair of suspiciously fast RTT samples cannot produce a
             * delay too tight to survive one slow moment, and caps at 60 (3s)
             * because beyond that the game stops feeling responsive and a
             * player is better served by being told their connection is poor.
             *
             * Sent in `matched`, so both clients take the identical value —
             * two clients each measuring their own would disagree, and a
             * disagreement about which tick an input lands on is precisely a
             * desync.
             */
            const worstRtt = Math.max(waiting.ws.rttMs ?? 0, ws.rttMs ?? 0);
            // No sample yet — a socket that matched faster than its first pong
            // came back. Assume a poor link rather than a good one: too much
            // delay costs responsiveness, too little voids the match outright.
            const assumed = worstRtt || 600;
            /**
             * Floor of 40 ticks — two seconds.
             *
             * A protocol-level ping/pong measures the *network*, and the number
             * that actually matters is the whole application path: one client's
             * sim stamps a tick, the frame is serialised, queued, relayed, and
             * the far client parses it and finds a place for it before its own
             * sim passes that tick. Measured on a live match against a US relay
             * from South Asia, that path ran 1650ms while the ping said a few
             * hundred — so a delay sized from the ping voided the match, and the
             * client said exactly how: "an input arrived 13 ticks (650ms) too
             * late to stay in lockstep".
             *
             * Two seconds is sluggish and it is honest. Moving the relay nearer
             * the players is what buys the responsiveness back; guessing low
             * here just loses the match.
             */
            /**
             * Floor of 16 ticks — 800ms.
             *
             * It was 40 (two seconds), sized for a relay on the other side of
             * the planet where a card's whole journey measured 1650ms. With
             * the relay in Singapore the round trip is under 100ms, and two
             * seconds of input delay is a game that feels broken rather than a
             * game that is.
             *
             * Sixteen is still an order of magnitude more than the measured
             * trip. The margin is not for the network — it is for the far
             * client having a bad frame, which the tick gate now bounds
             * anyway: neither sim may run further than this ahead of the
             * other, so an input can always still be placed when it lands.
             */
            const inputDelayTicks = Math.min(80, Math.max(16, Math.ceil((assumed * 3) / 50)));
            const m = {
              players: [waiting.ws, ws],
              addr: [waiting.address, address],
              hashes: new Map(),
              done: false,
              createdAt: Date.now(),
            };
            matches.set(id, m);
            waiting.ws.matchId = id;
            ws.matchId = id;

            /*
             * A token for this pairing, which only these two sockets receive.
             *
             * It is what a ladder report has to cite. Random rather than the
             * match id, because the id is a counter a client could guess and
             * the whole point is that a rating change must correspond to a
             * pairing this relay actually made.
             */
            const pairKey = randomBytes(16).toString('hex');
            if (pairings) {
              pairings.insertOne({
                _id: pairKey,
                seats: [waiting.address, address],
                trophies: [waiting.trophies ?? 0, trophies],
                ranked: Boolean(msg.ranked) && Boolean(waiting.ranked),
                reports: {},
                at: new Date(),
              }).catch(() => { /* the ladder simply refuses reports it cannot verify */ });
            }

            /*
             * Everything above is synchronous: both entries are out of the
             * queue and the room exists before this first await, so no other
             * message can pair either socket again while the epoch is read.
             * One read, one number, sent to both.
             */
            const metaEpoch = await currentMetaEpoch();
            send(waiting.ws, {
              t: 'matched', matchId: id, pairKey, role: 0, seed: seed || 0x9e3779b9, startAt, serverNow, inputDelayTicks, format,
              currency, metaEpoch,
              opponent: {
                address, name: msg.name ?? null,
                power: msg.power ?? 0, deck: msg.deck, trophies,
              },
            });
            send(ws, {
              t: 'matched', matchId: id, pairKey, role: 1, seed: seed || 0x9e3779b9, startAt, serverNow, inputDelayTicks, format,
              currency, metaEpoch,
              opponent: {
                address: waiting.address, name: waiting.name ?? null,
                power: waiting.power ?? 0, deck: waiting.deck, trophies: waiting.trophies ?? 0,
              },
            });
          } else {
            list.push({
              ws, address, name: msg.name ?? null,
              power: msg.power ?? 0, deck: msg.deck, deckHash: msg.deckHash ?? '',
              trophies, since: now,
            });
            queues.set(key, list);
            send(ws, { t: 'queued', ranked, format, currency });
          }
          break;
        }

        case 'cancel': {
          leaveQueue(ws);
          send(ws, { t: 'cancelled' });
          break;
        }

        case 'input': {
          const m = matches.get(ws.matchId);
          if (!m || m.done) return;
          const i = msg.input;
          /*
           * Integers, in range, and from the seat that actually sent it.
           *
           * `Number.isFinite` let 1.5 through, and a fractional deckIndex walks
           * past every bounds check in the engine before throwing inside the
           * tick loop — which freezes the opponent's match permanently. The
           * relay does not need to be a rules engine to refuse a value that is
           * not the shape of a play.
           *
           * The seat is overwritten rather than trusted: it is the one field
           * the relay knows better than the sender, and leaving it to the
           * client let either player forge a frame from the other seat.
           */
          if (!i || typeof i !== 'object') return;
          if (![i.tick, i.player, i.deckIndex, i.x, i.y].every(Number.isInteger)) return;
          if (i.deckIndex < 0 || i.deckIndex >= 8) return;
          if (i.tick <= 0 || i.tick > 100_000) return;
          if (Math.abs(i.x) > 1e6 || Math.abs(i.y) > 1e6) return;
          // Token bucket per socket: a flooding client gets its excess dropped
          // here instead of amplified into the opponent's tab.
          const now = Date.now();
          ws.tokens = Math.min(
            INPUT_BUCKET.capacity,
            (ws.tokens ?? INPUT_BUCKET.capacity) + ((now - (ws.tokensAt ?? now)) / 1000) * INPUT_BUCKET.refillPerSec,
          );
          ws.tokensAt = now;
          if (ws.tokens < 1) return;
          ws.tokens -= 1;
          const seat = m.players[0] === ws ? 0 : 1;
          send(opponentOf(m, ws), {
            t: 'input',
            // Rebuilt, not forwarded: extra keys of any size used to be
            // re-serialised straight into the opponent's socket.
            input: { tick: i.tick, player: seat, deckIndex: i.deckIndex, x: i.x, y: i.y },
          });
          break;
        }

        /**
         * Escrow handshake, relayed verbatim.
         *
         * Seat 0 opens the match on the arena and has to tell seat 1 which match
         * id to join — there is no other channel between two browsers, and the
         * id is only knowable after the create transaction lands.
         *
         * Deliberately not validated beyond its shape and not acted on: the
         * relay must never become a second authority on an escrow the chain
         * already owns. Both clients read `getMatch` themselves before staking
         * anything, so a lying peer costs nothing but a refused join.
         */
        case 'chain': {
          const m = matches.get(ws.matchId);
          if (!m || m.done) return;
          const stage = String(msg.stage ?? '');
          if (!['opened', 'joined', 'failed'].includes(stage)) return;
          const id = Number(msg.onchainMatchId);
          const txHash = typeof msg.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(msg.txHash)
            ? msg.txHash : null;
          send(opponentOf(m, ws), {
            t: 'chain',
            stage,
            onchainMatchId: Number.isSafeInteger(id) && id > 0 ? id : null,
            txHash,
            reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 120) : null,
          });
          break;
        }

        /**
         * A seat's current tick, relayed verbatim.
         *
         * Lockstep only holds if neither sim runs more than the input delay
         * ahead of the other. Without this the two drift — a GC pause, a
         * background tab, a slow frame — and once a client is far enough
         * ahead, inputs stamped by the *slower* one arrive for ticks it has
         * already simulated, and the match voids. Padding the delay only moves
         * the threshold; telling each client where the other actually is
         * removes the drift.
         */
        case 'tick': {
          const m = matches.get(ws.matchId);
          if (!m || m.done) return;
          const tick = Number(msg.tick);
          if (!Number.isFinite(tick) || tick < 0) return;
          send(opponentOf(m, ws), { t: 'tick', tick });
          break;
        }

        case 'hash': {
          const m = matches.get(ws.matchId);
          if (!m || m.done) return;
          const tick = Number(msg.tick);
          const hash = Number(msg.hash) >>> 0;
          if (!Number.isInteger(tick)) return;
          const side = m.players[0] === ws ? 0 : 1;
          const pair = m.hashes.get(tick) ?? [null, null];
          pair[side] = hash;
          m.hashes.set(tick, pair);
          if (pair[0] !== null && pair[1] !== null) {
            if (pair[0] !== pair[1]) {
              // The one unacceptable outcome is two players seeing two
              // different games and one of them paying for it.
              send(m.players[0], { t: 'desync', tick });
              send(m.players[1], { t: 'desync', tick });
              endMatch(ws.matchId);
            } else {
              m.hashes.delete(tick);
            }
          }
          // bound memory on a match that never reports the same tick twice
          if (m.hashes.size > HASH_WINDOW) {
            const oldest = Math.min(...m.hashes.keys());
            m.hashes.delete(oldest);
          }
          break;
        }

        case 'ended': {
          // Either side reporting a finished sim closes the room; the clients
          // settle locally and record results through the HTTP API.
          endMatch(ws.matchId);
          break;
        }

        default:
          break;
      }
    };

    ws.on('close', () => {
      leaveQueue(ws);
      const m = matches.get(ws.matchId);
      if (m && !m.done) {
        // A vanished opponent is a forfeit, and the survivor is told so.
        send(opponentOf(m, ws), { t: 'opponent_left' });
        endMatch(ws.matchId);
      }
    });
  });

  // Reap dead sockets so a phone that lost signal frees its queue slot, and
  // sweep match rooms whose clients both vanished without a close frame — a
  // match outlives regulation + overtime + grace at 10 minutes, never longer.
  const MATCH_TTL_MS = 10 * 60_000;
  const reaper = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.pingedAt = Date.now();
      ws.ping();
    }
    const now = Date.now();
    for (const [id, m] of matches) {
      if (now - (m.createdAt ?? 0) > MATCH_TTL_MS) matches.delete(id);
    }
  }, 30_000);
  wss.on('close', () => clearInterval(reaper));

  console.log('matchmaker on /ws');
  return wss;
}
