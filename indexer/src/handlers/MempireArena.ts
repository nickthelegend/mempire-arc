// MempireArena: escrowed 1v1 matches, the on-chain play log, two-claim settlement.
//
// Money rules mirrored from the contract:
//   - decided match: winner is paid pot − rake; loser gets nothing
//   - tie: each seat gets (pot − rake) / 2
//   - void (disputed claims, or no claims by the deadline) and cancel: both
//     stakes go home — no player's net moves, no volume is counted
import { indexer, type Match, type MatchSeat, type Player } from "envio";
import {
  SEAT0,
  SEAT1,
  TIE,
  addr,
  currencyOf,
  daily,
  totals,
  logId,
  meta,
  patch,
  updateCoin,
  updatePlayer,
  winRateBps,
  type Ctx,
  type CurrencyName,
  type Meta,
} from "../lib/common.js";

const seatId = (matchId: string, seat: number) => `${matchId}-${seat}`;

/** Resolve each deck card to its coin. Cards are immutable in their coin, so this is safe at any time. */
async function coinsOf(ctx: Ctx, cardIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of cardIds) {
    const card = await ctx.Card.get(id);
    if (card === undefined) ctx.log.warn(`deck card ${id} not indexed`);
    out.push(card?.coin_id ?? "");
  }
  return out;
}

function newSeat(
  match: Pick<Match, "id" | "currency" | "stake">,
  seat: number,
  player: string,
  opponent: string | undefined,
  power: number,
  cardIds: string[],
  coinIds: string[],
  ts: number,
): MatchSeat {
  return {
    id: seatId(match.id, seat),
    match_id: match.id,
    player_id: player,
    opponent_id: opponent,
    seat,
    currency: match.currency,
    stake: match.stake,
    power,
    cardIds,
    coinIds,
    plays: 0,
    result: "Pending",
    payout: 0n,
    net: 0n,
    createdAt: ts,
    endedAt: undefined,
  };
}

function addNet(p: Player, currency: CurrencyName, net: bigint, wagered: bigint): Player {
  return currency === "MON"
    ? { ...p, netMon: p.netMon + net, wageredMon: p.wageredMon + wagered }
    : { ...p, netAusd: p.netAusd + net, wageredAusd: p.wageredAusd + wagered };
}

// ───────────────────────────────────────────────────────────── lifecycle

indexer.onEvent({ contract: "MempireArena", event: "MatchCreated" }, async ({ event, context }) => {
  const m = meta(event);
  const p = event.params;
  const id = p.matchId.toString();
  const player = addr(p.player);
  const cardIds = p.cardIds.map((c) => c.toString());
  const coinIds = await coinsOf(context, cardIds);

  const match: Match = {
    id,
    matchId: p.matchId,
    state: "Open",
    tier: Number(p.tier),
    currency: currencyOf(p.currency),
    currencyAddress: addr(p.currency),
    stake: p.stake,
    player0_id: player,
    player1_id: undefined,
    session0: addr(p.session),
    session1: undefined,
    power0: Number(p.power),
    power1: undefined,
    deckHash0: p.deckHash,
    deckHash1: undefined,
    metaEpoch: undefined,
    marketEpoch_id: undefined,
    plays0: 0,
    plays1: 0,
    playCount: 0,
    lastTick0: 0,
    lastTick1: 0,
    checkpointCount: 0,
    claim0: undefined,
    claim1: undefined,
    final0: undefined,
    final1: undefined,
    claimCount: 0,
    outcome: undefined,
    winnerSeat: undefined,
    winner_id: undefined,
    byTimeout: false,
    disputed: false,
    voidReason: undefined,
    pot: 0n,
    rake: 0n,
    winnerPayout: 0n,
    tiePayoutEach: 0n,
    winReward: 0n,
    chestTier: undefined,
    chestForfeited: false,
    createdAt: m.ts,
    joinedAt: undefined,
    deadline: undefined,
    endedAt: undefined,
    durationSeconds: undefined,
    createdTxHash: m.tx,
    endedTxHash: undefined,
  };
  context.Match.set(match);
  context.MatchSeat.set(newSeat(match, SEAT0, player, undefined, match.power0, cardIds, coinIds, m.ts));

  for (const coinId of coinIds) {
    if (coinId) await updateCoin(context, coinId, (c) => ({ ...c, deckAppearances: c.deckAppearances + 1 }));
  }
  await updatePlayer(context, player, m, (x) => ({ ...x, matchesCreated: x.matchesCreated + 1 }));
  await daily(context, m.ts, (d) => ({ ...d, matchesCreated: d.matchesCreated + 1 }));
});

