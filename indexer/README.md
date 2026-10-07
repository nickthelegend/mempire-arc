# Mempire indexer (Envio HyperIndex)

An [Envio HyperIndex](https://docs.envio.dev) indexer for Mempire on **Monad testnet (chain 10143)**,
which is a native HyperSync chain (`https://10143.hypersync.xyz`), and on the **local anvil chain
(31337)** over plain RPC. It turns the three Mempire contracts into a GraphQL API the app uses for
leaderboards, match history, the live play feed and fighter win rates.

- HyperIndex **v3** (`envio@3.13.0`): `chains:` config, `indexer.onEvent` handlers, `createTestIndexer` tests
- `config.yaml` lists the contracts and events (Monad testnet), `schema.graphql` holds the entity model, and `src/handlers/*.ts` holds the handlers
- `config.local.yaml` is the same project pointed at anvil (`127.0.0.1:8611`, RPC data source); `test/config.test.ts` fails if its contracts drift from `config.yaml`
- `test/mempire.test.ts` holds the handler tests (simulated events, no network or Docker)
- `scripts/sync-addresses.mjs` updates `config.yaml` (or `config.local.yaml`) after a deploy
- `scripts/query.mjs` holds the app's queries and a runner that tries them against an endpoint
- `scripts/local-indexer.sh` runs the indexer against anvil with its own Postgres + Hasura; `scripts/seed-local.mjs` plays real matches on anvil; `scripts/verify-local.mjs` checks the GraphQL API against what was seeded

## What is indexed

| Contract | Events | What they drive |
|---|---|---|
| `MempireCards` (ERC-721 fighters) | `CoinRegistered`, `CoinActive`, `CardMinted`, `CardMerged`, `Transfer`, `ChestGranted`, `ChestForfeited`, `ChestUnlocking`, `ChestSkipped`, `ChestOpening`, `ChestOpened` | roster, every card with its owner/level/history, merges, chest lifecycle |
| `MempireArena` (escrowed 1v1) | `MatchCreated`, `MatchJoined`, `MatchCancelled`, `Played`, `Checkpoint`, `Claimed`, `MatchSettled`, `MatchVoided`, `WinRewarded`, `PayoutHeld` | matches, per-seat results and P&L, the on-chain play log, claims, payouts |
| `MarketMeta` (Chainlink CRE or Pyth momentum) | `MetaPosted`, `MetaSource` | per-epoch ±15% modifier per fighter, current modifier on each coin, and which source wrote the epoch |

## Entity model

```
Player ─┬─< Card >── Coin ─< CoinModifier >── MarketEpoch
        ├─< MatchSeat >── Match ─┬─< Play  (coin + card resolved from the seat's deck)
        │                        ├─< Checkpoint
        │                        └─< Claim
        └─< Chest ─< Card (drops)
Card ─< Merge            DailyStats (per UTC day)      Totals (id "global")
```

| Entity | Notes |
|---|---|
| `Player` | matches / wins / losses / ties / voids, `netMon` / `netAusd` (payout − stake, base units), wagered, cards owned, highest level, merges, chests, rewarded wins, `lastActive` |
| `Card` | owner, coin, level, archetype, source (Mint / MintMempire / Starter / Chest), Pyth mint price + expo, chest it dropped from, `burned`, `mergedInto`, `mergesAbsorbed`, its own win/loss record |
| `Coin` | ticker, name and kind (crypto / meme / stock, joined from `shared/roster.json` by Pyth feed id), archetype, supply, merges, **deck appearances, wins / losses / ties when fielded, `winRateBps`**, results split by buffed/nerfed modifier, `timesPlayed`, current modifier |
| `Match` | both players and session keys, tier, currency, stake, deck hashes, powers, meta epoch, state, outcome, winner, plays per seat, checkpoints, both claims, pot / rake / payouts, chest tier, timestamps, `durationSeconds`, `byTimeout`, `disputed` |
| `MatchSeat` | one row per (match, seat): the player's side, deck `cardIds` → `coinIds`, result, payout, `net`. This is the player-history entity |
| `Play` | match, seat, player, tick, cardIndex, **card and coin resolved from the seat's deck**, x, y, per-seat sequence, block, log index, timestamp, tx hash. This drives the live feed |
| `Chest` | tier, bought, state machine (Idle → Unlocking → Revealing → Opened), the match that paid it, skip fee, reveal block, re-commits, seed, drops |
| `MarketEpoch` / `CoinModifier` | each epoch's report, its top and bottom movers, the matches that snapshotted it, and its `source` (`ChainlinkCRE` from `onReport`, `PythMomentum` from `postFromPyth`), raw `sourceCode` (0 / 1) and `poster` (the CRE forwarder, or whoever paid the Pyth update) |
| `DailyStats` | matches created / started / settled / voided / cancelled, ties, volume and rake per currency, plays, checkpoints, mints, merges, chests, rewards, unique and new players |
| `Merge`, `Checkpoint`, `Claim`, `HeldPayout` | event logs |
| `Totals` | protocol-wide counters (single row `id: "global"`) |
| `PlayerDay`, `SettlementTx` | internal join rows: unique-players-per-day, and settlement tx → match (so the `ChestGranted` / `ChestForfeited` that the arena fires later in the same tx find their match) |

### The joins and the edge cases

- **Coin win rates are derived.** `MatchCreated` and `MatchJoined` carry each deck's `cardIds`. Every card is resolved to its coin and stored on the `MatchSeat`. At settlement each coin in the winning deck gets a win and each coin in the losing deck gets a loss. A tie gives every coin on both sides a tie. The modifier the coin carried in the epoch the match snapshotted at join decides whether the result is also counted as buffed or nerfed.
- **Void and disputed matches move no money.** A `MatchVoided` (disputed claims, or no claims by the deadline) marks both seats `Void` with `payout = stake` and `net = 0`. It changes no player's `net*` or `wagered*`, no coin results, and no volume or rake. `MatchCancelled` is handled the same way.
- **Ties split.** Each seat is paid `(pot − rake) / 2`; the contract sends the odd unit to the rake.
- **Walkovers.** A settlement through `claimTimeout` (`byTimeout = true`) still pays the pot, but only the winner's `winsByTimeout` marks it.
- **Mints and burns.** A `Transfer` from the zero address is a mint, which the `CardMinted` in the next log creates. A `Transfer` to the zero address is a burn, and the following `CardMerged` links the burned card to the card it was merged into.
- **Market resets.** A coin left out of an epoch's `MetaPosted` reads 0 on chain for that epoch, so its `currentModifierBps` resets to 0.
- **Meta source.** `MarketMeta` emits `MetaSource(epoch, source, poster)` right after `MetaPosted` in the same transaction. The handler fills `source` / `sourceCode` / `poster` on that epoch's row and does not depend on the log order: a `MetaPosted` keeps a source already recorded.
- **Addresses** are stored lowercase (`address_format: lowercase`). Query with `address.toLowerCase()`.
- **Amounts** are `BigInt` in base units: MON in wei, AUSD in 6-decimal units, $MEMPIRE in wei.

## Queries the app uses

Envio exposes a Hasura GraphQL API. Entity names are used as written, relations can be filtered as `<field>_id`, and single rows come from `<Entity>_by_pk`. All of these queries are in `scripts/query.mjs`.

**Leaderboard by wins**

```graphql
query LeaderboardByWins($limit: Int = 20) {
  Player(where: { matches: { _gt: 0 } }, order_by: [{ wins: desc }, { netMon: desc }], limit: $limit) {
    id wins losses ties voids matches netMon netAusd highestLevel cardsOwned lastActive
  }
}
```

**Leaderboard by net MON**

```graphql
query LeaderboardByNetMon($limit: Int = 20) {
  Player(where: { matches: { _gt: 0 } }, order_by: [{ netMon: desc }, { wins: desc }], limit: $limit) {
    id netMon wageredMon wins losses ties matches
  }
}
```

**A player's match history** (`$player` lowercase)

```graphql
query PlayerHistory($player: String!, $limit: Int = 20) {
  Player_by_pk(id: $player) {
    id matches wins losses ties voids netMon netAusd cardsOwned highestLevel chestsOpened rewardedWins lastActive
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
    id ticker name kind archetypeName fielded wins losses ties winRateBps deckAppearances
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
    players coins matches matchesSettled matchesVoided plays cardsMinted merges chestsOpened volumeMon volumeAusd currentEpoch
  }
  DailyStats(order_by: { dayStart: desc }, limit: $days) {
    id matchesStarted matchesSettled matchesVoided volumeMon volumeAusd plays cardsMinted merges uniquePlayers newPlayers
  }
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

`contracts/script/Deploy.s.sol` writes `shared/deployments/10143.json`. After that file exists, run:

```bash
cd indexer
pnpm sync      # copies ABIs + roster, writes cards/arena/marketMeta addresses and start_block into config.yaml
pnpm codegen
pnpm test
```

For the local chain, `node scripts/sync-addresses.mjs --chain 31337 --config config.local.yaml`
does the same for `config.local.yaml` (`scripts/local-indexer.sh up` runs it when the addresses are stale).

`node scripts/sync-addresses.mjs --check` exits non-zero while `config.yaml` still has its
`# TODO` placeholder addresses. The script also refreshes `abis/` and `src/roster.generated.ts`
because Envio Cloud builds only the `indexer/` directory, so the indexer cannot import anything from outside it.

## Run the tests

```bash
cd indexer
pnpm install
pnpm codegen   # generates .envio/types.d.ts from config.yaml + schema.graphql
pnpm typecheck
pnpm test      # vitest + createTestIndexer: simulated events through the real handlers
```

## Run locally against anvil (no testnet, no token)

The whole loop on your machine: anvil holds the game, the indexer reads it over RPC, and the app reads
the indexer's GraphQL. Needs Docker, Foundry and the relay from the repo root.

```bash
# 0. the chain + relay (once; idempotent about anvil)
../scripts/local-up.sh --relay           # anvil :8611 (chain 31337), relay :8799

# 1. the indexer stack
cd indexer
pnpm install
pnpm local:up        # Postgres :5435, Hasura :8090, `envio dev -r` on config.local.yaml; waits until synced

# 2. real game activity, then the end-to-end check
pnpm seed:local      # two fresh wallets: onboard, an AUSD match that settles, a MON match that voids, a chest, a merge
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
| anvil | `http://127.0.0.1:8611` | `MEMPIRE_RPC` (the RPC URL itself is in `config.local.yaml`) |
| relay (seed only) | `http://localhost:8799` | `MEMPIRE_RELAY` |

**How it works.** `config.local.yaml` declares chain 31337 with `rpc: [{ url: http://127.0.0.1:8611, for: sync }]`
(HyperSync has no local chain, so RPC is the only data source), the three addresses from
`shared/deployments/31337.json`, `start_block: 0` and `rollback_on_reorg: false`. `local-indexer.sh`
starts its own Postgres and Hasura first, then runs `envio dev -r` with:

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

`-r` re-indexes from block 0 on every `local:up`: anvil is the source of truth and a few hundred
blocks index in about a second. While the stack is up, `.envio/types.d.ts` is generated from
`config.local.yaml`; `local:down` runs `envio codegen` again so `pnpm test` sees the testnet config.

**What `seed:local` does** (all through viem, gas estimated by viem):

1. Two fresh wallets A and B. Each signs `Mempire\naction: onboard\nwallet: <address>\nts: <ms>` (EIP-191)
   and POSTs it to the relay's `/api/onboard` (8-card starter deck, 10,000 AUSD from the faucet, MON drip),
   then gets 2 MON from anvil account #0 (`test test … junk`, index 0). A also gets 2,000 $MEMPIRE from #0.
2. **Match 1, AUSD Pauper (1 AUSD), settles.** A creates it with an EIP-2612 permit (seat 0); B approves
   and joins (seat 1). Three `play`s and a `checkpoint` from each seat; both `claim` seat 0. A gets
   pot − 10% rake, the 50 $MEMPIRE win reward, and a chest.
3. **Match 2, MON Pauper (0.01 MON), voids.** B creates (seat 0) and A joins (seat 1), each forwarding
   0.05 MON to a session key; the session keys play, checkpoint and claim different winners: both stakes come back.
4. **The chest.** `startUnlock`, then wait the real timer (`unlockSeconds(tier)`, time scale 60: Silver 15 s)
   by polling `open` as a call. A tier whose timer is longer than `SEED_MAX_WAIT` (60 s) is `skip`ped
   with 25 $MEMPIRE instead. Then `open`, `anvil_mine 2`, `reveal` favouring A's deck coins.
5. **A merge.** If a drop duplicates a coin A holds, merge it (100 $MEMPIRE); if not, buy a golden
   chest (no timer) and open it, up to four times.

It writes `.local/seed-manifest.json` (wallet addresses, match ids, every play's tx, the chest, the merge).

**What `verify:local` checks**, against that manifest and the chain:

- `Player` (via the app's `PlayerHistory`): record, `netAusd` = pot − rake − stake for the winner and −stake
  for the loser, `netMon` = 0 for both (the void moves nothing), reward, chests, `cardsOwned` = `cardsOf()` on chain
- `MatchSeat` and `Match`: result, payout and net per seat, pot / rake / payout, claims, session keys, the meta epoch
- `Play`: every seeded drop, attributed to the player (not the session key) and resolved to the deck's card and coin
- `Chest`, `Card`, `Merge`: tier, state, skip, drops linked to the chest, the burned card and the levelled one
- `MarketEpoch`: one row per on-chain `MetaSource` log, with the same source and poster; the seeded matches'
  epoch is `PythMomentum` and `MarketMeta.epochSource()` agrees
- `Coin`, `DailyStats`, `Totals`, `MarketEpoch.matches`: recomputed from the indexed rows (other sessions may
  play on the same anvil, so these are consistency checks rather than fixed numbers)
- every query in `scripts/query.mjs` runs on the public role

## Run locally against Monad testnet

Running locally needs Docker for Postgres and Hasura, plus an Envio API token for HyperSync (create one at https://envio.dev/app/api-tokens).

```bash
cd indexer
cp .env.example .env          # set ENVIO_API_TOKEN
pnpm dev                      # codegen, then indexer + Postgres + Hasura
# GraphQL: http://localhost:8080/v1/graphql   (console password: testing)
pnpm exec envio stop          # tear down
```

This uses Envio's default `envio-postgres` / `envio-hasura` containers (:5433 / :8080). If another
project on the machine already runs them, use the pattern in `scripts/local-indexer.sh` instead (own
containers, `ENVIO_PG_HOST` / `HASURA_EXTERNAL_PORT` / `HASURA_GRAPHQL_ENDPOINT`), and skip `envio stop`.

## Deploy to Envio Cloud

1. Push this repo to GitHub (public). Run `pnpm sync` first so `config.yaml` has the real testnet addresses and start block.
2. Sign in at https://envio.dev/app/login with GitHub, then pick your personal account or an organisation.
3. Install the **Envio Deployments** GitHub App and give it access to the repo.
4. Click **Add Indexer** and select the repo. Set:
   - **Root directory:** `indexer`
   - **Config file:** `config.yaml`
   - **Deployment branch:** for example `envio` or `main`
5. Push to the deployment branch. Each push builds and re-indexes from `start_block`, and the old version keeps serving until the new one has synced.
6. Copy the deployment's GraphQL endpoint from the dashboard (or run `npx envio-cloud deployment endpoint <indexer> <commit>`) into the app's config.

Envio Cloud's requirements are: `package.json` in the root directory with `envio` pinned (it is: `3.13.0`), pnpm 10 compatible, Node 24 recommended, and no imports from outside `indexer/`.

The free development plan has a soft limit of **100,000 processed events** per deployment. Each match can log up to 400 `Played` events, so a busy testnet demo can reach that limit. Watch it in the dashboard, or upgrade the plan for the judging window.
