import { requireWallet } from './auth.js';
import { deployment, normAddress } from './chain.js';
import { verifyTokenPayment, treasuryAddress } from './chain-verify.js';
/**
 * Clans.
 *
 * Clash Royale's clan loop, translated into Mempire's economy rather than copied
 * from it. Two deliberate substitutions:
 *
 *  - **Trophies → crowns.** Mempire already earns crowns per felled tower, so a
 *    clan's standing is the sum of its members' crowns. No parallel ladder.
 *  - **Card donations → lend requests.** Clash donates fungible cards. Mempire's
 *    cards are ERC-721s with a level earned by merging, so they cannot be
 *    duplicated on request. A lend request is a favour: a clanmate answers it,
 *    the answer is counted, and the lender earns gems. The card itself only ever
 *    changes hands on chain — this tracks the social contract, not custody of
 *    the asset, and the UI says so.
 *
 * Members are embedded in the clan document. Fifty members is nowhere near the
 * 16MB ceiling, it makes reading a clan one query, and it makes join/leave a
 * single atomic update so the member count can never drift from the roster.
 */

export const MEMBER_CAP = 50;
export const CLAN_CREATE_GEM_COST = 500;
const NAME_MAX = 22;
const DESC_MAX = 120;
const FEED_MAX = 60;

const ROLES = ['leader', 'coleader', 'elder', 'member'];
/** Rank order for sorting and for permission checks; lower is more senior. */
const RANK = Object.fromEntries(ROLES.map((r, i) => [r, i]));

export const REGIONS = [
  'Global', 'North America', 'South America', 'Europe', 'Asia', 'Africa', 'Oceania',
];

const TAG = /^[A-HJ-NP-Z2-9]{6}$/;

/** Ambiguous glyphs (0/O, 1/I/L) are excluded so a tag can be read aloud. */
const TAG_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomTag() {
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += TAG_ALPHABET[Math.floor(Math.random() * TAG_ALPHABET.length)];
  }
  return out;
}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Crest as four small integers rather than an image.
 *
 * Composable crests are infinite, weigh nothing, need no upload path and no
 * moderation queue, and render crisply at any size — a generated bitmap per clan
 * would be worse on every one of those counts.
 */
function normaliseCrest(c) {
  const n = (v, mod) => {
    const i = Number.parseInt(v, 10);
    return Number.isFinite(i) && i >= 0 ? i % mod : 0;
  };
  return {
    shape: n(c?.shape, 6),
    emblem: n(c?.emblem, 12),
    hue: n(c?.hue, 360),
    tone: n(c?.tone, 3),
  };
}

const publicMember = (m) => ({
  address: m.address,
  name: m.name ?? null,
  role: m.role,
  crowns: m.crowns ?? 0,
  lent: m.lent ?? 0,
  received: m.received ?? 0,
  power: m.power ?? 0,
  joinedAt: m.joinedAt,
  lastSeenAt: m.lastSeenAt ?? m.joinedAt,
});

/** Members ranked by crowns — the order the roster is displayed in. */
const rankMembers = (members) => [...(members ?? [])]
  .sort((a, b) => (b.crowns ?? 0) - (a.crowns ?? 0) || RANK[a.role] - RANK[b.role])
  .map(publicMember);

/** List/search shape — deliberately smaller than the detail shape. */
const clanSummary = (c) => ({
  tag: c._id,
  name: c.name,
  description: c.description,
  crest: c.crest,
  region: c.region,
  requiredPower: c.requiredPower ?? 0,
  joinMode: c.joinMode ?? 'open',
  memberCount: c.members?.length ?? 0,
  memberCap: MEMBER_CAP,
  crowns: c.crowns ?? 0,
  weeklyLent: c.weeklyLent ?? 0,
  createdAt: c.createdAt,
});

const clanDetail = (c) => ({
  ...clanSummary(c),
  members: rankMembers(c.members),
  feed: (c.feed ?? []).slice(0, FEED_MAX),
  treasuryMon: c.treasuryMon ?? 0,
});

function feedEntry(kind, address, extra = {}) {
  return { kind, address, at: new Date(), ...extra };
}