indexer.onEvent({ contract: "MempireArena", event: "MatchJoined" }, async ({ event, context }) => {
  const m = meta(event);
  const p = event.params;
  const id = p.matchId.toString();
  const match = await context.Match.get(id);
  if (match === undefined) {
    context.log.warn(`MatchJoined for unknown match ${id}`);
    return;
  }
  const player = addr(p.player);
  const cardIds = p.cardIds.map((c) => c.toString());
  const coinIds = await coinsOf(context, cardIds);

  // Matches snapshot the market-meta epoch at join; 0 means no meta posted yet.
  const epochId = p.metaEpoch > 0n ? p.metaEpoch.toString() : undefined;
  const epoch = epochId ? await patch(context.MarketEpoch, epochId, (e) => ({ ...e, matches: e.matches + 1 })) : undefined;

  const next: Match = {
    ...match,
    state: "Active",
    player1_id: player,
    session1: addr(p.session),
    power1: Number(p.power),
    deckHash1: p.deckHash,
    metaEpoch: p.metaEpoch,
    marketEpoch_id: epoch?.id,
    joinedAt: m.ts,
    deadline: Number(p.deadline),
  };
  context.Match.set(next);
  context.MatchSeat.set(newSeat(next, SEAT1, player, match.player0_id, Number(p.power), cardIds, coinIds, m.ts));
  await patch(context.MatchSeat, seatId(id, SEAT0), (s) => ({ ...s, opponent_id: player }));

  for (const coinId of coinIds) {
    if (coinId) await updateCoin(context, coinId, (c) => ({ ...c, deckAppearances: c.deckAppearances + 1 }));
  }
  await updatePlayer(context, player, m, (x) => ({ ...x, matches: x.matches + 1 }));
  await updatePlayer(context, match.player0_id, m, (x) => ({ ...x, matches: x.matches + 1 }), false);
  await daily(context, m.ts, (d) => ({ ...d, matchesStarted: d.matchesStarted + 1 }));
  await totals(context, (g) => ({ ...g, matches: g.matches + 1 }));
});

indexer.onEvent({ contract: "MempireArena", event: "MatchCancelled" }, async ({ event, context }) => {
  const m = meta(event);
  const id = event.params.matchId.toString();
  const match = await patch(context.Match, id, (x): Match => ({
    ...x,
    state: "Cancelled",
    endedAt: m.ts,
    endedTxHash: m.tx,
  }));
  if (match === undefined) return;
  // The stake comes straight back: payout = stake, net 0.
  await patch(context.MatchSeat, seatId(id, SEAT0), (s): MatchSeat => ({ ...s, result: "Cancelled", payout: s.stake, endedAt: m.ts }));
  await updatePlayer(context, match.player0_id, m, (x) => ({ ...x, matchesCancelled: x.matchesCancelled + 1 }));
  await daily(context, m.ts, (d) => ({ ...d, matchesCancelled: d.matchesCancelled + 1 }));
});

// ───────────────────────────────────────────────────────────── the play log

