# Mempire indexer (Envio HyperIndex)

An [Envio HyperIndex](https://docs.envio.dev) indexer for Mempire on **Arc**, Circle's stablecoin-native
L1. It turns the four Mempire contracts into a GraphQL API the app uses for leaderboards, match
history, the live play feed, fighter win rates and cross-chain entries. All money is **USDC** (Arc's
gas token, ERC-20 interface at `0x3600000000000000000000000000000000000000`, 6 decimals).

Every fighter is a **Chainlink Data Feed on Arc** (20 of them: majors, DeFi tokens, gold and FX; see
`shared/roster.json`). There is no signed price oracle any more: `MempireCards.mint(coinId, permit)` /
`mintWithMempire(coinId)` read the coin's AggregatorV3 proxy on chain and stamp the card with that
answer, and `MarketMeta.postFromFeeds` computes each epoch's meta from the feeds' own 24-hour history.
Players on Base or Ethereum can play through **Chainlink CCIP** (`MempireCCIPGateway`): CCTP moves
their USDC to Arc, a CCIP message tells the gateway to seat them in a match or cash them out.

| Config | Chain | Data source |
|---|---|---|
| `config.yaml` (default) | **Arc testnet**, chain `5042002` (Envio network `arc-testnet`) | native HyperSync, `https://5042002.hypersync.xyz` |
| `config.mainnet.yaml` | **Arc mainnet**, chain `5042` (Envio network `arc`) | native HyperSync, `https://5042.hypersync.xyz` |
| `config.local.yaml` | the **arc-anvil fork** of Arc testnet, chain `31337` on `http://127.0.0.1:8710` | RPC (`for: sync`) |

- HyperIndex **v3** (`envio@3.13.0`, which ships the `arc` and `arc-testnet` HyperSync networks): `chains:` config, `indexer.onEvent` handlers, `createTestIndexer` tests
- The three configs share everything above `chains:` (contracts, events, field selection); `test/config.test.ts` fails if they drift
- `schema.graphql` holds the entity model and `src/handlers/*.ts` the handlers
- `test/mempire.test.ts` holds the handler tests (simulated events, no network or Docker)
- `scripts/sync-addresses.mjs` refreshes ABIs + roster and writes a chain's addresses and start block from `shared/deployments/<chainId>.json` (the CCIP gateway from the `ccipGateway` key, kept as a placeholder when that is missing or zero)
- `scripts/query.mjs` holds the app's queries and a runner that tries them against an endpoint
- `scripts/local-indexer.sh` runs the indexer against the fork with its own Postgres + Hasura; `scripts/seed-local.mjs` plays real matches on the fork; `scripts/verify-local.mjs` checks the GraphQL API against what was seeded

## What is indexed

| Contract | Events | What they drive |
|---|---|---|
| `MempireCards` (ERC-721 fighters) | `CoinRegistered`, `CoinActive`, `CardMinted`, `CardMerged`, `Transfer`, `ChestGranted`, `ChestForfeited`, `ChestUnlocking`, `ChestSkipped`, `ChestOpening`, `ChestOpened`, `CoinFeedChanged` | roster, every card with its owner/level/history and Chainlink mint price, merges, chest lifecycle, feed migrations |
| `MempireArena` (escrowed USDC 1v1) | `MatchCreated`, `MatchJoined`, `MatchCancelled`, `Played`, `Checkpoint`, `Claimed`, `MatchSettled`, `MatchVoided`, `WinRewarded`, `PayoutHeld`, `LimitsChanged`, `EntryGatewayChanged` | matches, per-seat results and USDC P&L, the on-chain play log, claims, held payouts, the open tier cap and pause switch, the CCIP gateway allowed to seat players |
| `MarketMeta` (Chainlink CRE or Chainlink Data Feeds momentum) | `MetaPosted`, `MetaSource`, `CardsChanged` | per-epoch ±15% modifier per fighter, current modifier on each coin, which source wrote the epoch, cards rewiring |
| `MempireCCIPGateway` (Arc side of CCIP cross-chain play) | `Entered`, `CashedOut`, `MessageFailed`, `MessageRecovered`, `RemoteEntrySet` | one row per CCIP message (entered / cashed out / failed / recovered), the allowed source chains |

## Entity model

```
Player ─┬─< Card >── Coin ─< CoinModifier >── MarketEpoch
        ├─< MatchSeat >── Match ─┬─< Play  (coin + card resolved from the seat's deck)
        │                        ├─< Checkpoint
        │                        └─< Claim
        └─< Chest ─< Card (drops)
Card ─< Merge     DailyStats (per UTC day)     Totals (id "global")     ArenaLimits (id "arena")
CrossChainMessage (by player) >── Match     CCIPSource (per CCIP selector)     AdminChange (wiring log)
```

| Entity | Notes |
|---|---|
| `Player` | matches / wins / losses / ties / voids, **`netUsdc`** (payout − stake, 6 dp), **`wageredUsdc`**, **`heldUsdc`** (payouts the arena is holding for `withdraw()`), cards owned, highest level, merges, chests, rewarded wins, `lastActive` |
| `Card` | owner, coin, level, archetype, source (Mint / MintMempire / Starter / Chest), `mintPrice` (the Chainlink feed answer at mint) and `mintExpo` (−feed decimals, so USD = `mintPrice × 10^mintExpo`), chest it dropped from, `burned`, `mergedInto`, `mergesAbsorbed`, its own win/loss record |
| `Coin` | ticker, name, kind (crypto / defi / rwa), Chainlink `pair` and `feedDecimals` (joined from `shared/roster.json` by feed id = keccak256 of the pair), `feed` (the AggregatorV3 proxy: from the roster on Arc mainnet, otherwise from `CoinFeedChanged`; see below) and `feedChanges`, archetype, supply, merges, **deck appearances, wins / losses / ties when fielded, `winRateBps`**, results split by buffed/nerfed modifier, `timesPlayed`, current modifier |
| `Match` | both players and session keys, tier, `currency` (always `USDC`) and `currencyAddress`, stake, deck hashes, powers, meta epoch, state, outcome, winner, plays per seat, checkpoints, both claims, pot / rake / payouts, chest tier, timestamps, `durationSeconds`, `byTimeout`, `disputed` |
| `MatchSeat` | one row per (match, seat): the player's side, deck `cardIds` → `coinIds`, result, payout, `net`. This is the player-history entity |
| `Play` | match, seat, player, tick, cardIndex, **card and coin resolved from the seat's deck**, x, y, per-seat sequence, block, log index, timestamp, tx hash. This drives the "live on Arc" feed |
| `Chest` | tier, bought, state machine (Idle → Unlocking → Revealing → Opened), the match that paid it, skip fee, reveal block, re-commits, seed, drops |
| `MarketEpoch` / `CoinModifier` | each epoch's report, its top and bottom movers, the matches that snapshotted it, and its `source` (`ChainlinkCRE` from `onReport`, `ChainlinkFeeds` from `postFromFeeds`), raw `sourceCode` (0 / 1) and `poster` (the CRE forwarder, or whoever called `postFromFeeds`) |
| `DailyStats` | matches created / started / settled / voided / cancelled, ties, **`volumeUsdc` / `rakeUsdc`**, plays, checkpoints, mints, merges, chests, rewards, unique and new players |
| `Totals` | protocol-wide counters including `volumeUsdc` / `rakeUsdc` (single row `id: "global"`) |
| `ArenaLimits` | `maxTier`, `paused`, `changes` from `LimitsChanged` (single row `id: "arena"`). The constructor sets the first limits without an event, so the row appears with the first `setLimits()`; until then read `maxTier()` / `paused()` from the contract |
| `CrossChainMessage` | one row per CCIP `messageId`: `status` (`Entered` / `CashedOut` / `Failed` / `Recovered`), `action` (`Enter` / `CashOut`), `player`, the `match` entered and whether it was `created` or joined, the cash-out `amount` and CCTP `cctpDomain`; for a failure the `sourceChainSelector`, remote `sender`, `failData` (what `retryFailedMessage` needs back) and `failReason`; `createdAt` / `completedAt` / `failedAt` / `recoveredAt`. Indexed by (player, createdAt desc) |
| `CCIPSource` | the source chains the gateway accepts (`RemoteEntrySet`), one row per CCIP chain selector: the `MempireRemoteEntry` sender, its CCTP domain, `enabled` (false once the sender is set to zero) |
| `AdminChange` | contract rewiring, one row per event: `CoinFeedChanged` (with `coinId`), `CardsChanged`, `EntryGatewayChanged`, `RemoteEntrySet` (with `selector` / `cctpDomain`); `address` is the new feed / cards / gateway / sender. Replaces the old `OracleChange` |
| `Merge`, `Checkpoint`, `Claim`, `HeldPayout` | event logs |
| `PlayerDay`, `SettlementTx` | internal join rows: unique-players-per-day, and settlement tx → match (so the `ChestGranted` / `ChestForfeited` that the arena fires later in the same tx find their match) |

### The joins and the edge cases

- **One currency.** Stakes are USDC only. `MatchCreated`, `MatchSettled` and `PayoutHeld` still carry the token address; the handlers store it (`Match.currencyAddress`) and log a warning if it is ever anything but `0x3600…0000`.
- **Coin win rates are derived.** `MatchCreated` and `MatchJoined` carry each deck's `cardIds`. Every card is resolved to its coin and stored on the `MatchSeat`. At settlement each coin in the winning deck gets a win and each coin in the losing deck gets a loss. A tie gives every coin on both sides a tie. The modifier the coin carried in the epoch the match snapshotted at join decides whether the result is also counted as buffed or nerfed.
- **Void and disputed matches move no money.** A `MatchVoided` (disputed claims, or no claims by the deadline) marks both seats `Void` with `payout = stake` and `net = 0`. It changes no player's `netUsdc` or `wageredUsdc`, no coin results, and no volume or rake. `MatchCancelled` is handled the same way.
- **Ties split.** Each seat is paid `(pot − rake) / 2`; the contract sends the odd unit to the rake.
- **Walkovers.** A settlement through `claimTimeout` (`byTimeout = true`) still pays the pot, but only the winner's `winsByTimeout` marks it.
- **Held payouts.** If USDC refuses a push (a blocklisted recipient), the arena emits `PayoutHeld` and keeps the amount for `withdraw()`. The player's `heldUsdc` grows; a held rake to the treasury is logged in `HeldPayout` but credits no player.
- **Mints and burns.** A `Transfer` from the zero address is a mint, which the `CardMinted` in the next log creates. A `Transfer` to the zero address is a burn, and the following `CardMerged` links the burned card to the card it was merged into.
- **Market resets.** A coin left out of an epoch's `MetaPosted` reads 0 on chain for that epoch, so its `currentModifierBps` resets to 0.
- **Meta source.** `MarketMeta` emits `MetaSource(epoch, source, poster)` right after `MetaPosted` in the same transaction. The handler fills `source` / `sourceCode` / `poster` on that epoch's row and does not depend on the log order. On Arc testnet both sources can appear (the CRE workflow in `cre/` and the relay's keeper calling the permissionless `postFromFeeds` race for each window); on **Arc mainnet, CRE is not available, so every epoch is `ChainlinkFeeds`** (`SOURCE_FEEDS = 1`).
- **Which feed prices a fighter.** `registerCoins(feedIds, tickers, maxAges, feeds)` stores each coin's AggregatorV3 proxy, but `CoinRegistered` does not log it. On Arc mainnet the deploy registers the roster's proxies unchanged, so `Coin.feed` is filled from `shared/roster.json` there. On testnet (and the fork) a feed Chainlink does not serve is a `MirrorAggregator`, so `Coin.feed` stays null until a `CoinFeedChanged`; read `MempireCards.coin(coinId).feed` for it. `CoinFeedChanged` (a `setCoinFeed` migration) always updates `Coin.feed` and logs an `AdminChange`.
- **Cross-chain messages.** The gateway's `Entered` follows the arena's own `MatchCreated` / `MatchJoined` in the same transaction, so the match, seats and stake are indexed exactly as for a player on Arc; `CrossChainMessage` only records the message and links its `match`. A message whose action reverts (typically ENTER before its CCTP mint has landed) logs `MessageFailed`: the handler decodes `abi.encode(uint8 action, address player, bytes body)` from its data to fill `action`, `player`, the target `matchId` (join) or `amount` (cash-out). A later `retryFailedMessage` emits `Entered` / `CashedOut` and then `MessageRecovered`, so the row ends `Recovered` with both the failure and the result on it. `Entered` / `CashedOut` do not carry the source chain, so `sourceChainSelector` is only known for messages that failed at least once.
- **Addresses** are stored lowercase (`address_format: lowercase`). Query with `address.toLowerCase()`.
- **Amounts** are `BigInt` in base units: USDC in 6-decimal units (`1000000` = $1), $MEMPIRE in wei (18 dp).

