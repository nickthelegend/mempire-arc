#!/usr/bin/env node
// End-to-end check: what scripts/seed-local.mjs did on anvil must be what the
// local indexer serves over GraphQL. Exits 1 on any mismatch.
//
//   node scripts/verify-local.mjs [graphql-url]      # default http://localhost:8090/v1/graphql
//
// Three kinds of checks:
//   - exact: the seeded rows (players, both matches, every play, chest, merge)
//     against .local/seed-manifest.json
//   - chain: values read back from anvil (epoch sources, card counts)
//   - consistency: aggregates (Coin, DailyStats, Totals, MarketEpoch.matches)
//     recomputed from the indexed rows themselves, since other sessions on the
//     same anvil may have played too
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbiItem } from "viem";
import { foundry } from "viem/chains";
import { LOCAL_ENDPOINT, QUERIES, gql, run } from "./query.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const indexerDir = join(here, "..");
const ENDPOINT = process.argv.slice(2).find((a) => a.startsWith("http")) ?? process.env.ENVIO_GRAPHQL_URL ?? LOCAL_ENDPOINT;
const RPC = process.env.MEMPIRE_RPC ?? "http://127.0.0.1:8612";

const m = JSON.parse(readFileSync(join(indexerDir, ".local/seed-manifest.json"), "utf8"));
const abi = (name) => JSON.parse(readFileSync(join(indexerDir, "abis", `${name}.json`), "utf8"));
const pub = createPublicClient({ chain: { ...foundry, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC) });

let failures = 0;
let passes = 0;
const s = (v) => (typeof v === "bigint" ? v.toString() : v);
function check(label, actual, expected) {
  const a = JSON.stringify(actual, (_k, v) => s(v));
  const e = JSON.stringify(expected, (_k, v) => s(v));
  if (a === e) {
    passes++;
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
  }
}
const section = (t) => console.log(`\n${t}`);
const lc = (a) => a.toLowerCase();

