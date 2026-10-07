# Mempire × Chainlink CRE — the market is the meta

A Chainlink Runtime Environment workflow that, every epoch, reads the 24-hour
price change of all 36 fighters in the roster, reaches consensus across the
DON, turns each change into a bounded strength modifier, and writes **one**
report to `MarketMeta` on **Monad testnet** (`monad-testnet`, chain id 10143).

```
cron (every 10 min) ─┬─► CoinGecko /simple/price   (24 crypto + meme, one batched call per node)
                     └─► Pyth Hermes latest + 24h-ago (12 stocks, only if PYTH_API_KEY is set)
                                   │
                     median per coin across the DON (ConsensusAggregationByFields)
                                   │
              bps = clamp(round(change% × 40), −1500, +1500), every coin, coinId order
                                   │
       abi.encode(uint64 epoch, uint16[] coinIds, int16[] bps) ─► signed report
                                   │
            KeystoneForwarder ─► MarketMeta.onReport ─► modifierBps[epoch][coinId]
```

## Why it is load-bearing

This isn't a side feed. It decides fights.

- `MempireArena` snapshots `MarketMeta.currentEpoch()` into the match when a
  player joins (`m.metaEpoch = marketMeta.currentEpoch()`).
- Both game clients read `modifierBps[metaEpoch][coinId]` (or
  `modifiersFor(epoch, coinIds)`) and apply it to the fighters' stats. They
  never compute it, so they always agree, and a match keeps the same numbers
  from first card to last even if a new epoch lands mid-match.
- An asset that ran today fights a little stronger today, and one that dumped
  fights a little weaker. The cap is ±15% and never touches elixir, which is less
  than levels give, so the market reshuffles the meta without making wins
  something you can buy.
- The contract only accepts reports from the configured forwarder, requires
  strictly increasing epochs, and rejects any |bps| > 1500. No single server
  can post the meta. A DON has to agree on it.

## The math (`market-meta/meta.ts`, unit tested)

| | |
|---|---|
| Modifier | `bps = clamp(round(change24hPercent × 40), −1500, +1500)` |
| Anchor | a +20% day → **+800 bps** (8% stronger); −20% → −800 |
| Cap | ±1500 bps (±15%), reached at a ±37.5% day. Matches `MarketMeta.MAX_BPS` |
| Rounding | nearest integer, halves **away from zero**, so +x% and −x% are exact opposites (`Math.round` would send −2.5 → −2 but +2.5 → +3). Never emits −0 |
| No data | 0 bps (neutral). A coin is never guessed |
| Epoch | `floor(unixSeconds / 600)` from DON consensus time (`runtime.now()`). Simulating again 10 minutes later produces a new, higher epoch. **Production would use hourly (3600) or daily (86400) epochs**, and `config.production.json` uses 3600 with an hourly cron |
| Report | `abi.encode(uint64 epoch, uint16[] coinIds, int16[] bps)`. The tests round-trip it through viem `decodeAbiParameters` with exactly `(uint64,uint16[],int16[])` and pin the golden bytes Solidity's `abi.encode` produces |
| Layout | all 36 coins, ascending `coinId`. A flat coin is written as an explicit 0, so `0` never means "not reported" |

### Data sources

- **Crypto + meme (24 coins).** CoinGecko
  `https://api.coingecko.com/api/v3/simple/price?ids=…&vs_currencies=usd&include_24hr_change=true`
  (no key), one batched request per node. A coin CoinGecko doesn't return is
  written as 0 and counted in the logs.
- **Stocks (12 coins).** If the `PYTH_API_KEY` secret is set, the workflow
  calls Pyth Hermes at `https://pyth.dourolabs.app/hermes` with
  `Authorization: Bearer <key>`. It compares `/v2/updates/price/latest` against
  `/v2/updates/price/<now − 86400>` for all 12 feeds in one batched request
  each, using exact integer math on Pyth's `price × 10^expo`. A pair that spans
  less than `pythMinWindowSeconds` (3600) counts as flat. That happens when the
  market is closed and Hermes returns the same or a later print for "24h ago".
  **If no key is configured, stocks get 0 bps and the log says so:**
  `PYTH_API_KEY not configured: 12 stocks get 0 bps this epoch`. If Hermes is
  down, stocks also get 0 and the log says so. The crypto report still goes out.
- If **CoinGecko** fails across the DON, the workflow throws and writes
  **nothing**. A report of all zeros would wipe the meta. With no report,
  matches keep using the previous epoch.

### Consensus: why a median per coin

Each node fetches the source itself and turns every change into an integer
bps. The DON then takes a **median of each coin's field independently**
(`ConsensusAggregationByFields` with `median` for every `c<coinId>` key).
Identical-result consensus on the whole bps array was rejected because
CoinGecko and Hermes answers drift slightly between nodes (edge caches, a
print landing between two requests). One coin off by 1 bps would sink quorum
for the entire report. A per-coin median tolerates up to f faulty or lagging
nodes and still lands on an honest value. The curve is monotonic, so the
median of the bps equals the bps of the median change. Medians run in float64,
so `normalizeBps` re-rounds and re-clamps the consensus output. That makes it
deterministic even if an even node count averages two neighbours.

### On-chain write

- Before writing, the workflow reads `MarketMeta.currentEpoch()` (latest
  block). If the chain is already at this epoch (for example, the cron fired
  twice in one window), it logs and skips the write instead of paying for a
  `StaleEpoch` revert.
- `gasLimit: 1500000`. Measured on anvil against the real MarketMeta bytecode
  with all 36 coins non-zero, a direct `onReport` call uses **940,977 gas**
  (36 cold SSTOREs ≈ 800k, plus the `MetaPosted` event and calldata). The
  remaining ~560k covers the forwarder's signature checks and bookkeeping.
  Monad charges by gas *limit*, so don't raise this casually.
