// Handler tests: simulated events through the real handlers, no network.
//   pnpm codegen && pnpm test
import { describe, it } from "vitest";
import { createTestIndexer, type Address } from "envio";

const ALICE: Address = "0x000000000000000000000000000000000000a11c";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const SESSION_A: Address = "0x000000000000000000000000000000000005e55a";
const SESSION_B: Address = "0x000000000000000000000000000000000005e55b";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const AUSD: Address = "0x00000000000000000000000000000000000a05d0";
const CHAIN = 10143;

const ETHER = 10n ** 18n;
const FEED = (n: number): Address => `0x${n.toString(16).padStart(64, "0")}`;
const HASH = (n: number): Address => `0x${n.toString(16).padStart(64, "f")}`;

/**
 * A simulated transaction: every item shares one block, timestamp and tx hash,
 * and the clock moves forward with each call so process() batches stay ordered.
 */
function chainClock(startBlock = 1_000, startTs = 1_760_000_000) {
  let block = startBlock;
  let ts = startTs;
  let n = 0;
  return function tx<T extends object>(items: T[], advanceSeconds = 1) {
    block += 1;
    ts += advanceSeconds;
    n += 1;
    const hash = `0x${n.toString(16).padStart(64, "0")}`;
    return items.map((item) => ({
      ...item,
      block: { number: block, timestamp: ts },
      transaction: { hash },
    }));
  };
}

// Event builders ───────────────────────────────────────────────────────────

const registerCoin = (coinId: number, ticker: string) => ({
  contract: "MempireCards" as const,
  event: "CoinRegistered" as const,
  params: { coinId: BigInt(coinId), feedId: FEED(coinId + 1), archetype: BigInt(coinId % 6), ticker },
});

/** A mint is two logs: ERC-721 Transfer from zero, then CardMinted. */
const mintCard = (cardId: number, owner: Address, coinId: number, source = 2) => [
  {
    contract: "MempireCards" as const,
    event: "Transfer" as const,
    params: { from: ZERO, to: owner, tokenId: BigInt(cardId) },
  },
  {
    contract: "MempireCards" as const,
    event: "CardMinted" as const,
    params: {
      cardId: BigInt(cardId),
      owner,
      coinId: BigInt(coinId),
      archetype: BigInt(coinId % 6),
      source: BigInt(source),
      price: 0n,
      expo: 0n,
    },
  },
];

const metaPosted = (epoch: number, coinIds: number[], bps: number[]) => ({
  contract: "MarketMeta" as const,
  event: "MetaPosted" as const,
  params: { epoch: BigInt(epoch), coinIds: coinIds.map(BigInt), bps: bps.map(BigInt) },
});

/** MarketMeta.MetaSource: 0 = Chainlink CRE, 1 = Pyth momentum. */
const metaSource = (epoch: number, source: number, poster: Address) => ({
  contract: "MarketMeta" as const,
  event: "MetaSource" as const,
  params: { epoch: BigInt(epoch), source: BigInt(source), poster },
});

const createMatch = (matchId: number, player: Address, tier: number, currency: Address, stake: bigint, cardIds: number[]) => ({
  contract: "MempireArena" as const,
  event: "MatchCreated" as const,
  params: {
    matchId: BigInt(matchId),
    player,
    tier: BigInt(tier),
    currency,
    stake,
    power: BigInt(cardIds.length),
    deckHash: HASH(matchId * 10),
    cardIds: cardIds.map(BigInt),
    session: SESSION_A,
  },
});

const joinMatch = (matchId: number, player: Address, cardIds: number[], metaEpoch: number, deadline: number) => ({
  contract: "MempireArena" as const,
  event: "MatchJoined" as const,
  params: {
    matchId: BigInt(matchId),
    player,
    power: BigInt(cardIds.length),
    deckHash: HASH(matchId * 10 + 1),
    cardIds: cardIds.map(BigInt),
    session: SESSION_B,
    metaEpoch: BigInt(metaEpoch),
    deadline: BigInt(deadline),
  },
});

