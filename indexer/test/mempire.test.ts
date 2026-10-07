// Handler tests: simulated events through the real handlers, no network.
//   pnpm codegen && pnpm test
import { describe, it } from "vitest";
import { createTestIndexer, type Address } from "envio";
import { encodeAbiParameters, parseAbiParameters } from "viem";

const ALICE: Address = "0x000000000000000000000000000000000000a11c";
const BOB: Address = "0x0000000000000000000000000000000000000b0b";
const SESSION_A: Address = "0x000000000000000000000000000000000005e55a";
const SESSION_B: Address = "0x000000000000000000000000000000000005e55b";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** Arc's USDC ERC-20 interface — the arena's only stake currency. */
const USDC: Address = "0x3600000000000000000000000000000000000000";
const CHAIN = 5042002; // Arc testnet

const USD = 10n ** 6n; // USDC, 6 decimals
const ETHER = 10n ** 18n; // $MEMPIRE, 18 decimals
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

/** MarketMeta.MetaSource: 0 = Chainlink CRE, 1 = Chainlink Data Feeds momentum (postFromFeeds). */
const metaSource = (epoch: number, source: number, poster: Address) => ({
  contract: "MarketMeta" as const,
  event: "MetaSource" as const,
  params: { epoch: BigInt(epoch), source: BigInt(source), poster },
});