## Queries the app uses

Envio exposes a Hasura GraphQL API. Entity names are used as written, relations can be filtered as `<field>_id`, and single rows come from `<Entity>_by_pk`. All of these queries are in `scripts/query.mjs`.

**Leaderboard by wins**

```graphql
query LeaderboardByWins($limit: Int = 20) {
  Player(where: { matches: { _gt: 0 } }, order_by: [{ wins: desc }, { netUsdc: desc }], limit: $limit) {
    id wins losses ties voids matches netUsdc highestLevel cardsOwned lastActive
  }
}
```

**Leaderboard by net USDC**

```graphql
query LeaderboardByNetUsdc($limit: Int = 20) {
  Player(where: { matches: { _gt: 0 } }, order_by: [{ netUsdc: desc }, { wins: desc }], limit: $limit) {
    id netUsdc wageredUsdc wins losses ties matches
  }
}
```

**A player's match history** (`$player` lowercase)

```graphql
query PlayerHistory($player: String!, $limit: Int = 20) {
  Player_by_pk(id: $player) {
    id matches wins losses ties voids netUsdc wageredUsdc heldUsdc cardsOwned highestLevel chestsOpened rewardedWins lastActive
  }
  MatchSeat(where: { player_id: { _eq: $player } }, order_by: { createdAt: desc }, limit: $limit) {
    seat result currency stake payout net power plays coinIds
    opponent { id }
    match {
      id state outcome tier byTimeout disputed voidReason pot rake metaEpoch
      playCount createdAt endedAt durationSeconds endedTxHash
    }
  }
}
```