const played = (matchId: number, seat: number, tick: number, cardIndex: number, x: number, y: number) => ({
  contract: "MempireArena" as const,
  event: "Played" as const,
  params: { matchId: BigInt(matchId), seat: BigInt(seat), tick: BigInt(tick), cardIndex: BigInt(cardIndex), x: BigInt(x), y: BigInt(y) },
});

const checkpoint = (matchId: number, seat: number, tick: number, stateHash: bigint) => ({
  contract: "MempireArena" as const,
  event: "Checkpoint" as const,
  params: { matchId: BigInt(matchId), seat: BigInt(seat), tick: BigInt(tick), stateHash },
});

const claimed = (matchId: number, seat: number, winner: number) => ({
  contract: "MempireArena" as const,
  event: "Claimed" as const,
  params: { matchId: BigInt(matchId), seat: BigInt(seat), winner: BigInt(winner), finalHash: HASH(matchId * 100 + seat) },
});

const settled = (matchId: number, winner: number, currency: Address, pot: bigint, rake: bigint, winnerAddress: Address, byTimeout = false) => ({
  contract: "MempireArena" as const,
  event: "MatchSettled" as const,
  params: { matchId: BigInt(matchId), winner: BigInt(winner), currency, pot, rake, winnerAddress, byTimeout },
});

const voided = (matchId: number, disputed: boolean) => ({
  contract: "MempireArena" as const,
  event: "MatchVoided" as const,
  params: { matchId: BigInt(matchId), disputed },
});

/** Alice holds cards 1–8 (coins 0–7); Bob holds cards 9–16 (coins 4–11). Coins 4–7 sit in both decks. */
const ALICE_DECK = [1, 2, 3, 4, 5, 6, 7, 8];
const BOB_DECK = [9, 10, 11, 12, 13, 14, 15, 16];
const TICKERS = ["BTC", "ETH", "SOL", "MON", "BNB", "XRP", "DOGE", "AVAX", "LINK", "SHIB", "UNI", "ADA"];

function setupRosterAndDecks(tx: ReturnType<typeof chainClock>) {
  return [
    ...tx(TICKERS.map((t, i) => registerCoin(i, t))),
    ...tx(ALICE_DECK.flatMap((cardId, i) => mintCard(cardId, ALICE, i))),
    ...tx(BOB_DECK.flatMap((cardId, i) => mintCard(cardId, BOB, i + 4))),
  ];
}

// ─────────────────────────────────────────────────────────────── tests