indexer.onEvent({ contract: "MempireArena", event: "Played" }, async ({ event, context }) => {
  const m = meta(event);
  const p = event.params;
  const id = p.matchId.toString();
  const seat = Number(p.seat);
  const cardIndex = Number(p.cardIndex);
  const tick = Number(p.tick);

  const match = await context.Match.get(id);
  if (match === undefined) {
    context.log.warn(`Played for unknown match ${id}`);
    return;
  }
  const seatRow = await context.MatchSeat.get(seatId(id, seat));
  const coinId = seatRow?.coinIds[cardIndex] || undefined;
  const cardId = seatRow?.cardIds[cardIndex] || undefined;
  const seq = (seatRow?.plays ?? (seat === SEAT0 ? match.plays0 : match.plays1)) + 1;
  const playerId = seat === SEAT0 ? match.player0_id : match.player1_id;

  context.Play.set({
    id: logId(m),
    match_id: id,
    seat,
    player_id: playerId,
    tick,
    cardIndex,
    card_id: cardId,
    coin_id: coinId,
    x: Number(p.x),
    y: Number(p.y),
    seq,
    blockNumber: m.block,
    logIndex: m.logIndex,
    timestamp: m.ts,
    txHash: m.tx,
  });

  context.Match.set(
    seat === SEAT0
      ? { ...match, plays0: match.plays0 + 1, lastTick0: tick, playCount: match.playCount + 1 }
      : { ...match, plays1: match.plays1 + 1, lastTick1: tick, playCount: match.playCount + 1 },
  );
  if (seatRow) context.MatchSeat.set({ ...seatRow, plays: seq });
  if (coinId) await updateCoin(context, coinId, (c) => ({ ...c, timesPlayed: c.timesPlayed + 1 }));
  if (playerId) await updatePlayer(context, playerId, m, (x) => ({ ...x, plays: x.plays + 1 }));
  await daily(context, m.ts, (d) => ({ ...d, plays: d.plays + 1 }));
  await totals(context, (g) => ({ ...g, plays: g.plays + 1 }));
});

indexer.onEvent({ contract: "MempireArena", event: "Checkpoint" }, async ({ event, context }) => {
  const m = meta(event);
  const id = event.params.matchId.toString();
  const match = await patch(context.Match, id, (x) => ({ ...x, checkpointCount: x.checkpointCount + 1 }));
  if (match === undefined) return;
  context.Checkpoint.set({
    id: logId(m),
    match_id: id,
    seat: Number(event.params.seat),
    tick: Number(event.params.tick),
    stateHash: event.params.stateHash,
    blockNumber: m.block,
    timestamp: m.ts,
    txHash: m.tx,
  });
  await daily(context, m.ts, (d) => ({ ...d, checkpoints: d.checkpoints + 1 }));
});

indexer.onEvent({ contract: "MempireArena", event: "Claimed" }, async ({ event, context }) => {
  const m = meta(event);
  const id = event.params.matchId.toString();
  const seat = Number(event.params.seat);
  const winner = Number(event.params.winner);
  const finalHash = event.params.finalHash;
  const match = await patch(context.Match, id, (x) =>
    seat === SEAT0
      ? { ...x, claim0: winner, final0: finalHash, claimCount: x.claimCount + 1 }
      : { ...x, claim1: winner, final1: finalHash, claimCount: x.claimCount + 1 },
  );
  if (match === undefined) return;
  const playerId = seat === SEAT0 ? match.player0_id : match.player1_id;
  context.Claim.set({
    id: seatId(id, seat),
    match_id: id,
    seat,
    player_id: playerId,
    winner,
    finalHash,
    timestamp: m.ts,
    txHash: m.tx,
  });
  if (playerId) await updatePlayer(context, playerId, m, (x) => x);
});

// ───────────────────────────────────────────────────────────── settlement

type Result = "Win" | "Loss" | "Tie";