- The workflow fails loudly when `txStatus != SUCCESS` and also when the
  forwarder tx succeeded but `onReport` itself reverted
  (`receiverContractExecutionStatus == REVERTED`). The usual causes are a
  wrong forwarder or a stale epoch.
- If `marketMetaAddress` is the zero address (the current state, because
  MarketMeta isn't deployed on 10143 yet), the workflow computes, logs and
  returns the encoded report and **does not write**.

## Layout

```
cre/
├── project.yaml              RPCs per target (monad-testnet → https://testnet-rpc.monad.xyz)
├── secrets.yaml              PYTH_API_KEY → env CRE_PYTH_API_KEY (names only)
├── .env.example              CRE_ETH_PRIVATE_KEY, CRE_PYTH_API_KEY (copy to .env, gitignored)
├── scripts/gen-roster.ts     shared/roster.json → market-meta/roster.ts
└── market-meta/
    ├── workflow.yaml         staging-settings (10-min) / production-settings (hourly)
    ├── config.staging.json   ← marketMetaAddress TODO
    ├── config.production.json
    ├── main.ts               triggers, HTTP fetch + consensus, report, write
    ├── meta.ts               pure math / parsing / encoding
    ├── roster.ts             GENERATED — do not edit
    ├── meta.test.ts          curve, epoch, parsers, ABI round-trip + golden bytes
    ├── main.test.ts          whole handler against the SDK's HTTP/EVM mocks
    └── roster.test.ts        fails if roster.ts drifts from shared/roster.json
```

The roster is compiled in because a WASM workflow can't read files. After any
change to `shared/roster.json`:

```bash
cd cre/market-meta && bun run gen:roster
```

## Develop

```bash
cd cre/market-meta
bun install            # then `bunx cre-setup` once if the postinstall didn't run it
bun run typecheck      # workflow (WASM-restricted types) + tests
bun test               # 33 tests
bunx cre-compile main.ts dist/market-meta.wasm   # offline WASM build, no login needed
```

## Before the first simulation: TODO

1. **Set the MarketMeta address.** After `contracts/script/Deploy.s.sol` runs on
   Monad testnet, copy `marketMeta` from `shared/deployments/10143.json` into
   `market-meta/config.staging.json` → `marketMetaAddress`. For
   `simulate --broadcast` that deployment's forwarder must be the simulator's
   **MockKeystoneForwarder `0xB9F79d863261869B234c481D1f9A7af84AeAd192`** (deploy
   with `CRE_FORWARDER=0xB9F79d863261869B234c481D1f9A7af84AeAd192`, or call
   `MarketMeta.setForwarder(0xB9F7…D192)` as owner). Leave
   `expectedWorkflowOwner` unset while simulating.
2. **Log in.** `cre workflow simulate` (and `cre init`) refuse to run without
   a CRE session:
   ```bash
   cre login            # opens a browser; finish sign-in there
   cre whoami
   ```
   Or set `CRE_API_KEY` for non-interactive use.
3. **Env.** `cp .env.example .env` in `cre/` (a placeholder `.env` is already
   there), then set:
   - `CRE_ETH_PRIVATE_KEY`: a funded Monad-testnet key (the deployer works).
     Only needed for `--broadcast`. Without it the CLI uses a built-in dummy key.
   - `CRE_PYTH_API_KEY`: a Pyth Hermes key, or leave it **empty** (the variable
     must exist; an empty value means stocks are flat).

## Simulate (run from `cre/`)

Dry run (no transaction). It fetches real prices, runs consensus, and logs the
modifier table and the encoded report, or the `currentEpoch` check if the
address is set:

```bash
cre workflow simulate market-meta --target staging-settings --non-interactive --trigger-index 0
```

Real write through the MockKeystoneForwarder on Monad testnet, once
`marketMetaAddress` is set:

```bash
cre workflow simulate market-meta --target staging-settings --non-interactive --trigger-index 0 --broadcast
```

Then check it on chain:

```bash
cast call <MarketMeta> "currentEpoch()(uint64)" --rpc-url https://testnet-rpc.monad.xyz
cast call <MarketMeta> "modifierBps(uint64,uint16)(int16)" <epoch> 0 --rpc-url https://testnet-rpc.monad.xyz
```

Run it again ≥10 minutes later and you get a new epoch. Within the same
10-minute window the workflow logs `skipping write` instead of reverting.

Optional on-demand trigger: set `httpTrigger.enabled: true` (and
`authorizedKeys` to the EVM addresses allowed to fire it). It becomes handler
index 1:

```bash
cre workflow simulate market-meta --target staging-settings --non-interactive --trigger-index 1 --http-payload '{}'
```

## Deploy (when CRE deploy access is granted)

1. Redeploy, or `setForwarder`, MarketMeta with the **production KeystoneForwarder
   `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`** on Monad testnet, then
   `setExpectedWorkflowOwner(<your workflow owner address>)` so only this
   workflow's reports are accepted. Put that address in
   `config.production.json` → `marketMetaAddress`.
2. `cre account link-key --target production-settings` (links the owner key)
3. If using Pyth: `cre secrets create secrets.yaml --target production-settings`
   (uploads `PYTH_API_KEY` to the Vault DON; values come from your env)
4. `cre workflow deploy market-meta --target production-settings`
5. `cre workflow activate market-meta --target production-settings`
6. Monitor with `cre workflow get market-meta --target production-settings`

Production runs hourly (`0 0 * * * *`, `epochSeconds: 3600`). Daily epochs
would need only `epochSeconds: 86400` and a daily cron. The contract and the
clients don't care about epoch length, only that epochs increase.
