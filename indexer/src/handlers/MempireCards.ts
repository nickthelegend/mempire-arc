// MempireCards: the roster, every fighter NFT, merges and chests.
//
// Event order inside one transaction matters here:
//   mint        → Transfer(0 → owner) then CardMinted   (CardMinted creates the card)
//   merge       → Transfer(owner → 0) then CardMerged   (Transfer marks the burn)
//   chest open  → CardMinted × n then ChestOpened       (ChestOpened links the cards)
//   match win   → MatchSettled then ChestGranted/ChestForfeited (linked via SettlementTx)
import { indexer, type Card, type Chest } from "envio";
import {
  ARCHETYPE_NAMES,
  CARD_SOURCES,
  addr,
  chestTier,
  daily,
  totals,
  isZero,
  logId,
  maxInt,
  meta,
  patch,
  rosterFor,
  updateCoin,
  updatePlayer,
} from "../lib/common.js";

// ───────────────────────────────────────────────────────────── roster

indexer.onEvent({ contract: "MempireCards", event: "CoinRegistered" }, async ({ event, context }) => {
  const coinId = Number(event.params.coinId);
  const feedId = event.params.feedId.toLowerCase();
  const archetype = Number(event.params.archetype);
  const r = rosterFor(coinId, feedId);
  let firstTime = false;
  await updateCoin(context, coinId, (c) => {
    firstTime = !c.registered;
    return {
      ...c,
      ticker: event.params.ticker,
      name: r?.name ?? event.params.ticker,
      kind: r?.kind ?? "unknown",
      feedId,
      archetype,
      archetypeName: ARCHETYPE_NAMES[archetype] ?? `#${archetype}`,
      registered: true,
      active: true,
    };
  });
  if (firstTime) await totals(context, (g) => ({ ...g, coins: g.coins + 1 }));
});

indexer.onEvent({ contract: "MempireCards", event: "CoinActive" }, async ({ event, context }) => {
  await updateCoin(context, Number(event.params.coinId), (c) => ({ ...c, active: event.params.active }));
});

// ───────────────────────────────────────────────────────────── cards

indexer.onEvent({ contract: "MempireCards", event: "CardMinted" }, async ({ event, context }) => {
  const m = meta(event);
  const id = event.params.cardId.toString();
  const owner = addr(event.params.owner);
  const coinId = Number(event.params.coinId);
  const card: Card = {
    id,
    tokenId: event.params.cardId,
    owner_id: owner,
    coin_id: String(coinId),
    level: 1,
    archetype: Number(event.params.archetype),
    source: CARD_SOURCES[Number(event.params.source)] ?? "Mint",
    mintPrice: event.params.price,
    mintExpo: Number(event.params.expo),
    mintedAt: m.ts,
    mintTxHash: m.tx,
    chest_id: undefined,
    burned: false,
    burnedAt: undefined,
    mergedInto_id: undefined,
    mergesAbsorbed: 0,
    transfers: 0,
    matchesFielded: 0,
    wins: 0,
    losses: 0,
    ties: 0,
  };
  context.Card.set(card);

  await updatePlayer(context, owner, m, (p) => ({
    ...p,
    cardsOwned: p.cardsOwned + 1,
    cardsMinted: p.cardsMinted + 1,
    highestLevel: maxInt(p.highestLevel, 1),
  }));
  await updateCoin(context, coinId, (c) => ({
    ...c,
    cardsMinted: c.cardsMinted + 1,
    liveSupply: c.liveSupply + 1,
    maxLevel: maxInt(c.maxLevel, 1),
  }));
  await daily(context, m.ts, (d) => ({ ...d, cardsMinted: d.cardsMinted + 1 }));
  await totals(context, (g) => ({ ...g, cardsMinted: g.cardsMinted + 1 }));
});