**Latest 50 plays across all matches** (for live updates, change `query` to `subscription`)

```graphql
query LatestPlays($limit: Int = 50) {
  Play(order_by: [{ blockNumber: desc }, { logIndex: desc }], limit: $limit) {
    id match_id seat player_id tick cardIndex x y seq blockNumber timestamp txHash
    coin { id ticker kind archetypeName currentModifierBps }
    card { id level }
  }
}
```

**Coin win rates with the current market modifier**

```graphql
query CoinWinRates {
  Coin(where: { registered: { _eq: true } }, order_by: [{ winRateBps: desc }, { fielded: desc }]) {
    id ticker name kind pair feed archetypeName fielded wins losses ties winRateBps deckAppearances
    timesPlayed liveSupply maxLevel currentModifierBps modifierEpoch
    winsBuffed lossesBuffed winsNerfed lossesNerfed
  }
  MarketEpoch(order_by: { epoch: desc }, limit: 1) {
    epoch postedAt source poster maxBps minBps topCoin { ticker } bottomCoin { ticker }
  }
}
```

**Overview** (landing page totals and a 14-day chart)

```graphql
query Overview($days: Int = 14) {
  Totals_by_pk(id: "global") {
    players coins matches matchesSettled matchesVoided plays cardsMinted merges chestsOpened volumeUsdc rakeUsdc currentEpoch
  }
  DailyStats(order_by: { dayStart: desc }, limit: $days) {
    id matchesStarted matchesSettled matchesVoided volumeUsdc rakeUsdc plays cardsMinted merges uniquePlayers newPlayers
  }
}
```

