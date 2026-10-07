/**
 * The event trail: what happened, to whom, when.
 *
 * # Why a separate collection
 *
 * `players` holds current state — one row per wallet, overwritten. That answers
 * "what does this player have" and nothing else. It cannot answer how many
 * people arrived yesterday, how many of them minted a card, how many of those
 * reached a staked match, or where the rest stopped. Those are questions about
 * *transitions*, and a table of current values has already thrown the
 * transitions away.
 *
 * So every meaningful action is also appended here, immutably.
 *
 * # Deliberate constraints
 *
 * - **Never blocks the request.** `recordEvent` returns immediately and the
 *   write is fire-and-forget. Analytics must not be able to fail a player's
 *   action; a lost event is a gap in a chart, a failed save is a lost deck.
 * - **No PII.** A wallet address is the only identifier and it is already
 *   public on chain. No IPs, no user agents, no fingerprints.
 * - **Capped.** A TTL index expires events after 180 days so this cannot grow
 *   without bound on a free tier.
 */

const RETENTION_DAYS = 180;
const MAX_PROP_BYTES = 2_000;

let ready = false;

/** Create the indexes once, lazily, without blocking the first write. */
function ensureIndexes(db) {
  if (ready) return;
  ready = true;
  const events = db.collection('events');
  // Time-ordered scans are every analytics query's first step.
  events.createIndex({ at: -1 }).catch(() => {});
  events.createIndex({ type: 1, at: -1 }).catch(() => {});
  events.createIndex({ address: 1, at: -1 }).catch(() => {});
  // Bounded storage. Mongo removes expired documents on its own schedule.
  events.createIndex(
    { at: 1 },
    { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 },
  ).catch(() => {});
}

/**
 * Append one event. Fire-and-forget by design — see the header.
 *
 * @param db      the Mongo database
 * @param evt     `{ type, address, props }`
 */
export function recordEvent(db, evt) {
  if (!db || !evt?.type) return;
  try {
    ensureIndexes(db);
    let props = evt.props ?? {};
    // A runaway props object would be written a million times over. Truncate
    // rather than reject: a trimmed event still answers "did this happen".
    if (JSON.stringify(props).length > MAX_PROP_BYTES) {
      props = { truncated: true };
    }
    void db.collection('events').insertOne({
      type: String(evt.type).slice(0, 48),
      address: evt.address ? String(evt.address).slice(0, 64) : null,
      props,
      at: new Date(),
    }).catch(() => { /* a dropped event must never surface to a player */ });
  } catch {
    /* same */
  }
}

/**
 * Register the ingest and query endpoints.
 *
 * `/api/events` is signature-authenticated: an unauthenticated firehose would
 * let anyone poison every number the analytics project reports, which is worse
 * than having no numbers.
 */
export function registerTelemetryRoutes(app, db, requireWallet) {
  app.post('/api/events', requireWallet('events'), async (req, res) => {
    const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 20) : [];
    for (const e of list) {
      recordEvent(db, { type: e?.type, address: req.wallet, props: e?.props });
    }
    res.json({ ok: true, accepted: list.length });
  });

  /**
   * The aggregate the analytics project reads.
   *
   * Server-side aggregation rather than shipping raw events: the dashboard
   * should not need database credentials, and a browser should never pull a
   * hundred thousand documents to count them.
   */
  app.get('/api/analytics/summary', async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const events = db.collection('events');
    const players = db.collection('players');
    /**
     * Match records live here, not on `players`.
     *
     * The totals below used to sum `players.matches`, a field nothing writes —
     * so the dashboard reported 0 matches and no win rate however many were
     * actually played, which reads as "nobody plays this" rather than "this
     * number is wired to nothing".
     */
    const leaderboard = db.collection('leaderboard');

    try {
      const [byType, byDay, funnel, totals, topPlayers] = await Promise.all([
        events.aggregate([
          { $match: { at: { $gte: since } } },
          { $group: { _id: '$type', n: { $sum: 1 } } },
          { $sort: { n: -1 } },
        ]).toArray(),

        events.aggregate([
          { $match: { at: { $gte: since } } },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$at' } },
              events: { $sum: 1 },
              players: { $addToSet: '$address' },
            },
          },
          { $project: { day: '$_id', events: 1, players: { $size: '$players' }, _id: 0 } },
          { $sort: { day: 1 } },
        ]).toArray(),

        // The funnel that actually matters: arrived → got bags → minted a
        // fighter → played → staked. Each step is a distinct-wallet count, so
        // a player who did something twice is not counted twice.
        events.aggregate([
          { $match: { at: { $gte: since } } },
          {
            $group: {
              _id: '$type',
              wallets: { $addToSet: '$address' },
            },
          },
          { $project: { type: '$_id', wallets: { $size: '$wallets' }, _id: 0 } },
        ]).toArray(),

        Promise.all([
          players.countDocuments({}),
          leaderboard.aggregate([
            {
              $group: {
                _id: null,
                matches: { $sum: '$matches' },
                wins: { $sum: '$wins' },
              },
            },
          ]).toArray(),
        ]).then(([playerCount, agg]) => [{
          players: playerCount,
          matches: agg[0]?.matches ?? 0,
          wins: agg[0]?.wins ?? 0,
        }]),

        // Ranked by real match counts, which only the leaderboard has. Sorting
        // `players` by a field nothing writes returned ten arbitrary rows all
        // showing "0m · 0w" — a "most active" list where nobody is active.
        leaderboard.find({}, { projection: { matches: 1, wins: 1, updatedAt: 1 } })
          .sort({ matches: -1 }).limit(10).toArray(),
      ]);

      const newPlayers = await players.countDocuments({ firstSeenAt: { $gte: since } });
      const activePlayers = await players.countDocuments({ lastSeenAt: { $gte: since } });

      res.json({
        windowDays: days,
        generatedAt: new Date(),
        totals: {
          ...(totals[0] ?? { players: 0, matches: 0, wins: 0 }),
          newPlayers,
          activePlayers,
        },
        byType,
        byDay,
        funnel,
        // Only wallets that have actually played. A "most active" list padded
        // out to ten with rows reading "0m · 0w" says the opposite of what it
        // is for.
        topPlayers: topPlayers
          .filter((p) => (p.matches ?? 0) > 0)
          .map((p) => ({
            address: p._id,
            name: null,
            matches: p.matches ?? 0,
            wins: p.wins ?? 0,
            lastSeenAt: p.updatedAt ?? null,
          })),
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e).slice(0, 200) });
    }
  });
}
