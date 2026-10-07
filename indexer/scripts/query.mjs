#!/usr/bin/env node
// The GraphQL queries the Mempire app runs against this indexer, plus a tiny
// runner to try them against a live endpoint.
//
//   node scripts/query.mjs                                   # every query, local endpoint
//   node scripts/query.mjs https://indexer.dev.hyperindex.xyz/<id>/v1/graphql latestPlays
//   node scripts/query.mjs <endpoint> playerHistory --player 0xabc...
//
// Endpoint defaults to $ENVIO_GRAPHQL_URL, then http://localhost:8090/v1/graphql
// (the local anvil stack from scripts/local-indexer.sh; plain `envio dev`
// against testnet serves :8080). Every query works on the public role, no
// secret needed; set HASURA_ADMIN_SECRET to send one ("testing" locally).
// Addresses are stored lowercase.
import { fileURLToPath } from "node:url";

export const QUERIES = {
  leaderboardByWins: /* GraphQL */ `
    query LeaderboardByWins($limit: Int = 20) {
      Player(where: { matches: { _gt: 0 } }, order_by: [{ wins: desc }, { netMon: desc }], limit: $limit) {
        id
        wins
        losses
        ties
        voids
        matches
        netMon
        netAusd
        highestLevel
        cardsOwned
        lastActive
      }
    }`,

  leaderboardByNetMon: /* GraphQL */ `
    query LeaderboardByNetMon($limit: Int = 20) {
      Player(where: { matches: { _gt: 0 } }, order_by: [{ netMon: desc }, { wins: desc }], limit: $limit) {
        id
        netMon
        wageredMon
        wins
        losses
        ties
        matches
      }
    }`,

  playerHistory: /* GraphQL */ `
    query PlayerHistory($player: String!, $limit: Int = 20) {
      Player_by_pk(id: $player) {
        id
        matches
        wins
        losses
        ties
        voids
        netMon
        netAusd
        cardsOwned
        highestLevel
        chestsOpened
        rewardedWins
        lastActive
      }
      MatchSeat(where: { player_id: { _eq: $player } }, order_by: { createdAt: desc }, limit: $limit) {
        seat
        result
        currency
        stake
        payout
        net
        power
        plays
        coinIds
        opponent {
          id
        }
        match {
          id
          state
          outcome
          tier
          byTimeout
          disputed
          voidReason
          pot
          rake
          metaEpoch
          playCount
          createdAt
          endedAt
          durationSeconds
          endedTxHash
        }
      }
    }`,

  latestPlays: /* GraphQL */ `
    query LatestPlays($limit: Int = 50) {
      Play(order_by: [{ blockNumber: desc }, { logIndex: desc }], limit: $limit) {
        id
        match_id
        seat
        player_id
        tick
        cardIndex
        x
        y
        seq
        blockNumber
        timestamp
        txHash
        coin {
          id
          ticker
          kind
          archetypeName
          currentModifierBps
        }
        card {
          id
          level
        }
      }
    }`,

  coinWinRates: /* GraphQL */ `
    query CoinWinRates {
      Coin(where: { registered: { _eq: true } }, order_by: [{ winRateBps: desc }, { fielded: desc }]) {
        id
        ticker
        name
        kind
        archetypeName
        fielded
        wins
        losses
        ties
        winRateBps
        deckAppearances
        timesPlayed
        liveSupply
        maxLevel
        currentModifierBps
        modifierEpoch
        winsBuffed
        lossesBuffed
        winsNerfed
        lossesNerfed
      }
      MarketEpoch(order_by: { epoch: desc }, limit: 1) {
        epoch
        postedAt
        source
        poster
        maxBps
        minBps
        topCoin {
          ticker
        }
        bottomCoin {
          ticker
        }
      }
    }`,

  overview: /* GraphQL */ `
    query Overview($days: Int = 14) {
      Totals_by_pk(id: "global") {
        players
        coins
        matches
        matchesSettled
        matchesVoided
        plays
        cardsMinted
        merges
        chestsOpened
        volumeMon
        volumeAusd
        currentEpoch
      }
      DailyStats(order_by: { dayStart: desc }, limit: $days) {
        id
        matchesStarted
        matchesSettled
        matchesVoided
        volumeMon
        volumeAusd
        plays
        cardsMinted
        merges
        uniquePlayers
        newPlayers
      }
    }`,
};

export const LOCAL_ENDPOINT = "http://localhost:8090/v1/graphql";

/** POST a GraphQL document; throws on transport or GraphQL errors. */
export async function gql(endpoint, query, variables = {}) {
  const headers = { "content-type": "application/json" };
  if (process.env.HASURA_ADMIN_SECRET) headers["x-hasura-admin-secret"] = process.env.HASURA_ADMIN_SECRET;
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

/** Run one of the app's named QUERIES. */
export async function run(endpoint, name, variables) {
  try {
    return await gql(endpoint, QUERIES[name], variables);
  } catch (e) {
    throw new Error(`${name}: ${e.message}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const playerAt = args.indexOf("--player");
  const player = playerAt >= 0 ? String(args.splice(playerAt, 2)[1]).toLowerCase() : undefined;
  const endpoint = args.find((a) => a.startsWith("http")) ?? process.env.ENVIO_GRAPHQL_URL ?? LOCAL_ENDPOINT;
  const only = args.find((a) => a in QUERIES);
  const names = only ? [only] : Object.keys(QUERIES).filter((n) => n !== "playerHistory" || player);
  for (const name of names) {
    const data = await run(endpoint, name, name === "playerHistory" ? { player } : {});
    console.log(`── ${name}`);
    console.log(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  }
}