**Arena limits and contract wiring**

```graphql
query ArenaLimits {
  ArenaLimits(limit: 1) { maxTier paused changes updatedAt }
  AdminChange(order_by: { timestamp: desc }, limit: 5) { contract change address coinId selector cctpDomain timestamp txHash }
}
```

**Cross-chain entries** (add `where: { player: { _eq: $player } }` for one player's)

```graphql
query CrossChain {
  CrossChainMessage(order_by: { createdAt: desc }, limit: 20) {
    id status action player matchId created amount cctpDomain sourceChainSelector failReason
    createdAt completedAt failedAt recoveredAt txHash
  }
  CCIPSource { id sender cctpDomain enabled }
}
```

To try the queries against an endpoint (default: the local stack, `http://localhost:8090/v1/graphql`):

```bash
node scripts/query.mjs                                      # every query, local endpoint
node scripts/query.mjs <graphql-url>                       # every query
node scripts/query.mjs <graphql-url> latestPlays
node scripts/query.mjs <graphql-url> playerHistory --player 0xYourAddress
```

## After deploying the contracts

`sh scripts/deploy.sh testnet` (via `contracts/script/Deploy.s.sol`) writes `shared/deployments/5042002.json`;
`sh scripts/deploy.sh mainnet` writes `shared/deployments/5042.json`. Until then the testnet and mainnet configs carry
`# TODO` placeholder addresses and `start_block: 0`. After the file exists:

```bash
cd indexer
pnpm sync              # Arc testnet: ABIs + roster, then cards/arena/marketMeta/ccipGateway + start_block into config.yaml
pnpm codegen
pnpm test

pnpm sync:mainnet      # Arc mainnet: the same into config.mainnet.yaml
pnpm codegen:mainnet   # types for the mainnet config (identical to testnet's: same project section)

pnpm sync:local        # the fork: into config.local.yaml (local-indexer.sh up does this when stale)

pnpm codegen:all       # codegen for mainnet, local, then testnet last (tests use the testnet types)
```

`ccipGateway` is only in the deployment file when the chain has a CCIP router (`CCIP_ROUTER` at deploy).
When it is missing or the zero address, the sync keeps the `MempireCCIPGateway` placeholder address
(no code, so no events) with a `# not deployed` comment, which `--check` accepts.

`node scripts/sync-addresses.mjs --check [--chain 5042]` exits non-zero while that config still has
its placeholders. The script also refreshes `abis/` and `src/roster.generated.ts`, because Envio Cloud
builds only the `indexer/` directory, so the indexer cannot import anything from outside it.

### Switching networks

The config file is the switch; handlers, schema and tests are network-agnostic.

| | Arc testnet | Arc mainnet | Local fork |
|---|---|---|---|
| codegen | `pnpm codegen` | `pnpm codegen:mainnet` | `pnpm codegen:local` |
| run | `pnpm dev` / `pnpm start` | `pnpm start:mainnet` (or `ENVIO_CONFIG=config.mainnet.yaml pnpm dev`) | `pnpm local:up` |
| Envio Cloud "Config file" | `config.yaml` | `config.mainnet.yaml` | — |

## Run the tests

```bash
cd indexer
pnpm install
pnpm codegen   # generates .envio/types.d.ts from config.yaml + schema.graphql
pnpm typecheck
pnpm test      # vitest + createTestIndexer: simulated events through the real handlers
```

The handler tests simulate chain `5042002`, so run them on the testnet codegen (`pnpm codegen`, or
`pnpm codegen:all`, which ends with it). The handlers themselves typecheck under all three configs.

## Run locally against the arc-anvil fork (no testnet tx, no token)

The whole loop on your machine: Circle's `arc-anvil` forks Arc testnet (it moves Arc's native USDC,
which plain anvil can't), the indexer reads it over RPC, and the app reads the indexer's GraphQL.
Needs Docker, Arc Foundry and the relay from the repo root.

```bash
# 0. the fork + contracts + relay (once)
../scripts/local-up.sh              # arc-anvil :8710 (chain 31337, fork of Arc testnet), relay :8799

# 1. the indexer stack
cd indexer
pnpm install
pnpm local:up        # Postgres :5435, Hasura :8090, `envio dev -r` on config.local.yaml; waits until synced

# 2. real game activity, then the end-to-end check
pnpm seed:local      # two fresh wallets: onboard, a USDC match that settles, a USDC match that voids, a chest, a merge
pnpm verify:local    # ~50 checks against the GraphQL API; exits 1 on any mismatch

# 3. done
pnpm local:down      # stops the indexer, removes both containers, restores codegen for config.yaml
```

**GraphQL for the app:** `http://localhost:8090/v1/graphql`. Put it in `app/.env.local`:

```bash
VITE_INDEXER_URL=http://localhost:8090/v1/graphql
```

Every entity is readable on Hasura's `public` role, so the app sends no secret (CORS allows any
origin). The Hasura console is at `http://localhost:8090/console` (admin secret `testing`).
`pnpm local:status` shows what is running and the synced block; `./scripts/local-indexer.sh logs`
tails the indexer.

