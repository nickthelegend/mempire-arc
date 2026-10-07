/**
 * Everything a player owns that is not on chain: decks, profile, progress.
 *
 * # Why this exists
 *
 * The three deck slots lived in a zustand store and nowhere else. Not
 * localStorage — memory. A refresh wiped them, so every player who spent five
 * minutes building a counter-deck lost it by pressing F5, and nobody could
 * play from two devices. Cards are ERC-721s and survive; the *arrangement* of
 * them did not survive a tab reload.
 *
 * # What belongs here and what does not
 *
 * Here: decks, display name, tier preference, tutorial state, aggregate
 * counters. Things the game owns.
 *
 * Not here: card ownership, stakes, match results, balances. Those are chain
 * state, and a server that keeps its own copy of them will eventually disagree
 * with the chain — at which point one of them is lying and the player cannot
 * tell which. The chain is read directly for all of it.
 *
 * Writes are signature-authenticated per action, so a player can only write
 * their own row.
 */
import { requireWallet } from './auth.js';
import { normAddress } from './chain.js';
import { recordEvent } from './telemetry.js';

const DECK_SLOTS = 3;
const DECK_SIZE = 8;
const MAX_NAME = 24;

/** Shape-check a deck: an array of up to eight short, sane card ids. */
function cleanDeck(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const id of raw.slice(0, DECK_SIZE)) {
    if (typeof id !== 'string') return null;
    const s = id.trim();
    if (!s || s.length > 64 || !/^[\w:-]+$/.test(s)) return null;
    if (out.includes(s)) continue; // one card per deck
    out.push(s);
  }
  return out;
}

function cleanSlots(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (let i = 0; i < DECK_SLOTS; i += 1) {
    const d = cleanDeck(raw[i] ?? []);
    if (d === null) return null;
    out.push(d);
  }
  return out;
}

export function registerPlayerRoutes(app, db) {
  const players = db.collection('players');

  // One row per wallet, and the ladder already queries by address.
  players.createIndex({ lastSeenAt: -1 }).catch(() => {});

  /**
   * Read a player's saved state. Public: a profile is not a secret, and the
   * clan and ladder screens already publish names and ratings.
   */
  app.get('/api/player/:address', async (req, res) => {
    const address = normAddress(req.params.address);
    if (!address) return res.status(400).json({ error: 'bad address' });
    const row = await players.findOne({ _id: address });
    if (!row) {
      return res.json({
        address,
        found: false,
        decks: null,
        name: null,
        tier: 0,
      });
    }
    res.json({
      address,
      found: true,
      decks: row.decks ?? null,
      activeSlot: row.activeSlot ?? 0,
      name: row.name ?? null,
      tier: row.tier ?? 0,
      tutorialDone: row.tutorialDone ?? false,
      matches: row.matches ?? 0,
      wins: row.wins ?? 0,
      firstSeenAt: row.firstSeenAt ?? null,
      lastSeenAt: row.lastSeenAt ?? null,
    });
  });

  /**
   * Save decks and profile. Signature-authenticated, so `req.wallet` — not
   * anything in the body — decides which row is written.
   */
  app.put('/api/player', requireWallet('player.save'), async (req, res) => {
    const address = req.wallet;
    const body = req.body ?? {};
    const set = { lastSeenAt: new Date() };

    if (body.decks !== undefined) {
      const decks = cleanSlots(body.decks);
      if (decks === null) return res.status(400).json({ error: 'malformed decks' });
      set.decks = decks;
    }
    if (body.activeSlot !== undefined) {
      const n = Number(body.activeSlot);
      if (!Number.isInteger(n) || n < 0 || n >= DECK_SLOTS) {
        return res.status(400).json({ error: 'bad slot' });
      }
      set.activeSlot = n;
    }
    if (body.name !== undefined) {
      const n = String(body.name).trim().slice(0, MAX_NAME);
      if (n) set.name = n;
    }
    if (body.tier !== undefined) {
      const t = Number(body.tier);
      if (!Number.isInteger(t) || t < 0 || t > 3) {
        return res.status(400).json({ error: 'bad tier' });
      }
      set.tier = t;
    }
    if (body.tutorialDone !== undefined) set.tutorialDone = !!body.tutorialDone;

    await players.updateOne(
      { _id: address },
      { $set: set, $setOnInsert: { firstSeenAt: new Date(), matches: 0, wins: 0 } },
      { upsert: true },
    );

    // A save is the cheapest reliable signal that a wallet is active, so it
    // doubles as the session heartbeat the analytics side reads.
    recordEvent(db, {
      type: 'player.save',
      address,
      props: { fields: Object.keys(set).filter((k) => k !== 'lastSeenAt') },
    });

    res.json({ ok: true });
  });

  /**
   * Record a finished match.
   *
   * The *result* is chain state and is not trusted from here — this is the
   * player-facing counter and the analytics trail, not the thing that decides
   * who gets paid. Kept deliberately separate from settlement for that reason.
   */
  app.post('/api/player/match', requireWallet('player.match'), async (req, res) => {
    const address = req.wallet;
    const b = req.body ?? {};
    const outcome = ['win', 'loss', 'draw', 'void'].includes(b.outcome) ? b.outcome : null;
    if (!outcome) return res.status(400).json({ error: 'bad outcome' });

    await players.updateOne(
      { _id: address },
      {
        $set: { lastSeenAt: new Date() },
        $inc: { matches: 1, wins: outcome === 'win' ? 1 : 0 },
        $setOnInsert: { firstSeenAt: new Date() },
      },
      { upsert: true },
    );

    recordEvent(db, {
      type: 'match.end',
      address,
      props: {
        outcome,
        mode: typeof b.mode === 'string' ? b.mode.slice(0, 16) : null,
        staked: !!b.staked,
        stake: Number.isFinite(Number(b.stake)) ? Number(b.stake) : 0,
        currency: ['MON', 'AUSD'].includes(b.currency) ? b.currency : null,
        onchainMatchId: Number.isFinite(Number(b.onchainMatchId)) ? Number(b.onchainMatchId) : null,
        durationMs: Number.isFinite(Number(b.durationMs)) ? Number(b.durationMs) : null,
        crowns: Number.isFinite(Number(b.crowns)) ? Number(b.crowns) : null,
      },
    });

    res.json({ ok: true });
  });
}