const createMatch = (matchId: number, player: Address, tier: number, stake: bigint, cardIds: number[], currency: Address = USDC) => ({
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

const settled = (matchId: number, winner: number, pot: bigint, rake: bigint, winnerAddress: Address, byTimeout = false, currency: Address = USDC) => ({
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
// The first twelve fighters in shared/roster.json order (Chainlink Data Feeds on Arc).
const TICKERS = ["BTC", "ETH", "SOL", "BNB", "XRP", "AVAX", "TRX", "BCH", "HYPE", "LINK", "UNI", "AAVE"];

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
    const stake = 5n * USD; // Knight tier: 5 USDC
    const pot = stake * 2n;
    const rake = pot / 10n;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...setupRosterAndDecks(tx),
            // Epoch 1: BTC (coin 0) buffed, HYPE (coin 8) nerfed.
            ...tx([metaPosted(1, [0, 8], [1200, -900])]),
            ...tx([createMatch(1, ALICE, 1, stake, ALICE_DECK)]),
            ...tx([joinMatch(1, BOB, BOB_DECK, 1, 1_760_000_600)], 5),
            ...tx([played(1, 0, 40, 0, -3, 7)]), // Alice drops card 1 → BTC
            ...tx([played(1, 1, 55, 2, 4, -6)]), // Bob drops card 11 → coin 6 (TRX)
            ...tx([checkpoint(1, 0, 100, 0xabcdefn)]),
            ...tx([played(1, 0, 120, 4, 0, 2)]), // Alice drops card 5 → coin 4 (XRP)
            ...tx([claimed(1, 0, 0)], 180),
            // The second claim settles in the same transaction: Claimed → MatchSettled → WinRewarded → ChestGranted.
            ...tx([
              claimed(1, 1, 0),
              settled(1, 0, pot, rake, ALICE),
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
      currencyAddress: match.currencyAddress,
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
      currency: "USDC",
      currencyAddress: USDC,
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
    t.expect([alice.matches, alice.wins, alice.losses, alice.netUsdc, alice.wageredUsdc, alice.plays]).toEqual([
      1, 1, 0, pot - rake - stake, stake, 2,
    ]);
    t.expect([bob.matches, bob.wins, bob.losses, bob.netUsdc, bob.wageredUsdc, bob.plays]).toEqual([1, 0, 1, -stake, stake, 1]);
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
      volumeUsdc: day.volumeUsdc,
      rakeUsdc: day.rakeUsdc,
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
      volumeUsdc: pot,
      rakeUsdc: rake,
      plays: 3,
      checkpoints: 1,
      cardsMinted: 16,
      chestsGranted: 1,
      rewardsMempire: 50n * ETHER,
      uniquePlayers: 2,
      newPlayers: 2,
    });

    const totals = await indexer.Totals.getOrThrow("global");
    t.expect([totals.players, totals.coins, totals.matches, totals.matchesSettled, totals.plays, totals.volumeUsdc, totals.rakeUsdc]).toEqual([
      2, 12, 1, 1, 3, pot, rake,
    ]);
  });

  it("a tie splits pot − rake evenly; a walkover pays the pot but counts as a timeout win", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const stake = 5n * USD; // Knight tier: 5 USDC
    const pot = stake * 2n;
    const rake = 500_000n; // 5% tie rake
    const half = (pot - rake) / 2n;
    const stake2 = 1n * USD; // Pauper tier: 1 USDC
    const pot2 = stake2 * 2n;
    const rake2 = pot2 / 10n;

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...setupRosterAndDecks(tx),
            ...tx([createMatch(1, ALICE, 1, stake, ALICE_DECK)]),
            ...tx([joinMatch(1, BOB, BOB_DECK, 0, 1_760_000_600)]),
            ...tx([claimed(1, 0, 2)]),
            ...tx([claimed(1, 1, 2), settled(1, 2, pot, rake, ZERO)]),
            // Match 2, Pauper: Bob never claims; Alice's claim stands after the deadline.
            ...tx([createMatch(2, ALICE, 0, stake2, ALICE_DECK)]),
            ...tx([joinMatch(2, BOB, BOB_DECK, 0, 1_760_001_000)]),
            ...tx([claimed(2, 0, 0)]),
            ...tx([settled(2, 0, pot2, rake2, ALICE, true)], 600),
          ],
        },
      },
    });

    const m1 = await indexer.Match.getOrThrow("1");
    t.expect([m1.outcome, m1.winner_id, m1.tiePayoutEach, m1.currency, m1.marketEpoch_id]).toEqual([
      "Tie", undefined, half, "USDC", undefined,
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
    // Net USDC sums across both matches: the tie's half-pot and the walkover.
    t.expect([alice.ties, alice.wins, alice.winsByTimeout, alice.netUsdc, alice.wageredUsdc]).toEqual([
      1, 1, 1, half - stake + (pot2 - rake2 - stake2), stake + stake2,
    ]);
    t.expect([bob.ties, bob.losses, bob.netUsdc]).toEqual([1, 1, half - stake - stake2]);
    const day = (await indexer.DailyStats.getAll())[0]!;
    t.expect([day.volumeUsdc, day.rakeUsdc, day.ties]).toEqual([pot + pot2, rake + rake2, 1]);
    // Tie: coins credited a tie on both sides, winRate untouched.
    const btc = await indexer.Coin.getOrThrow("0");
    t.expect([btc.ties, btc.wins, btc.fielded]).toEqual([1, 1, 2]);
  });

  it("a disputed void refunds both stakes and moves no money", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const stake = 25n * USD; // Duke tier: 25 USDC

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...setupRosterAndDecks(tx),
            ...tx([createMatch(7, ALICE, 2, stake, ALICE_DECK)]),
            ...tx([joinMatch(7, BOB, BOB_DECK, 0, 1_760_000_600)]),
            ...tx([played(7, 0, 10, 0, 1, 1)]),
            ...tx([claimed(7, 0, 0)]), // Alice says Alice won
            ...tx([claimed(7, 1, 1), voided(7, true)]), // Bob says Bob won → void
            // An open match nobody joined, cancelled: also no money.
            ...tx([createMatch(8, ALICE, 0, USD, [17])]),
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
      t.expect([p.voids, p.wins, p.losses, p.netUsdc, p.wageredUsdc]).toEqual([1, 0, 0, 0n, 0n]);
    }
    const btc = await indexer.Coin.getOrThrow("0");
    t.expect([btc.fielded, btc.wins, btc.losses, btc.deckAppearances]).toEqual([0, 0, 0, 1]);

    const cancelled = await indexer.Match.getOrThrow("8");
    t.expect(cancelled.state).toBe("Cancelled");
    t.expect((await indexer.Player.getOrThrow(ALICE)).matchesCancelled).toBe(1);

    const day = (await indexer.DailyStats.getAll())[0]!;
    t.expect([day.matchesVoided, day.matchesSettled, day.matchesCancelled, day.volumeUsdc, day.rakeUsdc]).toEqual([1, 0, 1, 0n, 0n]);
    const totals = await indexer.Totals.getOrThrow("global");
    t.expect([totals.matchesVoided, totals.matchesSettled, totals.volumeUsdc]).toEqual([1, 0, 0n]);
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
            // postFromFeeds, ten minutes later.
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
      "ChainlinkFeeds",
      1,
      KEEPER.toLowerCase(),
      -1500,
      "1",
    ]);
    t.expect([e12.source, e12.coinCount, e12.maxBps, e12.topCoin_id]).toEqual(["ChainlinkFeeds", 1, 50, "1"]);
    t.expect((await indexer.Coin.getOrThrow("1")).currentModifierBps).toBe(50);
    t.expect((await indexer.Totals.getOrThrow("global")).currentEpoch).toBe(12n);
  });
});