indexer.onEvent({ contract: "MempireCards", event: "Transfer" }, async ({ event, context }) => {
  // A mint: CardMinted (same tx, next log) carries the details and creates the card.
  if (isZero(event.params.from)) return;

  const m = meta(event);
  const id = event.params.tokenId.toString();
  const card = await context.Card.get(id);
  if (card === undefined) {
    context.log.warn(`Transfer of unknown card ${id}`);
    return;
  }
  const from = addr(event.params.from);
  const to = addr(event.params.to);

  if (isZero(to)) {
    // A burn. The only burn path is a merge; CardMerged (next log) says into what.
    context.Card.set({ ...card, burned: true, burnedAt: m.ts });
    await updatePlayer(context, from, m, (p) => ({ ...p, cardsOwned: p.cardsOwned - 1 }));
    await updateCoin(context, card.coin_id, (c) => ({
      ...c,
      cardsBurned: c.cardsBurned + 1,
      liveSupply: c.liveSupply - 1,
    }));
    await totals(context, (g) => ({ ...g, cardsBurned: g.cardsBurned + 1 }));
    return;
  }

  context.Card.set({ ...card, owner_id: to, transfers: card.transfers + 1 });
  await updatePlayer(context, from, m, (p) => ({ ...p, cardsOwned: p.cardsOwned - 1 }));
  await updatePlayer(
    context,
    to,
    m,
    (p) => ({ ...p, cardsOwned: p.cardsOwned + 1, highestLevel: maxInt(p.highestLevel, card.level) }),
    false,
  );
});

indexer.onEvent({ contract: "MempireCards", event: "CardMerged" }, async ({ event, context }) => {
  const m = meta(event);
  const keepId = event.params.cardId.toString();
  const burnedId = event.params.burned.toString();
  const level = Number(event.params.level);
  const owner = addr(event.params.owner);

  const keep = await patch(context.Card, keepId, (c) => ({ ...c, level, mergesAbsorbed: c.mergesAbsorbed + 1 }));
  if (keep === undefined) {
    context.log.warn(`CardMerged into unknown card ${keepId}`);
    return;
  }
  await patch(context.Card, burnedId, (c) => ({ ...c, burned: true, burnedAt: c.burnedAt ?? m.ts, mergedInto_id: keepId }));

  context.Merge.set({
    id: logId(m),
    card_id: keepId,
    burned_id: burnedId,
    owner_id: owner,
    coin_id: keep.coin_id,
    newLevel: level,
    paid: event.params.paid,
    timestamp: m.ts,
    blockNumber: m.block,
    txHash: m.tx,
  });

  await updatePlayer(context, owner, m, (p) => ({
    ...p,
    merges: p.merges + 1,
    mergeSpent: p.mergeSpent + event.params.paid,
    highestLevel: maxInt(p.highestLevel, level),
  }));
  await updateCoin(context, keep.coin_id, (c) => ({ ...c, merges: c.merges + 1, maxLevel: maxInt(c.maxLevel, level) }));
  await daily(context, m.ts, (d) => ({ ...d, merges: d.merges + 1 }));
  await totals(context, (g) => ({ ...g, merges: g.merges + 1 }));
});

// ───────────────────────────────────────────────────────────── chests

indexer.onEvent({ contract: "MempireCards", event: "ChestGranted" }, async ({ event, context }) => {
  const m = meta(event);
  const owner = addr(event.params.owner);
  const bought = event.params.bought;
  const tier = chestTier(event.params.tier);

  // An earned chest is granted inside the settlement transaction of the win.
  const settled = bought ? undefined : await context.SettlementTx.get(m.tx);
  if (settled) {
    await patch(context.Match, settled.match_id, (x) => ({ ...x, chestTier: tier }));
  }

  const chest: Chest = {
    id: event.params.chestId.toString(),
    owner_id: owner,
    tier,
    bought,
    // buyChest() starts a bought chest already unlocked: no slot, no timer.
    state: bought ? "Unlocking" : "Idle",
    match_id: settled?.match_id,
    grantedAt: m.ts,
    readyAt: bought ? m.ts : undefined,
    unlockStartedAt: bought ? m.ts : undefined,
    skipped: false,
    skipPaid: 0n,
    revealBlock: undefined,
    recommits: 0,
    openedAt: undefined,
    seed: undefined,
    cardIds: [],
  };
  context.Chest.set(chest);

  await updatePlayer(
    context,
    owner,
    m,
    (p) => (bought ? { ...p, chestsBought: p.chestsBought + 1 } : { ...p, chestsEarned: p.chestsEarned + 1 }),
    bought,
  );
  await daily(context, m.ts, (d) => ({ ...d, chestsGranted: d.chestsGranted + 1 }));
});