// ── wait for the indexer to reach the seed's last block ──
section(`indexer at ${ENDPOINT}`);
let head;
for (let i = 0; i < 60; i++) {
  head = (await gql(ENDPOINT, `{ chain_metadata { chain_id latest_processed_block } }`)).chain_metadata[0];
  if (head && head.latest_processed_block >= m.endBlock) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check(`chain ${head?.chain_id} processed through the seed's last block ${m.endBlock}`, (head?.latest_processed_block ?? -1) >= m.endBlock, true);

// ── players, through the app's own PlayerHistory query ──
const { A, B } = m.players;
const pa = await run(ENDPOINT, "playerHistory", { player: A, limit: 50 });
const pb = await run(ENDPOINT, "playerHistory", { player: B, limit: 50 });
const pot1 = BigInt(m.match1.pot);
const rake1 = BigInt(m.match1.rake);
const stake1 = BigInt(m.match1.stake);
const stake2 = BigInt(m.match2.stake);
const bought = m.boughtChests.length;
const drops = [...(m.chest?.drops ?? []), ...m.boughtChests.flatMap((c) => c.drops)].map(String);

section("Player (PlayerHistory)");
const P = (p) => p.Player_by_pk;
check("A: matches / wins / losses / ties / voids", [P(pa).matches, P(pa).wins, P(pa).losses, P(pa).ties, P(pa).voids], [2, 1, 0, 0, 1]);
check("B: matches / wins / losses / ties / voids", [P(pb).matches, P(pb).wins, P(pb).losses, P(pb).ties, P(pb).voids], [2, 0, 1, 0, 1]);
check("A netAusd = pot − rake − stake (the settled match pays)", P(pa).netAusd, pot1 - rake1 - stake1);
check("B netAusd = −stake", P(pb).netAusd, -stake1);
check("netMon is 0 for both (the void moves nothing)", [P(pa).netMon, P(pb).netMon], ["0", "0"]);
check("A rewardedWins (WinRewarded)", P(pa).rewardedWins, BigInt(m.match1.reward) > 0n ? 1 : 0);
check("A chestsOpened = won chest + bought chests", P(pa).chestsOpened, (m.chest ? 1 : 0) + bought);
const [idsA] = await pub.readContract({ address: m.contracts.cards, abi: abi("MempireCards"), functionName: "cardsOf", args: [A] });
const [idsB] = await pub.readContract({ address: m.contracts.cards, abi: abi("MempireCards"), functionName: "cardsOf", args: [B] });
check("cardsOwned matches cardsOf() on chain (A, B)", [P(pa).cardsOwned, P(pb).cardsOwned], [idsA.length, idsB.length]);
check("A highestLevel after the merge", P(pa).highestLevel, m.merge ? m.merge.newLevel : 1);

section("MatchSeat (history rows)");
const seat = (ph, id) => ph.MatchSeat.find((x) => x.match.id === String(id));
const a1 = seat(pa, m.match1.id), b1 = seat(pb, m.match1.id), a2 = seat(pa, m.match2.id), b2 = seat(pb, m.match2.id);
check(`match ${m.match1.id} A: seat / result / payout / net`, [a1?.seat, a1?.result, a1?.payout, a1?.net], [0, "Win", pot1 - rake1, pot1 - rake1 - stake1]);
check(`match ${m.match1.id} B: seat / result / payout / net`, [b1?.seat, b1?.result, b1?.payout, b1?.net], [1, "Loss", 0n, -stake1]);
check(`match ${m.match2.id} A: seat / result / payout / net (void refunds)`, [a2?.seat, a2?.result, a2?.payout, a2?.net], [1, "Void", stake2, 0n]);
check(`match ${m.match2.id} B: seat / result / payout / net (void refunds)`, [b2?.seat, b2?.result, b2?.payout, b2?.net], [0, "Void", stake2, 0n]);
check("deck coinIds on the seat rows", [a1?.coinIds, b1?.coinIds], [m.deckCoins.A.map(String), m.deckCoins.B.map(String)]);

// ── matches ──
section("Match");
const MATCH = `query($id: String!) { Match_by_pk(id: $id) {
  state outcome currency stake winnerSeat winner_id pot rake winnerPayout winReward disputed voidReason byTimeout
  player0_id player1_id session0 session1 plays0 plays1 playCount checkpointCount claimCount claim0 claim1
  metaEpoch marketEpoch_id chestTier chestForfeited
} }`;
const M1 = (await gql(ENDPOINT, MATCH, { id: String(m.match1.id) })).Match_by_pk;
const M2 = (await gql(ENDPOINT, MATCH, { id: String(m.match2.id) })).Match_by_pk;
const tiers = ["Silver", "Golden", "Magic", "Legendary"];
check(`match ${m.match1.id}: Settled, Seat0, winner A`, [M1.state, M1.outcome, M1.winnerSeat, M1.winner_id], ["Settled", "Seat0", 0, A]);
check(`match ${m.match1.id}: AUSD stake / pot / rake / winnerPayout`, [M1.currency, M1.stake, M1.pot, M1.rake, M1.winnerPayout], ["AUSD", stake1, pot1, rake1, pot1 - rake1]);
check(`match ${m.match1.id}: rake = pot × rakeBps`, BigInt(M1.rake), (pot1 * BigInt(m.rakeBps)) / 10_000n);
check(`match ${m.match1.id}: plays0 / plays1 / checkpoints / claims`, [M1.plays0, M1.plays1, M1.checkpointCount, M1.claimCount, M1.claim0, M1.claim1], [3, 3, 2, 2, 0, 0]);
check(`match ${m.match1.id}: meta epoch snapshot at join`, [M1.metaEpoch, M1.marketEpoch_id], [m.match1.metaEpoch, String(m.match1.metaEpoch)]);
check(`match ${m.match1.id}: chest tier / reward`, [M1.chestTier, M1.chestForfeited, M1.winReward], [m.match1.chest ? tiers[m.match1.chest.tier] : null, false, m.match1.reward]);
check(`match ${m.match2.id}: Voided (disputed), no winner`, [M2.state, M2.outcome, M2.disputed, M2.voidReason, M2.winner_id], ["Voided", "Void", true, "Disputed", null]);
check(`match ${m.match2.id}: MON, nothing raked or paid out`, [M2.currency, M2.stake, M2.rake, M2.winnerPayout], ["MON", stake2, "0", "0"]);
check(`match ${m.match2.id}: B seat 0, A seat 1, session keys`, [M2.player0_id, M2.player1_id, M2.session0, M2.session1], [B, A, m.sessions.B, m.sessions.A]);
check(`match ${m.match2.id}: disagreeing claims`, [M2.claim0, M2.claim1, M2.playCount], [0, 1, 4]);

// ── plays: every seeded drop, resolved to the deck's card and coin ──
section("Play (resolved to fighters)");
const PLAYS = `query($ids: [String!]!) { Play(where: { match_id: { _in: $ids } }, order_by: [{ blockNumber: asc }, { logIndex: asc }]) {
  match_id seat player_id tick cardIndex x y seq txHash card_id coin_id coin { ticker } } }`;
const plays = (await gql(ENDPOINT, PLAYS, { ids: [String(m.match1.id), String(m.match2.id)] })).Play;
const expected = [];
for (const [mm, seat0] of [[m.match1, "A"], [m.match2, "B"]]) {
  const seq = [0, 0];
  for (const p of mm.plays) {
    const who = p.seat === 0 ? seat0 : seat0 === "A" ? "B" : "A";
    seq[p.seat] += 1;
    expected.push({
      match_id: String(mm.id), seat: p.seat, player_id: m.players[who], tick: p.tick, cardIndex: p.cardIndex,
      x: p.x, y: p.y, seq: seq[p.seat], txHash: lc(p.txHash),
      card_id: String(m.decks[who][p.cardIndex]), coin_id: String(m.deckCoins[who][p.cardIndex]),
    });
  }
}
const got = plays.map(({ coin, ...rest }) => rest);
const key = (p) => p.txHash;
check(`${expected.length} plays indexed`, got.length, expected.length);
check("each play: seat, player (not the session key), tick, cardIndex, x, y, seq, card, coin", [...got].sort((a, b) => key(a).localeCompare(key(b))), [...expected].sort((a, b) => key(a).localeCompare(key(b))));
check("every play has a coin ticker", plays.every((p) => p.coin?.ticker), true);

const latest = await run(ENDPOINT, "latestPlays", { limit: 50 });
check("LatestPlays (live feed) includes the seeded plays", expected.every((e) => latest.Play.some((p) => p.txHash === e.txHash)), true);

// ── chest and merge ──
section("Chest / Card / Merge");
if (m.chest) {
  const c = (await gql(ENDPOINT, `query($id: String!) { Chest_by_pk(id: $id) { owner_id tier state skipped bought match_id cardIds revealBlock cards { id source owner_id } } }`, { id: String(m.chest.id) })).Chest_by_pk;
  check(`chest ${m.chest.id}: owner / tier / state / skipped / match`, [c.owner_id, c.tier, c.state, c.skipped, c.bought, c.match_id], [A, tiers[m.chest.tier], "Opened", m.chest.skipped, false, String(m.match1.id)]);
  check(`chest ${m.chest.id}: drops and reveal block`, [c.cardIds, c.revealBlock], [m.chest.drops.map(String), m.chest.revealBlock]);
  check(`chest ${m.chest.id}: dropped cards are Chest-sourced and linked`, c.cards.map((x) => [x.id, x.source]).sort(), m.chest.drops.map((d) => [String(d), "Chest"]).sort());
}
if (m.merge) {
  const q = `query($keep: String!, $burned: String!) {
    keep: Card_by_pk(id: $keep) { level mergesAbsorbed burned owner_id }
    burned: Card_by_pk(id: $burned) { burned mergedInto_id }
    Merge(where: { card_id: { _eq: $keep } }) { burned_id newLevel paid owner_id coin_id txHash } }`;
  const r = await gql(ENDPOINT, q, { keep: String(m.merge.keep), burned: String(m.merge.burned) });
  check(`card ${m.merge.keep} kept: level / absorbed / owner`, [r.keep.level, r.keep.mergesAbsorbed, r.keep.burned, r.keep.owner_id], [m.merge.newLevel, 1, false, A]);
  check(`card ${m.merge.burned} burned into ${m.merge.keep}`, [r.burned.burned, r.burned.mergedInto_id], [true, String(m.merge.keep)]);
  check("Merge row", r.Merge.map((x) => [x.burned_id, x.newLevel, x.paid, x.owner_id, x.coin_id, x.txHash]), [[String(m.merge.burned), m.merge.newLevel, m.merge.paid, A, String(m.merge.coinId), lc(m.merge.txHash)]]);
}
check("every chest drop is indexed as a card", (await gql(ENDPOINT, `query($ids: [String!]!) { Card(where: { id: { _in: $ids } }) { id } }`, { ids: drops })).Card.length, drops.length);

// ── market meta: every epoch's source, against the chain ──
section("MarketEpoch (MetaSource)");
const sourceLogs = await pub.getLogs({
  address: m.contracts.marketMeta,
  event: parseAbiItem("event MetaSource(uint64 indexed epoch, uint8 source, address poster)"),
  // From the deployment block: on a fork, anything older is proxied to Monad
  // testnet, whose eth_getLogs caps the range at 100 blocks.
  fromBlock: BigInt(JSON.parse(readFileSync(join(indexerDir, "..", "shared/deployments/31337.json"), "utf8")).startBlock),
});
const epochs = (await gql(ENDPOINT, `{ MarketEpoch(order_by: { epoch: asc }) { id source sourceCode poster matches } }`)).MarketEpoch;
const names = ["ChainlinkCRE", "PythMomentum"];
check(`${sourceLogs.length} MetaSource logs on chain → ${epochs.length} epochs, each with its source and poster`,
  epochs.map((e) => [e.id, e.source, e.sourceCode, e.poster]),
  sourceLogs.map((l) => [String(l.args.epoch), names[l.args.source], l.args.source, lc(l.args.poster)]));
const e1 = epochs.find((e) => e.id === String(m.match1.metaEpoch));
check(`the seeded matches' epoch ${m.match1.metaEpoch} is Pyth-sourced`, [e1?.source, e1?.sourceCode], ["PythMomentum", 1]);
const onchainSource = await pub.readContract({ address: m.contracts.marketMeta, abi: abi("MarketMeta"), functionName: "epochSource", args: [BigInt(m.match1.metaEpoch)] });
check("…and MarketMeta.epochSource() agrees", onchainSource, 1);

// ── consistency: aggregates recomputed from the indexed rows ──
section("Coin / DailyStats / Totals (recomputed from rows)");
const all = await gql(ENDPOINT, `{
  MatchSeat { result coinIds }
  Play { coin_id timestamp }
  Match { id state currency pot rake endedAt marketEpoch_id }
  Checkpoint { timestamp }
  Coin(where: { registered: { _eq: true } }) { id wins losses ties fielded timesPlayed deckAppearances }
  DailyStats { id dayStart plays checkpoints matchesSettled matchesVoided volumeMon volumeAusd rakeMon rakeAusd merges }
  Totals_by_pk(id: "global") { matches matchesSettled matchesVoided plays volumeMon volumeAusd merges }
  Merge { timestamp }
}`);
const deckCoins = new Set([...m.deckCoins.A, ...m.deckCoins.B].map(String));
const coinStats = all.Coin.filter((c) => deckCoins.has(c.id)).map((c) => [c.id, c.wins, c.losses, c.ties, c.fielded, c.timesPlayed, c.deckAppearances]);
const coinExpect = all.Coin.filter((c) => deckCoins.has(c.id)).map((c) => {
  const seats = all.MatchSeat.filter((x) => x.coinIds.includes(c.id));
  const n = (r) => seats.filter((x) => x.result === r).length;
  return [c.id, n("Win"), n("Loss"), n("Tie"), n("Win") + n("Loss") + n("Tie"), all.Play.filter((p) => p.coin_id === c.id).length, seats.length];
});
check(`Coin wins / losses / ties / fielded / timesPlayed / deckAppearances for the ${deckCoins.size} deck coins`, coinStats, coinExpect);
const settledM1Coins = m.deckCoins.A.map(String);
check("every coin of A's winning deck has at least one win", settledM1Coins.every((id) => all.Coin.find((c) => c.id === id)?.wins >= 1), true);

const dayOf = (ts) => Math.floor(ts / 86_400) * 86_400;
const days = [...new Set(all.DailyStats.map((d) => d.dayStart))];
const sum = (xs) => xs.reduce((a, b) => a + BigInt(b), 0n);
const dailyGot = all.DailyStats.map((d) => [d.id, d.plays, d.checkpoints, d.matchesSettled, d.matchesVoided, d.volumeMon, d.volumeAusd, d.rakeMon, d.rakeAusd, d.merges]).sort();
const dailyWant = all.DailyStats.map((d) => {
  const ended = all.Match.filter((x) => x.endedAt != null && dayOf(x.endedAt) === d.dayStart);
  const settledIn = ended.filter((x) => x.state === "Settled");
  const cur = (c, f) => sum(settledIn.filter((x) => x.currency === c).map((x) => x[f])).toString();
  return [
    d.id,
    all.Play.filter((p) => dayOf(p.timestamp) === d.dayStart).length,
    all.Checkpoint.filter((p) => dayOf(p.timestamp) === d.dayStart).length,
    settledIn.length,
    ended.filter((x) => x.state === "Voided").length,
    cur("MON", "pot"), cur("AUSD", "pot"), cur("MON", "rake"), cur("AUSD", "rake"),
    all.Merge.filter((x) => dayOf(x.timestamp) === d.dayStart).length,
  ];
}).sort();
check(`DailyStats (${days.length} day${days.length === 1 ? "" : "s"}): plays, checkpoints, settled, voided, volume, rake, merges`, dailyGot, dailyWant);
const today = all.DailyStats.find((d) => d.dayStart === dayOf(Number(new Date(m.createdAt)) / 1000 | 0)) ?? all.DailyStats.at(-1);
check("DailyStats counts the seeded plays, one settle and one void", [today.plays >= expected.length, today.matchesSettled >= 1, today.matchesVoided >= 1, BigInt(today.volumeAusd) >= pot1], [true, true, true, true]);

const T = all.Totals_by_pk;
const settledAll = all.Match.filter((x) => x.state === "Settled");
check("Totals: matchesSettled / matchesVoided / plays / merges", [T.matchesSettled, T.matchesVoided, T.plays, T.merges],
  [settledAll.length, all.Match.filter((x) => x.state === "Voided").length, all.Play.length, all.Merge.length]);
check("Totals: volume only from settled pots (the void adds nothing)", [T.volumeMon, T.volumeAusd],
  [sum(settledAll.filter((x) => x.currency === "MON").map((x) => x.pot)).toString(), sum(settledAll.filter((x) => x.currency === "AUSD").map((x) => x.pot)).toString()]);
check("MarketEpoch.matches = matches that snapshotted it",
  epochs.map((e) => [e.id, e.matches]),
  epochs.map((e) => [e.id, all.Match.filter((x) => x.marketEpoch_id === e.id).length]));

// ── the app's other queries run cleanly on the public role ──
section("App queries (scripts/query.mjs)");
for (const name of Object.keys(QUERIES).filter((n) => n !== "playerHistory")) {
  try {
    const data = await run(ENDPOINT, name, {});
    check(`${name} returns data`, Object.values(data).every((v) => v !== null), true);
  } catch (e) {
    check(`${name} returns data`, String(e.message).slice(0, 200), "no error");
  }
}
const board = await run(ENDPOINT, "leaderboardByWins", { limit: 100 });
check("A is on the wins leaderboard with 1 win", board.Player.find((p) => p.id === A)?.wins, 1);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