describe("Arc port: held payouts, arena limits, contract wiring", () => {
  it("PayoutHeld credits the player's heldUsdc; a refused rake to a non-player is logged only", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const TREASURY: Address = "0x00000000000000000000000000000000000057a5";
    const held = (player: Address, amount: bigint) => ({
      contract: "MempireArena" as const,
      event: "PayoutHeld" as const,
      params: { currency: USDC, player, amount },
    });
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...tx(mintCard(1, ALICE, 0)), // gives Alice a Player row
            ...tx([held(ALICE, 9n * USD), held(TREASURY, USD)]),
            ...tx([held(ALICE, USD / 2n)]),
          ],
        },
      },
    });
    t.expect((await indexer.Player.getOrThrow(ALICE)).heldUsdc).toBe(9n * USD + USD / 2n);
    t.expect(await indexer.Player.get(TREASURY)).toBeUndefined();
    const rows = await indexer.HeldPayout.getAll();
    t.expect(rows.map((r) => [r.player, r.currency, r.amount]).sort((a, b) => String(a[2]).localeCompare(String(b[2])))).toEqual(
      [
        [ALICE, "USDC", 9n * USD],
        [TREASURY, "USDC", USD],
        [ALICE, "USDC", USD / 2n],
      ].sort((a, b) => String(a[2]).localeCompare(String(b[2]))),
    );
  });

  it("LimitsChanged keeps one ArenaLimits row with the latest max tier and pause switch", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const limits = (maxTier: number, paused: boolean) => ({
      contract: "MempireArena" as const,
      event: "LimitsChanged" as const,
      params: { maxTier: BigInt(maxTier), paused },
    });
    await indexer.process({
      chains: { [CHAIN]: { simulate: [...tx([limits(1, false)]), ...tx([limits(1, true)], 60), ...tx([limits(3, false)], 60)] } },
    });
    const row = await indexer.ArenaLimits.getOrThrow("arena");
    t.expect([row.maxTier, row.paused, row.changes]).toEqual([3, false, 3]);
    t.expect((await indexer.ArenaLimits.getAll()).length).toBe(1);
  });

  it("EntryGatewayChanged and MarketMeta.CardsChanged are logged as AdminChange rows", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const GATEWAY: Address = "0x000000000000000000000000000000000000ccc1";
    const CARDS: Address = "0x000000000000000000000000000000000000CA5D";
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...tx([{ contract: "MarketMeta" as const, event: "CardsChanged" as const, params: { cards: CARDS } }]),
            ...tx([{ contract: "MempireArena" as const, event: "EntryGatewayChanged" as const, params: { gateway: GATEWAY } }]),
          ],
        },
      },
    });
    const rows = (await indexer.AdminChange.getAll()).sort((a, b) => a.timestamp - b.timestamp);
    t.expect(rows.map((r) => [r.contract, r.change, r.address, r.coinId])).toEqual([
      ["MarketMeta", "CardsChanged", CARDS.toLowerCase(), undefined],
      ["MempireArena", "EntryGatewayChanged", GATEWAY, undefined],
    ]);
  });
});