/**
 * Registers every clan route.
 *
 * Every write is signature-authenticated: the acting wallet is `req.wallet`,
 * the address the signature proves, and never an address read from the body.
 * The client owns game logic, this stores results, and nothing here can move
 * funds. Anything that touches money stays on chain.
 */
export function registerClanRoutes(app, db) {
  const clans = db.collection('clans');
  /*
   * One row per wallet that is in a clan, so "one clan per wallet" is a fact
   * the database can enforce.
   *
   * It was enforced by reading `clanOf(address)` and then writing to a
   * *different* document — a new clan, or the target clan. The join's filter
   * guards the member cap and the same-clan duplicate atomically, and the
   * comment there says exactly why; but no filter on one clan can see the
   * others, so two concurrent joins to two different tags both passed the read
   * and both committed. Everything downstream then reads one arbitrary row of
   * several: `clanOf`, `/api/clans/mine`, and `leave`'s disband-or-promote
   * logic, which only ever looks at the tag it was handed.
   *
   * A unique `_id` on the address turns the second concurrent write into a
   * duplicate-key error instead of a success.
   */
  const membership = db.collection('clan_membership');

  const ready = (async () => {
    // Unique on name so two clans cannot share one; case-insensitive via collation.
    await clans.createIndex({ name: 1 }, {
      unique: true, collation: { locale: 'en', strength: 2 },
    });
    // "which clan is this wallet in" — multikey over the embedded roster
    await clans.createIndex({ 'members.address': 1 });
    await clans.createIndex({ crowns: -1 });
    await clans.createIndex({ region: 1, crowns: -1 });
    /*
     * One charter payment, one clan — and only for clans that have one.
     *
     * `sparse` is not enough here: it skips documents where the field is
     * *missing*, not ones where it is present and null, so every clan founded
     * without a payment (the no-token-deployed case) would collide with the
     * next on `null`. A partial index keyed on the field actually being a
     * string is the version that means what this wants.
     */
    await clans.createIndex({ charterTx: 1 }, {
      unique: true,
      partialFilterExpression: { charterTx: { $type: 'string' } },
    });
  })();

  /*
   * The charter fee, and the promise that it was actually paid.
   *
   * Mirrors the client's `PRICES.clanCharter`. A payment may found exactly one
   * clan: its transaction hash is stored on the clan document under a unique
   * index, so replaying one payment to found a second clan is a duplicate-key
   * error rather than a free clan.
   */
  const CHARTER_TOKENS = 250n;
  const MEMPIRE_DECIMALS = 18n;

  async function requireCharter(address, txHash) {
    const token = deployment?.token;
    if (!token) {
      // No $MEMPIRE on this chain yet: there is nothing to charge, and refusing
      // every clan would be worse than charging none.
      return { ok: true, skipped: 'no $MEMPIRE token deployed on this chain' };
    }
    if (!txHash) {
      return { ok: false, reason: `the charter costs ${CHARTER_TOKENS} $MEMPIRE — pay it, then send the transaction hash as paymentTx` };
    }
    const hash = String(txHash).toLowerCase();
    if (await clans.findOne({ charterTx: hash })) {
      return { ok: false, reason: 'that payment has already chartered a clan' };
    }
    const min = CHARTER_TOKENS * (10n ** MEMPIRE_DECIMALS);
    const treasury = await treasuryAddress();
    const paid = await verifyTokenPayment(hash, address, token, treasury, min);
    if (!paid.ok) return { ok: false, reason: paid.reason };
    return { ok: true, txHash: hash };
  }

  const badAddress = (a) => !normAddress(a);

  const fail = (res, code, error) => res.status(code).json({ error });

  /**
   * Claim this wallet for `tag`, or fail if it already belongs somewhere.
   *
   * Returns true when the claim is ours to keep. The caller must release it
   * again if the roster write that follows does not land, so a failed join
   * never locks a wallet out of clans entirely.
   */
  async function claimMembership(address, tag) {
    try {
      await membership.insertOne({ _id: address, tag, at: new Date() });
      return true;
    } catch (e) {
      if (e?.code !== 11000) throw e;
      /*
       * A row with no roster behind it is either a live claim or litter, and
       * only the clock can tell them apart.
       *
       * The claim is taken before the write that puts the wallet on a roster,
       * so a crash in between leaves a row naming a clan the wallet never
       * joined. Treating that as "already in a clan" would lock the wallet out
       * of every clan forever with no clan to leave — worse than the race this
       * exists to prevent. But "no roster yet" is *also* what the loser of a
       * genuine race sees, because the winner is a few milliseconds from
       * writing its roster; reclaiming on that alone hands both requests a
       * clan and defeats the whole lock.
       *
       * So: a row younger than the grace period is somebody else's claim in
       * flight and is respected. An older one with nothing on any roster is
       * abandoned, and can be taken.
       */
      const CLAIM_GRACE_MS = 30_000;
      const held = await membership.findOne({ _id: address });
      const age = held?.at ? Date.now() - new Date(held.at).getTime() : Infinity;
      if (age < CLAIM_GRACE_MS) return false;
      if (await clanOf(address)) return false;
      await membership.updateOne({ _id: address }, { $set: { tag, at: new Date() } });
      return true;
    }
  }

  const releaseMembership = (address) => membership.deleteOne({ _id: address }).catch(() => {});

  /**
   * The clan this wallet belongs to, or null.
   *
   * Still answered from the roster, which is the thing every other read uses;
   * the membership row is the lock, not a second source of truth. Rows left
   * behind by an older deployment simply do not match any roster and are
   * cleaned up on the next leave.
   */
  async function clanOf(address) {
    return clans.findOne({ 'members.address': address });
  }

  function memberIn(clan, address) {
    return (clan.members ?? []).find((m) => m.address === address) ?? null;
  }

  // ── search / list ────────────────────────────────────────────────────────
  // Matches the "Search or create a new clan" sheet: free-text over name and
  // tag, plus the filters that sheet exposes.
  app.get('/api/clans', async (req, res) => {
    await ready;
    const { q, region, maxRequiredPower, openOnly, hasRoom } = req.query;
    /**
     * Never list a clan nobody is in.
     *
     * Leaving as the last member disbands a clan, so a zero-member document
     * cannot arise from the app — only from seeding. Seven such shells from a
     * since-deleted seeder sat at the top of this list for a week, each one a
     * clan a player could find, open, and discover was nothing. Filtering here
     * as well as deleting them means the next stray import cannot put them back
     * in front of anyone.
     */
    const filter = { members: { $exists: true, $not: { $size: 0 } } };

    const term = clean(q, 24);
    if (term) {
      // A tag is exact; a name is a prefix-ish contains. Escape the term so a
      // stray ( or * from a player cannot break the query.
      const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { _id: term.toUpperCase() },
        { name: { $regex: safe, $options: 'i' } },
      ];
    }
    if (region && region !== 'Global' && REGIONS.includes(region)) filter.region = region;
    if (maxRequiredPower) {
      const p = Number(maxRequiredPower);
      if (Number.isFinite(p)) filter.requiredPower = { $lte: p };
    }
    if (openOnly === 'true') filter.joinMode = 'open';

    try {
      const rows = await clans.find(filter).sort({ crowns: -1 }).limit(40).toArray();
      let out = rows.map(clanSummary);
      // Post-filter: memberCount is derived, so it cannot be a query predicate
      // without denormalising a field that could then disagree with the roster.
      if (hasRoom === 'true') out = out.filter((c) => c.memberCount < c.memberCap);
      res.json({ clans: out });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── my clan ──────────────────────────────────────────────────────────────
  app.get('/api/clans/mine/:address', async (req, res) => {
    await ready;
    const address = normAddress(req.params.address);
    if (badAddress(address)) return fail(res, 400, 'bad address');
    try {
      const clan = await clanOf(address);
      res.json(clan ? clanDetail(clan) : null);
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── detail ───────────────────────────────────────────────────────────────
  app.get('/api/clans/:tag', async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      res.json(clanDetail(clan));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── create ───────────────────────────────────────────────────────────────
  app.post('/api/clans', requireWallet('clan.create'), async (req, res) => {
    await ready;
    const {
      name, description, region, crest, requiredPower, joinMode, memberName, power,
      paymentTx,
    } = req.body ?? {};
    const address = req.wallet;
    if (badAddress(address)) return fail(res, 400, 'bad address');

    const cleanName = clean(name, NAME_MAX);
    if (cleanName.length < 3) return fail(res, 400, 'name must be at least 3 characters');

    try {
      // One clan per wallet. Checked before insert so the error is the useful
      // one ("already in a clan") rather than a duplicate-key surprise.
      if (await clanOf(address)) return fail(res, 409, 'you are already in a clan');
      /*
       * The charter is paid before the clan exists, and the chain says so.
       *
       * This route used to create the clan and leave the charging to the
       * browser afterwards, with "the founder cancels and we call leave" as
       * the undo. That undo runs in the same browser that just got its clan,
       * so a caller who skipped it founded one for nothing — the fee was a
       * suggestion, exactly like the leaderboard's money column was before
       * `chain-verify` existed. It is the same fix: the client sends the
       * hash of the payment it already made, and the server reads what
       * actually arrived at the treasury.
       */
      const charter = await requireCharter(address, paymentTx);
      if (!charter.ok) return fail(res, 402, charter.reason);

      // The tag does not exist yet — it is drawn in the retry loop below — so
      // the claim is made first and stamped once the clan is real.
      if (!await claimMembership(address, null)) {
        return fail(res, 409, 'you are already in a clan');
      }

      const now = new Date();
      const doc = {
        name: cleanName,
        description: clean(description, DESC_MAX) || 'a new empire rises',
        region: REGIONS.includes(region) ? region : 'Global',
        crest: normaliseCrest(crest),
        requiredPower: Math.max(0, Math.min(9999, Number(requiredPower) || 0)),
        joinMode: ['open', 'request', 'closed'].includes(joinMode) ? joinMode : 'open',
        crowns: 0,
        weeklyLent: 0,
        treasuryMon: 0,
        createdBy: address,
        createdAt: now,
        updatedAt: now,
        members: [{
          address,
          name: clean(memberName, 20) || null,
          role: 'leader',
          crowns: 0,
          lent: 0,
          received: 0,
          power: Number(power) || 0,
          joinedAt: now,
          lastSeenAt: now,
        }],
        feed: [feedEntry('founded', address, { name: cleanName })],
        // Omitted entirely rather than set to null when there was nothing to
        // charge, so the index above has nothing to key on.
        ...(charter.txHash ? { charterTx: charter.txHash } : {}),
      };

      // Tag collisions are possible but rare; retry a few times rather than
      // failing the request.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const tag = randomTag();
        try {
          await clans.insertOne({ _id: tag, ...doc });
          await membership.updateOne({ _id: address }, { $set: { tag } });
          return res.status(201).json(clanDetail({ _id: tag, ...doc }));
        } catch (e) {
          if (e?.code !== 11000) throw e;
          // Duplicate name is a user error and will never resolve by retrying.
          if (String(e.message).includes('name')) {
            await releaseMembership(address);
            return fail(res, 409, 'that name is taken');
          }
        }
      }
      // No clan was created, so the wallet is not in one.
      await releaseMembership(address);
      return fail(res, 500, 'could not allocate a clan tag');
    } catch (e) {
      await releaseMembership(address);
      return fail(res, 500, e.message);
    }
  });

  // ── join ─────────────────────────────────────────────────────────────────
  app.post('/api/clans/:tag/join', requireWallet('clan.join'), async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { memberName, power } = req.body ?? {};
    const address = req.wallet;
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');

    try {
      if (await clanOf(address)) return fail(res, 409, 'leave your current clan first');
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      if (clan.joinMode === 'closed') return fail(res, 403, 'this clan is closed');
      if ((clan.members?.length ?? 0) >= MEMBER_CAP) return fail(res, 409, 'clan is full');

      const deckPower = Number(power) || 0;
      if (deckPower < (clan.requiredPower ?? 0)) {
        return fail(res, 403, `needs ${clan.requiredPower} deck power — yours is ${deckPower}`);
      }
      /*
       * The membership lock is taken only once every refusal above has been
       * passed. It used to be taken first, and none of those early returns
       * released it — so an underpowered or closed-clan refusal left the
       * wallet holding a claim on a clan it never joined, and every join it
       * tried for the next thirty seconds answered "leave your current clan
       * first" about a clan it was not in.
       */
      if (!await claimMembership(address, tag)) {
        return fail(res, 409, 'leave your current clan first');
      }

      const now = new Date();
      const member = {
        address,
        name: clean(memberName, 20) || null,
        role: 'member',
        crowns: 0,
        lent: 0,
        received: 0,
        power: deckPower,
        joinedAt: now,
        lastSeenAt: now,
      };

      // The size guard is inside the filter, not just the check above, so two
      // simultaneous joins into slot 50 cannot both succeed.
      const result = await clans.findOneAndUpdate(
        { _id: tag, [`members.${MEMBER_CAP - 1}`]: { $exists: false }, 'members.address': { $ne: address } },
        {
          $push: {
            members: member,
            feed: { $each: [feedEntry('joined', address)], $position: 0, $slice: FEED_MAX },
          },
          $set: { updatedAt: now },
        },
        { returnDocument: 'after' },
      );
      if (!result) {
        // The roster refused us, so the claim is not ours to hold.
        await releaseMembership(address);
        return fail(res, 409, 'clan filled up — try another');
      }
      res.json(clanDetail(result));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── leave ────────────────────────────────────────────────────────────────
  app.post('/api/clans/:tag/leave', requireWallet('clan.leave'), async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const address = req.wallet;
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      const me = memberIn(clan, address);
      if (!me) return fail(res, 403, 'you are not in this clan');

      const others = (clan.members ?? []).filter((m) => m.address !== address);

      // A leader leaving must not orphan the clan. Empty → delete it; otherwise
      // the most senior remaining member is promoted, so there is always a leader.
      if (!others.length) {
        await clans.deleteOne({ _id: tag });
        await releaseMembership(address);
        return res.json({ ok: true, disbanded: true });
      }

      const now = new Date();
      const update = {
        $pull: { members: { address } },
        $set: { updatedAt: now },
        $push: { feed: { $each: [feedEntry('left', address)], $position: 0, $slice: FEED_MAX } },
      };
      await clans.updateOne({ _id: tag }, update);

      if (me.role === 'leader') {
        const heir = rankMembers(others)[0];
        await clans.updateOne(
          { _id: tag, 'members.address': heir.address },
          {
            $set: { 'members.$.role': 'leader' },
            $push: {
              feed: {
                $each: [feedEntry('promoted', heir.address, { role: 'leader', by: address })],
                $position: 0,
                $slice: FEED_MAX,
              },
            },
          },
        );
      }
      await releaseMembership(address);
      res.json({ ok: true, disbanded: false });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── settings (leader / co-leader) ────────────────────────────────────────
  /*
   * Settings. Signature-authenticated like every other write here.
   *
   * This one route was missing `requireWallet`, and it read the actor's
   * identity straight out of the request body — which this API publishes
   * itself: `GET /api/clans/:tag` returns every member's address and role. So
   * anyone could read a clan's leader address and PATCH the clan as them, with
   * no key and no signature. It also sat outside the per-wallet rate limit,
   * because that runs inside `requireWallet`.
   *
   * The address now comes from `req.wallet` — the one the signature actually
   * proves — and never from the body.
   */
  app.patch('/api/clans/:tag', requireWallet('clan.settings'), async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { description, region, requiredPower, joinMode, crest } = req.body ?? {};
    const address = req.wallet;
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      const me = memberIn(clan, address);
      if (!me || RANK[me.role] > RANK.coleader) return fail(res, 403, 'leaders only');

      const $set = { updatedAt: new Date() };
      if (description !== undefined) $set.description = clean(description, DESC_MAX);
      if (region !== undefined && REGIONS.includes(region)) $set.region = region;
      if (requiredPower !== undefined) {
        $set.requiredPower = Math.max(0, Math.min(9999, Number(requiredPower) || 0));
      }
      if (joinMode !== undefined && ['open', 'request', 'closed'].includes(joinMode)) {
        $set.joinMode = joinMode;
      }
      if (crest !== undefined) $set.crest = normaliseCrest(crest);

      const updated = await clans.findOneAndUpdate({ _id: tag }, { $set }, { returnDocument: 'after' });
      res.json(clanDetail(updated));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── promote / demote / kick ──────────────────────────────────────────────
  app.post('/api/clans/:tag/role', requireWallet('clan.role'), async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { role } = req.body ?? {};
    const address = req.wallet;
    const target = normAddress(req.body?.target);
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address) || badAddress(target)) return fail(res, 400, 'bad address');
    if (!ROLES.includes(role)) return fail(res, 400, 'bad role');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      const me = memberIn(clan, address);
      const them = memberIn(clan, target);
      if (!me || !them) return fail(res, 403, 'not in this clan');
      if (RANK[me.role] > RANK.coleader) return fail(res, 403, 'leaders only');
      // You may not act on a peer or a senior, and may not mint a second leader.
      if (RANK[them.role] <= RANK[me.role] && address !== target) {
        return fail(res, 403, 'you cannot change someone at or above your rank');
      }
      if (role === 'leader') return fail(res, 400, 'transfer leadership is not supported yet');

      /*
       * A leader stepping down must name a successor, exactly as leaving does.
       *
       * The rank guard above is switched off when the actor is the target
       * (`&& address !== target`), which is right for a coleader dropping to
       * elder. For a leader it is one-way: promotion to `leader` is refused
       * two lines up, and `RANK <= coleader` gates both this route and the
       * settings route — so a leader who demoted themselves left a clan that
       * nobody could ever administer again, and `leave` could not repair it
       * either, because its heir promotion only runs for a departing leader.
       *
       * `leave` treats this invariant as sacred — "there is always a leader" —
       * and promotes the most senior remaining member. A step-down does the
       * same thing in the same call.
       */
      let heir = null;
      if (address === target && me.role === 'leader') {
        const others = (clan.members ?? []).filter((x) => x.address !== address);
        if (!others.length) {
          return fail(res, 400, 'you are the only member — use leave to disband the clan');
        }
        heir = rankMembers(others)[0];
      }

      const now = new Date();
      await clans.updateOne(
        { _id: tag, 'members.address': target },
        {
          $set: { 'members.$.role': role, updatedAt: now },
          $push: {
            feed: {
              $each: [feedEntry('promoted', target, { role, by: address })],
              $position: 0,
              $slice: FEED_MAX,
            },
          },
        },
      );
      if (heir) {
        await clans.updateOne(
          { _id: tag, 'members.address': heir.address },
          {
            $set: { 'members.$.role': 'leader' },
            $push: {
              feed: {
                $each: [feedEntry('promoted', heir.address, { role: 'leader', by: address })],
                $position: 0,
                $slice: FEED_MAX,
              },
            },
          },
        );
      }
      const after = await clans.findOne({ _id: tag });
      res.json(clanDetail(after));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  app.post('/api/clans/:tag/kick', requireWallet('clan.kick'), async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const address = req.wallet;
    const target = normAddress(req.body?.target);
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address) || badAddress(target)) return fail(res, 400, 'bad address');
    if (address === target) return fail(res, 400, 'use leave instead');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      const me = memberIn(clan, address);
      const them = memberIn(clan, target);
      if (!me || !them) return fail(res, 403, 'not in this clan');
      if (RANK[me.role] > RANK.elder) return fail(res, 403, 'elders and above only');
      if (RANK[them.role] <= RANK[me.role]) {
        return fail(res, 403, 'you cannot kick someone at or above your rank');
      }

      await clans.updateOne({ _id: tag }, {
        $pull: { members: { address: target } },
        $set: { updatedAt: new Date() },
        $push: {
          feed: {
            $each: [feedEntry('kicked', target, { by: address })],
            $position: 0,
            $slice: FEED_MAX,
          },
        },
      });
      // Kicked out of the roster and out of the membership lock, or they could
      // never join anywhere again.
      await releaseMembership(target);
      const after = await clans.findOne({ _id: tag });
      res.json(clanDetail(after));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── lend requests ────────────────────────────────────────────────────────
  // The clan's social loop. A request names an archetype rather than a specific
  // card, because what a deck is missing is a role, not a coin.
  app.post('/api/clans/:tag/request', requireWallet('clan.request'), async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { archetype, note } = req.body ?? {};
    const address = req.wallet;
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');
    const arch = Number(archetype);
    if (!Number.isInteger(arch) || arch < 0 || arch > 5) return fail(res, 400, 'bad archetype');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      if (!memberIn(clan, address)) return fail(res, 403, 'you are not in this clan');

      // One open request at a time, so the feed cannot be flooded.
      const open = (clan.feed ?? []).find(
        (f) => f.kind === 'request' && f.address === address && !f.filledBy,
      );
      if (open) return fail(res, 409, 'you already have an open request');

      const entry = feedEntry('request', address, {
        id: `${address}_${Date.now()}`,
        archetype: arch,
        note: clean(note, 60) || null,
        filledBy: null,
      });
      const updated = await clans.findOneAndUpdate(
        { _id: tag },
        {
          $push: { feed: { $each: [entry], $position: 0, $slice: FEED_MAX } },
          $set: { updatedAt: new Date() },
        },
        { returnDocument: 'after' },
      );
      res.json(clanDetail(updated));
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  /** Answer someone's request. The lender's count goes up; so does the clan's. */
  app.post('/api/clans/:tag/lend', requireWallet('clan.lend'), async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { requestId } = req.body ?? {};
    const address = req.wallet;
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');

    try {
      const clan = await clans.findOne({ _id: tag });
      if (!clan) return fail(res, 404, 'clan not found');
      if (!memberIn(clan, address)) return fail(res, 403, 'you are not in this clan');

      const entry = (clan.feed ?? []).find((f) => f.kind === 'request' && f.id === requestId);
      if (!entry) return fail(res, 404, 'request not found');
      if (entry.filledBy) return fail(res, 409, 'already answered');
      if (entry.address === address) return fail(res, 400, 'you cannot answer your own request');

      const now = new Date();
      // Two positional updates in one statement would need arrayFilters on both
      // arrays; three targeted updates are clearer and each is idempotent-safe.
      await clans.updateOne(
        { _id: tag, 'feed.id': requestId },
        { $set: { 'feed.$.filledBy': address, 'feed.$.filledAt': now, updatedAt: now } },
      );
      await clans.updateOne(
        { _id: tag, 'members.address': address },
        { $inc: { 'members.$.lent': 1, weeklyLent: 1 } },
      );
      await clans.updateOne(
        { _id: tag, 'members.address': entry.address },
        { $inc: { 'members.$.received': 1 } },
      );

      const after = await clans.findOne({ _id: tag });
      res.json({ ...clanDetail(after), reward: { gems: 5 } });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── crown contribution ───────────────────────────────────────────────────
  /**
   * Called when a member settles a win. Crowns roll up to the clan, which is
   * what the clan leaderboard ranks on.
   */
  app.post('/api/clans/:tag/crowns', requireWallet('clan.crowns'), async (req, res) => {
    await ready;
    const tag = String(req.params.tag).toUpperCase();
    const { crowns, power } = req.body ?? {};
    const address = req.wallet;
    if (!TAG.test(tag)) return fail(res, 400, 'bad clan tag');
    if (badAddress(address)) return fail(res, 400, 'bad address');
    const n = Math.max(0, Math.min(3, Number(crowns) || 0));

    try {
      const now = new Date();
      const set = { 'members.$.lastSeenAt': now, updatedAt: now };
      if (power !== undefined) set['members.$.power'] = Number(power) || 0;
      const r = await clans.updateOne(
        { _id: tag, 'members.address': address },
        { $inc: { 'members.$.crowns': n, crowns: n }, $set: set },
      );
      if (!r.matchedCount) return fail(res, 403, 'you are not in this clan');
      res.json({ ok: true, added: n });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  // ── clan leaderboard ─────────────────────────────────────────────────────
  app.get('/api/clans-top', async (req, res) => {
    await ready;
    const region = req.query.region;
    const filter = region && region !== 'Global' && REGIONS.includes(region) ? { region } : {};
    try {
      const rows = await clans.find(filter).sort({ crowns: -1 }).limit(25).toArray();
      res.json({ clans: rows.map(clanSummary) });
    } catch (e) {
      fail(res, 500, e.message);
    }
  });
}