describe("match lifecycle", () => {
  it("create → join → plays → two agreeing claims → settled updates Match, Player, Coin, Card, DailyStats", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const stake = (5n * ETHER) / 100n; // Knight tier, MON
    const pot = stake * 2n;
    const rake = pot / 10n;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...setupRosterAndDecks(tx),
            // Epoch 1: BTC (coin 0) buffed, LINK (coin 8) nerfed.
            ...tx([metaPosted(1, [0, 8], [1200, -900])]),
            ...tx([createMatch(1, ALICE, 1, ZERO, stake, ALICE_DECK)]),
            ...tx([joinMatch(1, BOB, BOB_DECK, 1, 1_760_000_600)], 5),
            ...tx([played(1, 0, 40, 0, -3, 7)]), // Alice drops card 1 → BTC
            ...tx([played(1, 1, 55, 2, 4, -6)]), // Bob drops card 11 → coin 6 (DOGE)
            ...tx([checkpoint(1, 0, 100, 0xabcdefn)]),
            ...tx([played(1, 0, 120, 4, 0, 2)]), // Alice drops card 5 → coin 4 (BNB)
            ...tx([claimed(1, 0, 0)], 180),
            // The second claim settles in the same transaction: Claimed → MatchSettled → WinRewarded → ChestGranted.
            ...tx([
              claimed(1, 1, 0),
              settled(1, 0, ZERO, pot, rake, ALICE),
              {
                contract: "MempireArena" as const,
                event: "WinRewarded" as const,
                params: { matchId: 1n, player: ALICE, amount: 50n * ETHER, rewardedWins: 1n },
              },
              {
                contract: "MempireCards" as const,
                event: "ChestGranted" as const,
                params: { chestId: 1n, owner: ALICE, tier: 1n, bought: false },
              },
            ]),
          ],
        },
      },
    });

    const match = await indexer.Match.getOrThrow("1");
    t.expect({
      state: match.state,
      outcome: match.outcome,
      winner: match.winner_id,
      winnerSeat: match.winnerSeat,
      currency: match.currency,
      plays0: match.plays0,
      plays1: match.plays1,
      playCount: match.playCount,
      lastTick0: match.lastTick0,
      checkpoints: match.checkpointCount,
      claims: [match.claim0, match.claim1, match.claimCount],
      pot: match.pot,
      rake: match.rake,
      winnerPayout: match.winnerPayout,
      metaEpoch: match.metaEpoch,
      marketEpoch: match.marketEpoch_id,
      durationSeconds: match.durationSeconds,
      byTimeout: match.byTimeout,
      winReward: match.winReward,
      chestTier: match.chestTier,
    }).toEqual({
      state: "Settled",
      outcome: "Seat0",
      winner: ALICE,
      winnerSeat: 0,
      currency: "MON",
      plays0: 2,
      plays1: 1,
      playCount: 3,
      lastTick0: 120,
      checkpoints: 1,
      claims: [0, 0, 2],
      pot,
      rake,
      winnerPayout: pot - rake,
      metaEpoch: 1n,
      marketEpoch: "1",
      // joined at +5s; then 5 one-second txs, a 180 s claim and the settling tx
      durationSeconds: 1 + 1 + 1 + 1 + 180 + 1,
      byTimeout: false,
      winReward: 50n * ETHER,
      chestTier: "Golden",
    });

    const alice = await indexer.Player.getOrThrow(ALICE);
    const bob = await indexer.Player.getOrThrow(BOB);
    t.expect([alice.matches, alice.wins, alice.losses, alice.netMon, alice.wageredMon, alice.plays]).toEqual([
      1, 1, 0, pot - rake - stake, stake, 2,
    ]);
    t.expect([bob.matches, bob.wins, bob.losses, bob.netMon, bob.netAusd, bob.plays]).toEqual([1, 0, 1, -stake, 0n, 1]);
    t.expect([alice.cardsOwned, alice.highestLevel, alice.rewardedWins, alice.rewardsMempire, alice.chestsEarned]).toEqual([
      8, 1, 1, 50n * ETHER, 1,
    ]);

    const seat0 = await indexer.MatchSeat.getOrThrow("1-0");
    const seat1 = await indexer.MatchSeat.getOrThrow("1-1");
    t.expect([seat0.result, seat0.payout, seat0.net, seat0.opponent_id, seat0.coinIds]).toEqual([
      "Win", pot - rake, pot - rake - stake, BOB, ["0", "1", "2", "3", "4", "5", "6", "7"],
    ]);
    t.expect([seat1.result, seat1.payout, seat1.net, seat1.plays]).toEqual(["Loss", 0n, -stake, 1]);

    // Coins: joined from deck cardIds, with the epoch-1 modifier split.
    const btc = await indexer.Coin.getOrThrow("0");
    t.expect([btc.ticker, btc.kind, btc.wins, btc.losses, btc.winRateBps, btc.winsBuffed, btc.currentModifierBps, btc.timesPlayed]).toEqual([
      "BTC", "crypto", 1, 0, 10_000, 1, 1200, 1,
    ]);
    const bnb = await indexer.Coin.getOrThrow("4"); // in both decks
    t.expect([bnb.deckAppearances, bnb.fielded, bnb.wins, bnb.losses, bnb.winRateBps]).toEqual([2, 2, 1, 1, 5_000]);
    const link = await indexer.Coin.getOrThrow("8"); // Bob only, nerfed
    t.expect([link.losses, link.lossesNerfed, link.currentModifierBps]).toEqual([1, 1, -900]);

    const card1 = await indexer.Card.getOrThrow("1");
    t.expect([card1.matchesFielded, card1.wins, card1.losses]).toEqual([1, 1, 0]);

    // The live feed: plays resolved to the card and coin from the seat's deck.
    const plays = (await indexer.Play.getAll()).sort((a, b) => a.blockNumber - b.blockNumber);
    t.expect(plays.map((p) => [p.seat, p.player_id, p.card_id, p.coin_id, p.x, p.y, p.seq])).toEqual([
      [0, ALICE, "1", "0", -3, 7, 1],
      [1, BOB, "11", "6", 4, -6, 1],
      [0, ALICE, "5", "4", 0, 2, 2],
    ]);

    const chest = await indexer.Chest.getOrThrow("1");
    t.expect([chest.owner_id, chest.tier, chest.state, chest.match_id]).toEqual([ALICE, "Golden", "Idle", "1"]);

    const days = await indexer.DailyStats.getAll();
    t.expect(days).toHaveLength(1);
    const day = days[0]!;
    t.expect({
      matchesCreated: day.matchesCreated,
      matchesStarted: day.matchesStarted,
      matchesSettled: day.matchesSettled,
      volumeMon: day.volumeMon,
      rakeMon: day.rakeMon,
      volumeAusd: day.volumeAusd,
      plays: day.plays,
      checkpoints: day.checkpoints,
      cardsMinted: day.cardsMinted,
      chestsGranted: day.chestsGranted,
      rewardsMempire: day.rewardsMempire,
      uniquePlayers: day.uniquePlayers,
      newPlayers: day.newPlayers,
    }).toEqual({
      matchesCreated: 1,
      matchesStarted: 1,
      matchesSettled: 1,
      volumeMon: pot,
      rakeMon: rake,
      volumeAusd: 0n,
      plays: 3,
      checkpoints: 1,
      cardsMinted: 16,
      chestsGranted: 1,
      rewardsMempire: 50n * ETHER,
      uniquePlayers: 2,
      newPlayers: 2,
    });

    const totals = await indexer.Totals.getOrThrow("global");
    t.expect([totals.players, totals.coins, totals.matches, totals.matchesSettled, totals.plays, totals.volumeMon]).toEqual([
      2, 12, 1, 1, 3, pot,
    ]);
  });

  it("a tie splits pot − rake evenly; a walkover pays the pot but counts as a timeout win", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const stake = 5_000_000n; // 5 AUSD
    const pot = stake * 2n;
    const rake = 500_000n; // 5% tie rake
    const half = (pot - rake) / 2n;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...setupRosterAndDecks(tx),
            ...tx([createMatch(1, ALICE, 1, AUSD, stake, ALICE_DECK)]),
            ...tx([joinMatch(1, BOB, BOB_DECK, 0, 1_760_000_600)]),
            ...tx([claimed(1, 0, 2)]),
            ...tx([claimed(1, 1, 2), settled(1, 2, AUSD, pot, rake, ZERO)]),
            // Match 2, MON: Bob never claims; Alice's claim stands after the deadline.
            ...tx([createMatch(2, ALICE, 0, ZERO, ETHER / 100n, ALICE_DECK)]),
            ...tx([joinMatch(2, BOB, BOB_DECK, 0, 1_760_001_000)]),
            ...tx([claimed(2, 0, 0)]),
            ...tx([settled(2, 0, ZERO, ETHER / 50n, ETHER / 500n, ALICE, true)], 600),
          ],
        },
      },
    });

    const m1 = await indexer.Match.getOrThrow("1");
    t.expect([m1.outcome, m1.winner_id, m1.tiePayoutEach, m1.currency, m1.marketEpoch_id]).toEqual([
      "Tie", undefined, half, "AUSD", undefined,
    ]);
    const s0 = await indexer.MatchSeat.getOrThrow("1-0");
    const s1 = await indexer.MatchSeat.getOrThrow("1-1");
    t.expect([s0.result, s0.payout, s0.net, s1.result, s1.payout, s1.net]).toEqual([
      "Tie", half, half - stake, "Tie", half, half - stake,
    ]);

    const m2 = await indexer.Match.getOrThrow("2");
    t.expect([m2.outcome, m2.byTimeout, m2.claimCount]).toEqual(["Seat0", true, 1]);

    const alice = await indexer.Player.getOrThrow(ALICE);
    const bob = await indexer.Player.getOrThrow(BOB);
    t.expect([alice.ties, alice.wins, alice.winsByTimeout, alice.netAusd]).toEqual([1, 1, 1, half - stake]);
    t.expect([bob.ties, bob.losses, bob.netAusd, bob.netMon]).toEqual([1, 1, half - stake, -(ETHER / 100n)]);
    // Tie: coins credited a tie on both sides, winRate untouched.
    const btc = await indexer.Coin.getOrThrow("0");
    t.expect([btc.ties, btc.wins, btc.fielded]).toEqual([1, 1, 2]);
  });

  it("a disputed void refunds both stakes and moves no money", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const stake = ETHER / 4n; // Duke tier

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...setupRosterAndDecks(tx),
            ...tx([createMatch(7, ALICE, 2, ZERO, stake, ALICE_DECK)]),
            ...tx([joinMatch(7, BOB, BOB_DECK, 0, 1_760_000_600)]),
            ...tx([played(7, 0, 10, 0, 1, 1)]),
            ...tx([claimed(7, 0, 0)]), // Alice says Alice won
            ...tx([claimed(7, 1, 1), voided(7, true)]), // Bob says Bob won → void
            // An open match nobody joined, cancelled: also no money.
            ...tx([createMatch(8, ALICE, 0, ZERO, ETHER / 100n, [17])]),
            ...tx([{ contract: "MempireArena" as const, event: "MatchCancelled" as const, params: { matchId: 8n, player: ALICE } }]),
          ],
        },
      },
    });

    const match = await indexer.Match.getOrThrow("7");
    t.expect([match.state, match.outcome, match.disputed, match.voidReason, match.winner_id, match.pot, match.claim0, match.claim1]).toEqual([
      "Voided", "Void", true, "Disputed", undefined, 0n, 0, 1,
    ]);
    for (const id of ["7-0", "7-1"]) {
      const seat = await indexer.MatchSeat.getOrThrow(id);
      t.expect([seat.result, seat.payout, seat.net]).toEqual(["Void", stake, 0n]);
    }
    for (const who of [ALICE, BOB]) {
      const p = await indexer.Player.getOrThrow(who);
      t.expect([p.voids, p.wins, p.losses, p.netMon, p.wageredMon]).toEqual([1, 0, 0, 0n, 0n]);
    }
    const btc = await indexer.Coin.getOrThrow("0");
    t.expect([btc.fielded, btc.wins, btc.losses, btc.deckAppearances]).toEqual([0, 0, 0, 1]);

    const cancelled = await indexer.Match.getOrThrow("8");
    t.expect(cancelled.state).toBe("Cancelled");
    t.expect((await indexer.Player.getOrThrow(ALICE)).matchesCancelled).toBe(1);

    const day = (await indexer.DailyStats.getAll())[0]!;
    t.expect([day.matchesVoided, day.matchesSettled, day.matchesCancelled, day.volumeMon, day.rakeMon]).toEqual([1, 0, 1, 0n, 0n]);
    const totals = await indexer.Totals.getOrThrow("global");
    t.expect([totals.matchesVoided, totals.matchesSettled, totals.volumeMon]).toEqual([1, 0, 0n]);
  });
});