describe("Chainlink Data Feeds roster", () => {
  /** The real roster feed ids: keccak256 of the Chainlink pair. */
  const BTC_FEED_ID: Address = "0x0e3e290fbc572c3c2d1656bd757b05413d2fc62474d95064641dcabee325eb93";
  const LINK_FEED_ID: Address = "0xaee369cb2f1f19ec8857a81c8ffed809ac5b13ee0990d33f399c5122fd601712";

  it("CoinRegistered fills name, kind, pair and decimals from shared/roster.json by feed id", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: tx([
            // Registered out of roster order: the feed id, not the coinId, finds the row.
            { contract: "MempireCards" as const, event: "CoinRegistered" as const, params: { coinId: 0n, feedId: LINK_FEED_ID, archetype: 2n, ticker: "LINK" } },
            { contract: "MempireCards" as const, event: "CoinRegistered" as const, params: { coinId: 1n, feedId: BTC_FEED_ID, archetype: 1n, ticker: "BTC" } },
          ]),
        },
      },
    });
    const link = await indexer.Coin.getOrThrow("0");
    const btc = await indexer.Coin.getOrThrow("1");
    t.expect([link.ticker, link.name, link.kind, link.pair, link.feedDecimals, link.feedId]).toEqual([
      "LINK", "Chainlink", "defi", "LINK / USD", 8, LINK_FEED_ID,
    ]);
    t.expect([btc.name, btc.kind, btc.pair]).toEqual(["Bitcoin", "crypto", "BTC / USD"]);
    // Arc testnet may price through a MirrorAggregator: no feed until CoinFeedChanged.
    t.expect([btc.feed, btc.feedChanges]).toEqual([undefined, 0]);
  });

  it("CoinFeedChanged repoints the coin at its new feed proxy and logs an AdminChange", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const FEED_A: Address = "0x00000000000000000000000000000000000FEED1";
    const FEED_B: Address = "0x00000000000000000000000000000000000feed2";
    const feedChanged = (coinId: number, feed: Address) => ({
      contract: "MempireCards" as const,
      event: "CoinFeedChanged" as const,
      params: { coinId: BigInt(coinId), feed },
    });
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...tx([registerCoin(0, "BTC")]),
            ...tx([feedChanged(0, FEED_A)]),
            ...tx([feedChanged(0, FEED_B)], 60),
          ],
        },
      },
    });
    const btc = await indexer.Coin.getOrThrow("0");
    t.expect([btc.feed, btc.feedChanges, btc.registered]).toEqual([FEED_B, 2, true]);
    const rows = (await indexer.AdminChange.getAll()).sort((a, b) => a.timestamp - b.timestamp);
    t.expect(rows.map((r) => [r.contract, r.change, r.address, r.coinId])).toEqual([
      ["MempireCards", "CoinFeedChanged", FEED_A.toLowerCase(), 0],
      ["MempireCards", "CoinFeedChanged", FEED_B, 0],
    ]);
  });
});