indexer.onEvent({ contract: "MempireCards", event: "ChestForfeited" }, async ({ event, context }) => {
  const m = meta(event);
  const settled = await context.SettlementTx.get(m.tx);
  if (settled) {
    await patch(context.Match, settled.match_id, (x) => ({
      ...x,
      chestTier: chestTier(event.params.tier),
      chestForfeited: true,
    }));
  }
  await updatePlayer(context, event.params.owner, m, (p) => ({ ...p, chestsForfeited: p.chestsForfeited + 1 }), false);
});

indexer.onEvent({ contract: "MempireCards", event: "ChestUnlocking" }, async ({ event, context }) => {
  const m = meta(event);
  const chest = await patch(context.Chest, event.params.chestId.toString(), (c): Chest => ({
    ...c,
    state: "Unlocking",
    readyAt: Number(event.params.readyAt),
    unlockStartedAt: m.ts,
  }));
  if (chest) await updatePlayer(context, chest.owner_id, m, (p) => p);
});

indexer.onEvent({ contract: "MempireCards", event: "ChestSkipped" }, async ({ event, context }) => {
  const m = meta(event);
  const chest = await patch(context.Chest, event.params.chestId.toString(), (c): Chest => ({
    ...c,
    state: "Unlocking",
    readyAt: m.ts,
    unlockStartedAt: c.unlockStartedAt ?? m.ts,
    skipped: true,
    skipPaid: c.skipPaid + event.params.paid,
  }));
  if (chest) await updatePlayer(context, chest.owner_id, m, (p) => p);
});

indexer.onEvent({ contract: "MempireCards", event: "ChestOpening" }, async ({ event, context }) => {
  const m = meta(event);
  // Emitted again by reveal() when the committed block hash aged out: a re-commit.
  const chest = await patch(context.Chest, event.params.chestId.toString(), (c): Chest => ({
    ...c,
    recommits: c.state === "Revealing" ? c.recommits + 1 : c.recommits,
    state: "Revealing",
    revealBlock: event.params.revealBlock,
  }));
  if (chest) await updatePlayer(context, chest.owner_id, m, (p) => p);
});

indexer.onEvent({ contract: "MempireCards", event: "ChestOpened" }, async ({ event, context }) => {
  const m = meta(event);
  const chestId = event.params.chestId.toString();
  const cardIds = event.params.cardIds.map((id) => id.toString());
  const opened = await patch(context.Chest, chestId, (c): Chest => ({
    ...c,
    state: "Opened",
    openedAt: m.ts,
    seed: event.params.seed,
    cardIds,
  }));
  if (opened === undefined) context.log.warn(`ChestOpened for unknown chest ${chestId}`);

  // The drops were minted earlier in this transaction.
  for (const id of cardIds) {
    await patch(context.Card, id, (c) => ({ ...c, chest_id: chestId }));
  }
  await updatePlayer(context, event.params.owner, m, (p) => ({ ...p, chestsOpened: p.chestsOpened + 1 }));
  await daily(context, m.ts, (d) => ({ ...d, chestsOpened: d.chestsOpened + 1 }));
  await totals(context, (g) => ({ ...g, chestsOpened: g.chestsOpened + 1 }));
});
