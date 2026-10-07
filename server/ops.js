/**
 * The bits that only matter once more than one of these is running.
 *
 * Two things a single instance gets away with and a fleet does not: a rate
 * limit held in local memory, and errors that go nowhere but a log nobody
 * reads.
 */

/**
 * Rate limiting that survives scale-out.
 *
 * The in-memory token bucket this replaces was correct for one instance and
 * quietly wrong for two: each replica keeps its own counter, so a limit of 80
 * becomes 80 × replicas, and the moment the fleet is scaled to handle abuse the
 * limit loosens in proportion. Worse, it is per-process, so a rolling deploy
 * resets every bucket.
 *
 * Mongo holds the counters instead. One atomic update per mutating request is
 * cheap next to what these routes already do, and a shared counter means the
 * limit is the limit however many instances are up.
 */
export function rateLimiter(db, { capacity = 80, refillPerSec = 5, includeReads = false } = {}) {
  if (db.inMemory) return memoryRateLimiter({ capacity, refillPerSec, includeReads });
  const buckets = db.collection('rate_buckets');
  // Mongo drops these on its own once a bucket has been idle long enough to
  // have refilled completely, so the collection cannot grow without bound.
  buckets.createIndex({ at: 1 }, { expireAfterSeconds: 900 }).catch(() => {});

  return async function limit(req, res, next) {
    /*
     * Reads are free by default, and must not be on a credentialed proxy.
     *
     * Exempting GET is right for our own cheap endpoints. It is wrong for a
     * route that spends someone else's quota on every call: the Pyth proxy
     * carries this project's Hermes key, and the chain-backed reads spend the
     * relay's RPC quota, so an anonymous loop over either bills us and
     * eventually takes the route down for everyone. Those routes pass
     * `includeReads`.
     */
    if (!includeReads && (req.method === 'GET' || req.method === 'OPTIONS')) return next();
    const key = req.ip ?? 'unknown';
    const now = new Date();
    try {
      /*
       * One atomic operation, not a read then a write.
       *
       * The first version of this did `findOne` and then `updateOne`, which is
       * a race with itself: fire ninety-five concurrent requests at a bucket of
       * eighty and every one of them reads `tokens: 80` before any write lands,
       * so all ninety-five pass. It failed at precisely the burst it exists to
       * stop, and a load test is the only thing that would ever have said so.
       *
       * An aggregation-pipeline update refills and spends in a single document
       * operation, which Mongo serialises per document.
       */
      const doc = await buckets.findOneAndUpdate(
        { _id: key },
        [{
          $set: {
            tokens: {
              $subtract: [
                {
                  $min: [
                    capacity,
                    {
                      $add: [
                        { $ifNull: ['$tokens', capacity] },
                        {
                          $multiply: [
                            {
                              $divide: [
                                { $subtract: [now, { $ifNull: ['$at', now] }] },
                                1000,
                              ],
                            },
                            refillPerSec,
                          ],
                        },
                      ],
                    },
                  ],
                },
                1,
              ],
            },
            at: now,
          },
        }],
        { upsert: true, returnDocument: 'after' },
      );

      // Going negative is fine and deliberate: it is how a burst pays for
      // itself, and the refill above brings it back.
      if ((doc?.tokens ?? 0) < 0) return res.status(429).json({ error: 'slow down' });
      return next();
    } catch {
      // Fails open. A limiter that 500s when its store is unreachable turns a
      // database blip into a total outage — a worse failure than the one it
      // exists to prevent.
      return next();
    }
  };
}

/**
 * The same token bucket in process memory, for a relay running without Mongo.
 *
 * This is exactly the limiter the Mongo version replaced, and the reasons it
 * was replaced still hold for a fleet. A memory-mode relay is one process by
 * construction — it has no shared store to coordinate replicas with — and for
 * one process a local bucket is correct. Same capacity, same refill, same
 * deliberate overdraft.
 */