describe("cards", () => {
  it("a merge burns the duplicate and levels the kept card; a transfer moves ownership", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const paid = 100n * ETHER;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...tx([registerCoin(0, "BTC")]),
            ...tx([...mintCard(1, ALICE, 0, 0), ...mintCard(2, ALICE, 0, 3)]),
            // merge(1, 2): the burn's Transfer comes first, then CardMerged.
            ...tx([
              { contract: "MempireCards" as const, event: "Transfer" as const, params: { from: ALICE, to: ZERO, tokenId: 2n } },
              {
                contract: "MempireCards" as const,
                event: "CardMerged" as const,
                params: { cardId: 1n, owner: ALICE, burned: 2n, level: 2n, paid },
              },
            ]),
          ],
        },
      },
    });

    const kept = await indexer.Card.getOrThrow("1");
    const burned = await indexer.Card.getOrThrow("2");
    t.expect([kept.level, kept.mergesAbsorbed, kept.burned, kept.source]).toEqual([2, 1, false, "Mint"]);
    t.expect([burned.burned, burned.mergedInto_id, burned.owner_id, burned.source]).toEqual([true, "1", ALICE, "Chest"]);

    const alice = await indexer.Player.getOrThrow(ALICE);
    t.expect([alice.cardsOwned, alice.cardsMinted, alice.highestLevel, alice.merges, alice.mergeSpent]).toEqual([1, 2, 2, 1, paid]);

    const btc = await indexer.Coin.getOrThrow("0");
    t.expect([btc.cardsMinted, btc.cardsBurned, btc.liveSupply, btc.merges, btc.maxLevel]).toEqual([2, 1, 1, 1, 2]);

    const merges = await indexer.Merge.getAll();
    t.expect(merges.map((m) => [m.card_id, m.burned_id, m.newLevel, m.paid, m.coin_id])).toEqual([["1", "2", 2, paid, "0"]]);

    // Sell the levelled card to Bob.
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: tx([
            { contract: "MempireCards" as const, event: "Transfer" as const, params: { from: ALICE, to: BOB, tokenId: 1n } },
          ]),
        },
      },
    });
    const moved = await indexer.Card.getOrThrow("1");
    t.expect([moved.owner_id, moved.transfers]).toEqual([BOB, 1]);
    t.expect((await indexer.Player.getOrThrow(ALICE)).cardsOwned).toBe(0);
    const bob = await indexer.Player.getOrThrow(BOB);
    t.expect([bob.cardsOwned, bob.highestLevel, bob.cardsMinted]).toEqual([1, 2, 0]);
  });

  it("a chest goes idle → unlocking → revealing → opened and links its drops", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...tx([registerCoin(0, "BTC"), registerCoin(1, "ETH")]),
            ...tx([{ contract: "MempireCards" as const, event: "ChestGranted" as const, params: { chestId: 3n, owner: ALICE, tier: 1n, bought: true } }]),
            ...tx([{ contract: "MempireCards" as const, event: "ChestOpening" as const, params: { chestId: 3n, revealBlock: 5000n } }]),
            ...tx([
              ...mintCard(40, ALICE, 1, 3),
              ...mintCard(41, ALICE, 0, 3),
              {
                contract: "MempireCards" as const,
                event: "ChestOpened" as const,
                params: { chestId: 3n, owner: ALICE, seed: HASH(9), cardIds: [40n, 41n] },
              },
            ]),
            // A win with all four slots full forfeits its chest.
            ...tx([{ contract: "MempireCards" as const, event: "ChestForfeited" as const, params: { owner: ALICE, tier: 0n } }]),
          ],
        },
      },
    });
    const chest = await indexer.Chest.getOrThrow("3");
    t.expect([chest.bought, chest.state, chest.cardIds, chest.revealBlock, chest.match_id]).toEqual([
      true, "Opened", ["40", "41"], 5000n, undefined,
    ]);
    t.expect((await indexer.Card.getOrThrow("40")).chest_id).toBe("3");
    const alice = await indexer.Player.getOrThrow(ALICE);
    t.expect([alice.chestsBought, alice.chestsOpened, alice.chestsForfeited, alice.cardsOwned]).toEqual([1, 1, 1, 2]);
  });
});