/** Credit a seat's fighters (coins) and cards with a result, split by the market modifier they carried. */
async function creditDeck(ctx: Ctx, seat: MatchSeat, result: Result, metaEpoch: bigint | undefined) {
  for (let i = 0; i < seat.coinIds.length; i++) {
    const coinId = seat.coinIds[i];
    const cardId = seat.cardIds[i];
    if (cardId) {
      await patch(ctx.Card, cardId, (c) => ({
        ...c,
        matchesFielded: c.matchesFielded + 1,
        wins: c.wins + (result === "Win" ? 1 : 0),
        losses: c.losses + (result === "Loss" ? 1 : 0),
        ties: c.ties + (result === "Tie" ? 1 : 0),
      }));
    }
    if (!coinId) continue;
    const mod = metaEpoch && metaEpoch > 0n ? await ctx.CoinModifier.get(`${metaEpoch}-${coinId}`) : undefined;
    const bps = mod?.bps ?? 0;
    await updateCoin(ctx, coinId, (c) => {
      const wins = c.wins + (result === "Win" ? 1 : 0);
      const losses = c.losses + (result === "Loss" ? 1 : 0);
      return {
        ...c,
        fielded: c.fielded + 1,
        wins,
        losses,
        ties: c.ties + (result === "Tie" ? 1 : 0),
        winRateBps: winRateBps(wins, losses),
        winsBuffed: c.winsBuffed + (result === "Win" && bps > 0 ? 1 : 0),
        lossesBuffed: c.lossesBuffed + (result === "Loss" && bps > 0 ? 1 : 0),
        winsNerfed: c.winsNerfed + (result === "Win" && bps < 0 ? 1 : 0),
        lossesNerfed: c.lossesNerfed + (result === "Loss" && bps < 0 ? 1 : 0),
      };
    });
  }
}

indexer.onEvent({ contract: "MempireArena", event: "MatchSettled" }, async ({ event, context }) => {
  const m = meta(event);
  const p = event.params;
  const id = p.matchId.toString();
  const match = await context.Match.get(id);
  const s0 = await context.MatchSeat.get(seatId(id, SEAT0));
  const s1 = await context.MatchSeat.get(seatId(id, SEAT1));
  if (match === undefined || s0 === undefined || s1 === undefined) {
    context.log.warn(`MatchSettled for unknown match ${id}`);
    return;
  }
  const winner = Number(p.winner);
  const currency = currencyOf(p.currency);
  const { pot, rake, byTimeout } = p;
  const stake = match.stake;
  const isTie = winner === TIE;

  // What each seat was paid. A tie splits pot − rake evenly (the contract gives the odd unit to rake).
  const tieEach = isTie ? (pot - rake) / 2n : 0n;
  const winnerPayout = isTie ? 0n : pot - rake;
  const payout0 = isTie ? tieEach : winner === SEAT0 ? winnerPayout : 0n;
  const payout1 = isTie ? tieEach : winner === SEAT1 ? winnerPayout : 0n;
  const result0: Result = isTie ? "Tie" : winner === SEAT0 ? "Win" : "Loss";
  const result1: Result = isTie ? "Tie" : winner === SEAT1 ? "Win" : "Loss";

  context.Match.set({
    ...match,
    state: "Settled",
    outcome: isTie ? "Tie" : winner === SEAT0 ? "Seat0" : "Seat1",
    winnerSeat: winner,
    winner_id: isTie ? undefined : addr(p.winnerAddress),
    byTimeout,
    pot,
    rake,
    winnerPayout,
    tiePayoutEach: tieEach,
    endedAt: m.ts,
    durationSeconds: match.joinedAt === undefined ? undefined : m.ts - match.joinedAt,
    endedTxHash: m.tx,
  });
  // Lets the chest and reward events later in this transaction find the match.
  context.SettlementTx.set({ id: m.tx, match_id: id });

  context.MatchSeat.set({ ...s0, result: result0, payout: payout0, net: payout0 - stake, endedAt: m.ts });
  context.MatchSeat.set({ ...s1, result: result1, payout: payout1, net: payout1 - stake, endedAt: m.ts });

  const credit = (result: Result, payout: bigint) => (x: Player): Player => {
    const withNet = addNet(x, currency, payout - stake, stake);
    return {
      ...withNet,
      wins: withNet.wins + (result === "Win" ? 1 : 0),
      winsByTimeout: withNet.winsByTimeout + (result === "Win" && byTimeout ? 1 : 0),
      losses: withNet.losses + (result === "Loss" ? 1 : 0),
      ties: withNet.ties + (result === "Tie" ? 1 : 0),
    };
  };
  // Both seats acted unless this was a walkover; the timeout caller may be anyone.
  await updatePlayer(context, s0.player_id, m, credit(result0, payout0), !byTimeout);
  await updatePlayer(context, s1.player_id, m, credit(result1, payout1), !byTimeout);

  await creditDeck(context, s0, result0, match.metaEpoch);
  await creditDeck(context, s1, result1, match.metaEpoch);

  await daily(context, m.ts, (d) => ({
    ...d,
    matchesSettled: d.matchesSettled + 1,
    ties: d.ties + (isTie ? 1 : 0),
    volumeMon: d.volumeMon + (currency === "MON" ? pot : 0n),
    volumeAusd: d.volumeAusd + (currency === "AUSD" ? pot : 0n),
    rakeMon: d.rakeMon + (currency === "MON" ? rake : 0n),
    rakeAusd: d.rakeAusd + (currency === "AUSD" ? rake : 0n),
  }));
  await totals(context, (g) => ({
    ...g,
    matchesSettled: g.matchesSettled + 1,
    volumeMon: g.volumeMon + (currency === "MON" ? pot : 0n),
    volumeAusd: g.volumeAusd + (currency === "AUSD" ? pot : 0n),
    rakeMon: g.rakeMon + (currency === "MON" ? rake : 0n),
    rakeAusd: g.rakeAusd + (currency === "AUSD" ? rake : 0n),
  }));
});