function memoryRateLimiter({ capacity, refillPerSec, includeReads }) {
  const buckets = new Map();
  return function limit(req, res, next) {
    if (!includeReads && (req.method === 'GET' || req.method === 'OPTIONS')) return next();
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec) - 1;
    b.at = now;
    buckets.set(key, b);
    // Idle buckets have refilled completely, so forgetting them changes nothing.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (now - v.at > 900_000) buckets.delete(k);
    }
    if (b.tokens < 0) return res.status(429).json({ error: 'slow down' });
    return next();
  };
}

/**
 * The same bucket, keyed by wallet instead of by IP.
 *
 * Per-IP limiting is the weakest useful control: a burst of 120 requests from
 * this machine spread itself over five egress addresses without trying, so each
 * bucket saw a quarter of the traffic and none of them tripped. Anyone who
 * wants an IP pool has one.
 *
 * A wallet is the scarce identity here — every mutating route already proves
 * one with a signature — so the limit that matters is per wallet, applied after
 * that proof. The IP bucket stays underneath it, because an unauthenticated
 * flood never reaches this layer at all.
 */
export function walletLimiter(db, { capacity = 60, refillPerSec = 2 } = {}) {
  const limit = rateLimiter(db, { capacity, refillPerSec });
  return (req, res, next) => {
    if (!req.wallet) return next();
    // Reuse the same atomic bucket, keyed by wallet rather than address of
    // origin. `ip` is what `rateLimiter` reads, so this hands it the wallet.
    return limit({ method: req.method, ip: `w:${req.wallet}` }, res, next);
  };
}

/**
 * Record errors somewhere they can be counted.
 *
 * Not a replacement for Sentry — it is what makes "is anything failing right
 * now" answerable without one, which is the actual gap. A stack trace in a
 * container log is invisible the moment the container restarts, and the
 * dashboard had no way to show that a route had started throwing.
 *
 * Capped collection so it can never fill the database: old errors roll off, and
 * the useful window is the recent one anyway.
 */
export function errorRecorder(db) {
  db.createCollection('errors', { capped: true, size: 4 * 1024 * 1024, max: 5000 })
    .catch(() => { /* already exists */ });

  const record = (err, context) => {
    try {
      void db.collection('errors').insertOne({
        at: new Date(),
        message: String(err?.message ?? err).slice(0, 400),
        // The first few frames are the ones that identify a fault; the rest is
        // node internals and framework noise.
        stack: String(err?.stack ?? '').split('\n').slice(0, 6).join('\n').slice(0, 900),
        ...context,
      }).catch(() => {});
    } catch { /* recording an error must never raise one */ }
  };

  /** Express error middleware. Must keep all four parameters to be recognised. */
  // eslint-disable-next-line no-unused-vars
  const middleware = (err, req, res, _next) => {
    record(err, { route: req.path, method: req.method });
    if (res.headersSent) return;
    res.status(500).json({ error: 'something broke on our side' });
  };

  // An unhandled rejection is the failure mode this service is most likely to
  // have — nearly everything here is a promise, and several are deliberately
  // fire-and-forget.
  process.on('unhandledRejection', (e) => record(e, { route: 'unhandledRejection' }));
  process.on('uncaughtException', (e) => record(e, { route: 'uncaughtException' }));

  return { middleware, record };
}

/**
 * Recent failures, for the dashboard's status row.
 *
 * Grouped by message rather than listed: forty copies of one broken route is
 * one problem, and a list of forty rows presents it as forty.
 */
export function registerOpsRoutes(app, db) {
  app.get('/api/analytics/ops', async (_req, res) => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const errors = await db.collection('errors').aggregate([
        { $match: { at: { $gte: since } } },
        {
          $group: {
            _id: '$message',
            count: { $sum: 1 },
            last: { $max: '$at' },
            route: { $first: '$route' },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]).toArray().catch(() => []);

      res.json({
        generatedAt: new Date(),
        region: process.env.RAILWAY_REPLICA_REGION ?? process.env.FLY_REGION ?? 'unknown',
        uptimeSec: Math.round(process.uptime()),
        errors24h: errors.reduce((n, e) => n + e.count, 0),
        topErrors: errors.map((e) => ({
          message: e._id, count: e.count, route: e.route, last: e.last,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e).slice(0, 200) });
    }
  });
}