| | Default | Override |
|---|---|---|
| Postgres | `127.0.0.1:5435`, db `envio-dev`, user `postgres` / `testing`, container `mempire-envio-postgres` | `MEMPIRE_PG_PORT` |
| Hasura | `http://localhost:8090`, container `mempire-envio-hasura` (network `mempire-envio-net`) | `MEMPIRE_HASURA_PORT` |
| Indexer metrics | `:9911` | `MEMPIRE_INDEXER_PORT` |
| arc-anvil fork | `http://127.0.0.1:8710`, chain `31337` | `MEMPIRE_RPC` (the indexer's own RPC URL is in `config.local.yaml`) |
| relay (seed only) | `http://localhost:8799` | `MEMPIRE_RELAY` |

**How it works.** `config.local.yaml` declares chain 31337 with `rpc: [{ url: http://127.0.0.1:8710, for: sync }]`
(HyperSync has no local chain, so RPC is the only data source), the contract addresses and start block
from `shared/deployments/31337.json`, and `rollback_on_reorg: false`. `local-indexer.sh up` refuses an
RPC that is not chain 31337, syncs `config.local.yaml` when it is behind the deployment file, starts
its own Postgres and Hasura, then runs `envio dev -r` with:

```bash
ENVIO_CONFIG=config.local.yaml
ENVIO_PG_HOST=127.0.0.1 ENVIO_PG_PORT=5435 ENVIO_PG_USER=postgres ENVIO_PG_PASSWORD=testing ENVIO_PG_DATABASE=envio-dev
HASURA_EXTERNAL_PORT=8090                                    # envio dev: "Using Hasura already running on port 8090"
HASURA_GRAPHQL_ENDPOINT=http://localhost:8090/v1/metadata    # where the indexer tracks its tables
HASURA_GRAPHQL_ADMIN_SECRET=testing
ENVIO_INDEXER_PORT=9911 ENVIO_TUI=false
```

Why not plain `pnpm dev`: Envio 3.13 creates its Docker resources under **fixed global names**
(`envio-postgres` on :5433, `envio-hasura` on :8080, `envio-network`). On a machine where another
project already runs those, `envio dev` would share that project's database and overwrite its Hasura
table tracking, and **`envio stop` deletes those containers by name**. So the local stack uses
`mempire-*` containers, and `local:down` removes only them. Do not run `envio stop` for this setup.

`-r` re-indexes from the deployment block on every `local:up`: the fork is the source of truth and a
few hundred blocks index in about a second. While the stack is up, `.envio/types.d.ts` is generated
from `config.local.yaml`; `local:down` runs `envio codegen` again so `pnpm test` sees the testnet config.

**What `seed:local` does** (all through viem, gas estimated by viem, paid in native USDC):

1. Two fresh wallets A and B. Each signs `Mempire\naction: onboard\nwallet: <address>\nts: <ms>` (EIP-191)
   and POSTs it to the relay's `/api/onboard` (8-card starter deck, plus the relay's test-chain USDC drip),
   then gets 20 USDC (native value, which is also its ERC-20 balance) from anvil account #0
   (`test test … junk`, index 0). A also gets 2,000 $MEMPIRE from #0.