indexer.onEvent({ contract: "MempireArena", event: "MatchVoided" }, async ({ event, context }) => {
  const m = meta(event);
  const id = event.params.matchId.toString();
  const disputed = event.params.disputed;
  const match = await patch(context.Match, id, (x): Match => ({
    ...x,
    state: "Voided",
    outcome: "Void",
    winnerSeat: undefined,
    winner_id: undefined,
    disputed,
    voidReason: disputed ? "Disputed" : "NoClaims",
    // A no-claims void only happens through claimTimeout after the deadline.
    byTimeout: !disputed,
    endedAt: m.ts,
    durationSeconds: x.joinedAt === undefined ? undefined : m.ts - x.joinedAt,
    endedTxHash: m.tx,
  }));
  if (match === undefined) return;

  // Both stakes refunded: payout = stake, net 0. No money moves in the stats.
  for (const seat of [SEAT0, SEAT1]) {
    await patch(context.MatchSeat, seatId(id, seat), (s): MatchSeat => ({
      ...s,
      result: "Void",
      payout: s.stake,
      net: 0n,
      endedAt: m.ts,
    }));
  }
  const touch = (pid: string | undefined, active: boolean, mm: Meta) =>
    pid ? updatePlayer(context, pid, mm, (x) => ({ ...x, voids: x.voids + 1 }), active) : undefined;
  await touch(match.player0_id, disputed, m);
  await touch(match.player1_id, disputed, m);
  await daily(context, m.ts, (d) => ({ ...d, matchesVoided: d.matchesVoided + 1 }));
  await totals(context, (g) => ({ ...g, matchesVoided: g.matchesVoided + 1 }));
});

indexer.onEvent({ contract: "MempireArena", event: "WinRewarded" }, async ({ event, context }) => {
  const m = meta(event);
  const amount = event.params.amount;
  await patch(context.Match, event.params.matchId.toString(), (x) => ({ ...x, winReward: amount }));
  await updatePlayer(
    context,
    event.params.player,
    m,
    (x) => ({
      ...x,
      rewardedWins: Number(event.params.rewardedWins),
      rewardsMempire: x.rewardsMempire + amount,
    }),
    false,
  );
  await daily(context, m.ts, (d) => ({ ...d, rewardsMempire: d.rewardsMempire + amount }));
});

indexer.onEvent({ contract: "MempireArena", event: "PayoutHeld" }, async ({ event, context }) => {
  const m = meta(event);
  const player = addr(event.params.player);
  const currency = currencyOf(event.params.currency);
  const amount = event.params.amount;
  context.HeldPayout.set({ id: logId(m), player, currency, amount, timestamp: m.ts, txHash: m.tx });
  // Only players have a row; a refused rake to the treasury is logged but not credited.
  await patch(context.Player, player, (x) =>
    currency === "MON" ? { ...x, heldMon: x.heldMon + amount } : { ...x, heldAusd: x.heldAusd + amount },
  );
});
