/**
 * The numbers you need to run this, as opposed to the ones you show off.
 *
 * `/api/analytics/summary` answers "how big is it". These answer "is it
 * working, is anyone coming back, and does the economy add up" — which are the
 * questions that decide whether a build is ready for people who did not write
 * it.
 *
 * Split from `summary` deliberately. Retention is the most expensive query on
 * this service, and a dashboard that blocks its funnel behind a cohort scan is
 * a dashboard people stop opening.
 */

/** Day key in UTC, so a cohort does not shift under whoever is reading it. */
const DAY = { $dateToString: { format: '%Y-%m-%d', date: '$at' } };

const MS_DAY = 24 * 60 * 60 * 1000;

export function registerInsightRoutes(app, db) {
  app.get('/api/analytics/insights', async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * MS_DAY);
    const events = db.collection('events');
    const players = db.collection('players');
    const clans = db.collection('clans');

    try {
      const [spend, matchDays, matchHealth, clanStats, cohorts] = await Promise.all([
        /**
         * Where $MEMPIRE actually goes.
         *
         * A token with sinks is only interesting if you can see which sink
         * people use. One total would say demand exists; this says what it is
         * demand *for*.
         */
        events.aggregate([
          { $match: { type: 'spend', at: { $gte: since } } },
          {
            $group: {
              _id: '$props.kind',
              count: { $sum: 1 },
              tokens: { $sum: '$props.price' },
              wallets: { $addToSet: '$address' },
            },
          },
          { $project: { kind: '$_id', count: 1, tokens: 1, wallets: { $size: '$wallets' }, _id: 0 } },
          { $sort: { tokens: -1 } },
        ]).toArray(),

        // Matches per day, separately from active wallets: a day where twenty
        // people each played once and a day where two played ten times look
        // identical on a DAU chart and mean completely different things.
        events.aggregate([
          { $match: { type: 'match.end', at: { $gte: since } } },
          {
            $group: {
              _id: DAY,
              matches: { $sum: 1 },
              staked: { $sum: { $cond: ['$props.staked', 1, 0] } },
            },
          },
          { $project: { day: '$_id', matches: 1, staked: 1, _id: 0 } },
          { $sort: { day: 1 } },
        ]).toArray(),

        /**
         * Whether matches are finishing cleanly.
         *
         * The void rate is the one number this architecture lives or dies by.
         * Two clients run the same deterministic sim and a mismatch annuls the
         * match — which is the correct, honest failure, but a build quietly
         * annulling a tenth of its games is broken in the way players notice
         * first.
         */
        events.aggregate([
          { $match: { type: 'match.end', at: { $gte: since } } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              voided: { $sum: { $cond: ['$props.voided', 1, 0] } },
              staked: { $sum: { $cond: ['$props.staked', 1, 0] } },
              draws: { $sum: { $cond: ['$props.draw', 1, 0] } },
              // Per currency: a MON pot and an AUSD pot do not add up to
              // anything, so they are never summed together.
              potMon: { $sum: { $cond: [{ $eq: ['$props.currency', 'MON'] }, '$props.pot', 0] } },
              rakeMon: { $sum: { $cond: [{ $eq: ['$props.currency', 'MON'] }, '$props.rake', 0] } },
              potAusd: { $sum: { $cond: [{ $eq: ['$props.currency', 'AUSD'] }, '$props.pot', 0] } },
              rakeAusd: { $sum: { $cond: [{ $eq: ['$props.currency', 'AUSD'] }, '$props.rake', 0] } },
              checkpoints: { $avg: '$props.hashes' },
            },
          },
        ]).toArray(),

        Promise.all([
          clans.countDocuments({}),
          clans.aggregate([
            { $group: { _id: null, members: { $sum: { $size: { $ifNull: ['$members', []] } } } } },
          ]).toArray(),
        ]),

        /**
         * Retention, by signup cohort.
         *
         * The single number that says whether a game is worth running. Built
         * from `firstSeenAt` on the player document and the distinct days that
         * wallet later appears in the event stream — not from a "sessions"
         * table nobody maintains.
         *
         * Cohorts younger than the window they are measured over are excluded:
         * a wallet that signed up two hours ago has not failed to return on
         * day one, it simply has not had a day one, and counting it as a miss
         * drags every retention figure down as the game gets busier.
         */
        players.aggregate([
          { $match: { firstSeenAt: { $gte: since } } },
          {
            $lookup: {
              from: 'events',
              let: { addr: '$_id', joined: '$firstSeenAt' },
              pipeline: [
                { $match: { $expr: { $eq: ['$address', '$$addr'] } } },
                {
                  $project: {
                    dayOffset: {
                      $floor: { $divide: [{ $subtract: ['$at', '$$joined'] }, MS_DAY] },
                    },
                  },
                },
                { $group: { _id: '$dayOffset' } },
              ],
              as: 'seen',
            },
          },
          {
            $project: {
              firstSeenAt: 1,
              offsets: '$seen._id',
            },
          },
        ]).toArray(),
      ]);

      const now = Date.now();
      /** Only cohorts old enough to have had the day being measured. */
      const eligible = (n) => cohorts.filter(
        (c) => now - new Date(c.firstSeenAt).getTime() >= n * MS_DAY,
      );
      const returnedBy = (list, lo, hi) => list.filter(
        (c) => (c.offsets ?? []).some((d) => d >= lo && d <= hi),
      ).length;

      const d1Pool = eligible(2);
      const d7Pool = eligible(8);

      const health = matchHealth[0] ?? {};
      const total = health.total ?? 0;

      res.json({
        windowDays: days,
        generatedAt: new Date(),
        retention: {
          cohort: cohorts.length,
          d1: { of: d1Pool.length, returned: returnedBy(d1Pool, 1, 1) },
          d7: { of: d7Pool.length, returned: returnedBy(d7Pool, 1, 7) },
        },
        spend: {
          bySink: spend,
          tokens: spend.reduce((n, s) => n + (s.tokens ?? 0), 0),
        },
        matches: {
          total,
          staked: health.staked ?? 0,
          draws: health.draws ?? 0,
          voided: health.voided ?? 0,
          // Expressed as a rate rather than a count: three voids means nothing
          // without knowing whether it was out of five matches or five hundred.
          voidRate: total > 0 ? (health.voided ?? 0) / total : null,
          pot: { MON: health.potMon ?? 0, AUSD: health.potAusd ?? 0 },
          rake: { MON: health.rakeMon ?? 0, AUSD: health.rakeAusd ?? 0 },
          avgCheckpoints: health.checkpoints ?? 0,
        },
        series: { matchDays },
        clans: {
          count: clanStats[0] ?? 0,
          members: clanStats[1]?.[0]?.members ?? 0,
        },
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e).slice(0, 200) });
    }
  });
}