describe("cross-chain play (MempireCCIPGateway)", () => {
  const BASE_SELECTOR = 15971525489660198786n; // Chainlink CCIP selector for Base
  const ETH_SELECTOR = 5009297550715157269n; // Ethereum
  const REMOTE: Address = "0x00000000000000000000000000000000000ba5e1";
  const MSG = (n: number): Address => `0x${n.toString(16).padStart(64, "c")}`;
  const ENTER = 1;
  const CASH_OUT = 2;

  /** The message data MempireRemoteEntry sends: abi.encode(uint8 action, address player, bytes body). */
  const enterData = (player: Address, matchId: bigint) =>
    encodeAbiParameters(parseAbiParameters("uint8, address, bytes"), [
      ENTER,
      player,
      encodeAbiParameters(
        parseAbiParameters("(uint64 matchId, uint8 tier, uint256[] cardIds, address session, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)"),
        [{ matchId, tier: 0, cardIds: [1n, 2n, 3n], session: SESSION_A, permitDeadline: 1_760_003_600n, v: 27, r: HASH(1), s: HASH(2) }],
      ),
    ]);
  const cashOutData = (player: Address, amount: bigint) =>
    encodeAbiParameters(parseAbiParameters("uint8, address, bytes"), [
      CASH_OUT,
      player,
      encodeAbiParameters(
        parseAbiParameters("(uint256 amount, uint256 maxFee, uint32 minFinality, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)"),
        [{ amount, maxFee: 1_000n, minFinality: 1000, permitDeadline: 0n, v: 0, r: HASH(3), s: HASH(4) }],
      ),
    ]);

  const entered = (id: Address, player: Address, matchId: number, created: boolean) => ({
    contract: "MempireCCIPGateway" as const,
    event: "Entered" as const,
    params: { messageId: id, player, matchId: BigInt(matchId), created },
  });
  const cashedOut = (id: Address, player: Address, amount: bigint, domain: number) => ({
    contract: "MempireCCIPGateway" as const,
    event: "CashedOut" as const,
    params: { messageId: id, player, amount, domain: BigInt(domain) },
  });
  const failed = (id: Address, selector: bigint, data: Address, reason: Address = "0x4e487b71") => ({
    contract: "MempireCCIPGateway" as const,
    event: "MessageFailed" as const,
    params: {
      messageId: id,
      sourceChainSelector: selector,
      sender: encodeAbiParameters(parseAbiParameters("address"), [REMOTE]),
      data,
      reason,
    },
  });
  const recovered = (id: Address) => ({
    contract: "MempireCCIPGateway" as const,
    event: "MessageRecovered" as const,
    params: { messageId: id },
  });
  const remoteEntrySet = (selector: bigint, sender: Address, cctpDomain: number) => ({
    contract: "MempireCCIPGateway" as const,
    event: "RemoteEntrySet" as const,
    params: { selector, sender, cctpDomain: BigInt(cctpDomain) },
  });

  it("Entered and CashedOut record a delivered ENTER and CASH_OUT per player", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...setupRosterAndDecks(tx),
            // The gateway's createMatchFor: the arena logs MatchCreated, then the gateway Entered.
            ...tx([createMatch(1, ALICE, 0, USD, ALICE_DECK), entered(MSG(1), ALICE, 1, true)]),
            ...tx([joinMatch(1, BOB, BOB_DECK, 0, 1_760_000_900), entered(MSG(2), BOB, 1, false)], 30),
            ...tx([cashedOut(MSG(3), ALICE, 3n * USD / 2n, 6)], 600),
          ],
        },
      },
    });

    const create = await indexer.CrossChainMessage.getOrThrow(MSG(1));
    t.expect([create.status, create.action, create.player, create.matchId, create.match_id, create.created]).toEqual([
      "Entered", "Enter", ALICE, 1n, "1", true,
    ]);
    const join = await indexer.CrossChainMessage.getOrThrow(MSG(2));
    t.expect([join.status, join.player, join.created, join.completedAt]).toEqual(["Entered", BOB, false, join.createdAt]);
    const cash = await indexer.CrossChainMessage.getOrThrow(MSG(3));
    t.expect([cash.status, cash.action, cash.player, cash.amount, cash.cctpDomain, cash.matchId]).toEqual([
      "CashedOut", "CashOut", ALICE, 3n * USD / 2n, 6, undefined,
    ]);
    // The arena's own events still built the match.
    const match = await indexer.Match.getOrThrow("1");
    t.expect([match.state, match.player0_id, match.player1_id]).toEqual(["Active", ALICE, BOB]);
  });

  it("MessageFailed keeps the decoded message for retry; a successful retry ends Recovered", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    const joinData = enterData(BOB, 7n);
    const cashData = cashOutData(ALICE, 2n * USD);
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            // ENTER (join match 7) arrives before Bob's CCTP mint: it reverts and is stored.
            ...tx([failed(MSG(10), BASE_SELECTOR, joinData)]),
            // CASH_OUT without the permit: fails and stays failed.
            ...tx([failed(MSG(11), ETH_SELECTOR, cashData)], 30),
            // retryFailedMessage: the arena seats Bob, the gateway logs Entered then MessageRecovered.
            ...tx([entered(MSG(10), BOB, 7, false), recovered(MSG(10))], 900),
          ],
        },
      },
    });

    const retried = await indexer.CrossChainMessage.getOrThrow(MSG(10));
    t.expect([
      retried.status, retried.action, retried.player, retried.matchId, retried.created,
      retried.sourceChainSelector, retried.sender, retried.failData, retried.failReason,
    ]).toEqual(["Recovered", "Enter", BOB, 7n, false, BASE_SELECTOR, REMOTE, joinData, "0x4e487b71"]);
    t.expect(retried.failedAt).toBeLessThan(retried.recoveredAt!);
    t.expect(retried.completedAt).toBe(retried.recoveredAt);
    t.expect(retried.failedTxHash).not.toBe(retried.txHash);

    const stuck = await indexer.CrossChainMessage.getOrThrow(MSG(11));
    t.expect([stuck.status, stuck.action, stuck.player, stuck.amount, stuck.sourceChainSelector, stuck.completedAt]).toEqual([
      "Failed", "CashOut", ALICE, 2n * USD, ETH_SELECTOR, undefined,
    ]);
  });

  it("a failed ENTER that opens a new match (matchId 0) has no match yet; garbage data decodes as Unknown", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...tx([failed(MSG(20), BASE_SELECTOR, enterData(ALICE, 0n))]),
            ...tx([failed(MSG(21), BASE_SELECTOR, "0xdeadbeef")]),
          ],
        },
      },
    });
    const create = await indexer.CrossChainMessage.getOrThrow(MSG(20));
    t.expect([create.action, create.player, create.matchId, create.match_id]).toEqual(["Enter", ALICE, undefined, undefined]);
    const junk = await indexer.CrossChainMessage.getOrThrow(MSG(21));
    t.expect([junk.status, junk.action, junk.player]).toEqual(["Failed", "Unknown", undefined]);
  });

  it("RemoteEntrySet keeps one CCIPSource per selector (zero sender disallows it) and logs AdminChange", async (t) => {
    const indexer = createTestIndexer();
    const tx = chainClock();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...tx([remoteEntrySet(BASE_SELECTOR, REMOTE, 6), remoteEntrySet(ETH_SELECTOR, REMOTE, 0)]),
            ...tx([remoteEntrySet(ETH_SELECTOR, ZERO, 0)], 60),
          ],
        },
      },
    });
    const base = await indexer.CCIPSource.getOrThrow(BASE_SELECTOR.toString());
    const eth = await indexer.CCIPSource.getOrThrow(ETH_SELECTOR.toString());
    t.expect([base.sender, base.cctpDomain, base.enabled, base.changes]).toEqual([REMOTE, 6, true, 1]);
    t.expect([eth.sender, eth.cctpDomain, eth.enabled, eth.changes]).toEqual([ZERO, 0, false, 2]);
    const rows = await indexer.AdminChange.getAll();
    t.expect(rows.length).toBe(3);
    t.expect(rows.every((r) => r.contract === "MempireCCIPGateway" && r.change === "RemoteEntrySet")).toBe(true);
    t.expect(rows.map((r) => r.selector).sort()).toEqual([BASE_SELECTOR, ETH_SELECTOR, ETH_SELECTOR].sort());
  });
});