2. **Match 1, Pauper ($1), settles.** A creates it with a USDC EIP-2612 permit (domain `USDC` / `2`; seat 0);
   B approves and joins (seat 1). Three `play`s and a `checkpoint` from each seat; both `claim` seat 0.
   A gets pot − rake, the 50 $MEMPIRE win reward, and a chest.
3. **Match 2, Pauper ($1), voids.** B approves and creates (seat 0), A joins with a permit (seat 1), each
   forwarding 0.2 USDC of gas to a session key; the session keys play, checkpoint and claim different
   winners: both stakes come back.
4. **The chest.** `startUnlock`, then wait the real timer (`unlockSeconds(tier)`, time scale 60: Silver 15 s)
   by polling `open` as a call. A tier whose timer is longer than `SEED_MAX_WAIT` (60 s) is `skip`ped
   with 25 $MEMPIRE instead. Then `open`, `anvil_mine 2`, `reveal` favouring A's deck coins.
5. **A merge.** If a drop duplicates a coin A holds, merge it; if not, buy a golden chest (100 $MEMPIRE,
   no timer) and open it, up to four times.

It writes `.local/seed-manifest.json` (wallet addresses, match ids, every play's tx, the chest, the merge).

**What `verify:local` checks**, against that manifest and the chain:

- `Player` (via the app's `PlayerHistory`): record, `netUsdc` = pot − rake − stake for the winner and −stake
  for the loser (the void moves nothing), `wageredUsdc`, reward, chests, `cardsOwned` = `cardsOf()` on chain
- `MatchSeat` and `Match`: result, payout and net per seat, `USDC` currency and address, pot / rake / payout,
  claims, session keys, the meta epoch
- `Play`: every seeded drop, attributed to the player (not the session key) and resolved to the deck's card and coin
- `Chest`, `Card`, `Merge`: tier, state, skip, drops linked to the chest, the burned card and the levelled one
- `MarketEpoch`: one row per on-chain `MetaSource` log, with the same source and poster; the seeded matches'
  epoch is `ChainlinkFeeds` (the relay's keeper calls `postFromFeeds`; there is no CRE DON on a fork) and
  `MarketMeta.epochSource()` agrees
- `Coin`, `DailyStats`, `Totals`, `MarketEpoch.matches`: recomputed from the indexed rows (other sessions may
  play on the same fork, so these are consistency checks rather than fixed numbers)
- every query in `scripts/query.mjs` runs on the public role

## Run locally against Arc testnet

Running locally needs Docker for Postgres and Hasura, plus an Envio API token for HyperSync (create one at https://envio.dev/app/api-tokens).

```bash
cd indexer
cp .env.example .env          # set ENVIO_API_TOKEN
pnpm dev                      # codegen, then indexer + Postgres + Hasura (config.yaml, chain 5042002)
# GraphQL: http://localhost:8080/v1/graphql   (console password: testing)
pnpm exec envio stop          # tear down
```

For mainnet, `ENVIO_CONFIG=config.mainnet.yaml pnpm dev`. This uses Envio's default `envio-postgres` /
`envio-hasura` containers (:5433 / :8080). If another project on the machine already runs them, use the
pattern in `scripts/local-indexer.sh` instead (own containers, `ENVIO_PG_HOST` / `HASURA_EXTERNAL_PORT` /
`HASURA_GRAPHQL_ENDPOINT`), and skip `envio stop`.

## Deploy to Envio Cloud

1. Push this repo to GitHub. Run `pnpm sync` (and/or `pnpm sync:mainnet`) first so the config has the real addresses and start block.
2. Sign in at https://envio.dev/app/login with GitHub, then pick your personal account or an organisation.
3. Install the **Envio Deployments** GitHub App and give it access to the repo.
4. Click **Add Indexer** and select the repo. Set:
   - **Root directory:** `indexer`
   - **Config file:** `config.yaml` (Arc testnet) or `config.mainnet.yaml` (Arc mainnet) — one indexer per network
   - **Deployment branch:** for example `envio` or `main`
5. Push to the deployment branch. Each push builds and re-indexes from `start_block`, and the old version keeps serving until the new one has synced.
6. Copy the deployment's GraphQL endpoint from the dashboard (or run `npx envio-cloud deployment endpoint <indexer> <commit>`) into the app's config.

Envio Cloud's requirements are: `package.json` in the root directory with `envio` pinned (it is: `3.13.0`), pnpm 10 compatible, Node 24 recommended, and no imports from outside `indexer/`.

The free development plan has a soft limit of **100,000 processed events** per deployment. Each match can log up to 400 `Played` events, so a busy testnet demo can reach that limit. Watch it in the dashboard, or upgrade the plan for the judging window.