describe("market meta", () => {
  it("MetaPosted writes the epoch, per-coin modifiers, and resets coins left out of a later report", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...tx([registerCoin(0, "BTC"), registerCoin(1, "ETH"), registerCoin(2, "SOL")]),
            ...tx([metaPosted(1, [0, 1, 2], [1500, -300, 200])]),
          ],
        },
      },
    });

    const e1 = await indexer.MarketEpoch.getOrThrow("1");
    t.expect([e1.coinCount, e1.maxBps, e1.minBps, e1.topCoin_id, e1.bottomCoin_id]).toEqual([3, 1500, -300, "0", "1"]);
    t.expect((await indexer.CoinModifier.getOrThrow("1-1")).bps).toBe(-300);
    t.expect((await indexer.Coin.getOrThrow("0")).currentModifierBps).toBe(1500);

    await indexer.process({
      chains: { [CHAIN]: { simulate: tx([metaPosted(2, [1], [100])], 3600) } },
    });
    const coins = await Promise.all(["0", "1", "2"].map((id) => indexer.Coin.getOrThrow(id)));
    t.expect(coins.map((c) => [c.ticker, c.currentModifierBps, c.modifierEpoch])).toEqual([
      ["BTC", 0, 2n],
      ["ETH", 100, 2n],
      ["SOL", 0, 2n],
    ]);
    const e2 = await indexer.MarketEpoch.getOrThrow("2");
    t.expect([e2.coinCount, e2.topCoin_id, e2.bottomCoin_id]).toEqual([1, "1", "1"]);
    t.expect((await indexer.CoinModifier.getAll()).length).toBe(4);
    t.expect((await indexer.Totals.getOrThrow("global")).currentEpoch).toBe(2n);
  });

  it("MetaSource records which source wrote each epoch, whatever order the two logs arrive in", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const FORWARDER: Address = "0x00000000000000000000000000000000000f04d1";
    const KEEPER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...tx([registerCoin(0, "BTC"), registerCoin(1, "ETH")]),
            // onReport: MetaPosted, then MetaSource(CRE) in the same tx.
            ...tx([metaPosted(10, [0, 1], [400, -200]), metaSource(10, 0, FORWARDER)]),
            // postFromPyth, ten minutes later.
            ...tx([metaPosted(11, [0, 1], [-1500, 900]), metaSource(11, 1, KEEPER)], 600),
            // A MetaSource seen before its MetaPosted still ends up on the full row.
            ...tx([metaSource(12, 1, KEEPER), metaPosted(12, [1], [50])], 600),
          ],
        },
      },
    });

    const e10 = await indexer.MarketEpoch.getOrThrow("10");
    const e11 = await indexer.MarketEpoch.getOrThrow("11");
    const e12 = await indexer.MarketEpoch.getOrThrow("12");
    t.expect([e10.source, e10.sourceCode, e10.poster, e10.coinCount, e10.maxBps]).toEqual([
      "ChainlinkCRE",
      0,
      FORWARDER,
      2,
      400,
    ]);
    t.expect([e11.source, e11.sourceCode, e11.poster, e11.minBps, e11.topCoin_id]).toEqual([
      "PythMomentum",
      1,
      KEEPER.toLowerCase(),
      -1500,
      "1",
    ]);
    t.expect([e12.source, e12.coinCount, e12.maxBps, e12.topCoin_id]).toEqual(["PythMomentum", 1, 50, "1"]);
    t.expect((await indexer.Coin.getOrThrow("1")).currentModifierBps).toBe(50);
    t.expect((await indexer.Totals.getOrThrow("global")).currentEpoch).toBe(12n);
  });
});
