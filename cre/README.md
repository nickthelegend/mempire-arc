# Mempire × Chainlink CRE — the market is the meta

The game has **20 fighters, one per Chainlink Data Feed on Arc mainnet**
(`shared/roster.json`): nine crypto majors (BTC ETH SOL BNB XRP AVAX TRX BCH
HYPE), three DeFi tokens (LINK UNI AAVE), and eight real-world assets: gold
(PAXG) and seven currencies (EUR JPY AUD CAD MXN BRL KRW, all quoted as
`XXX / USD`). Every epoch, each fighter gets a bounded strength modifier from
its daily price move and `MarketMeta` stores it as `modifierBps[epoch][coinId]`.

Two writers produce that meta. They emit the same events and the arena,
clients and indexer treat them the same way:

| Network | Writer | Where the numbers come from |
|---|---|---|
| **Arc mainnet** (5042) | **`MarketMeta.postFromFeeds`**, posted each window by the relay's keeper (`server/keeper.js`) | **Chainlink Data Feeds, on chain.** The contract reads each fighter's feed `latestRoundData` and the feed's own round from 24h earlier, then computes the move itself. The poster only names that earlier round, and the contract rejects anything that isn't exactly the round current at `now − 24h`. `MetaSource(epoch, 1, poster)` |
| **Arc testnet** (5042002) | **This CRE workflow** → KeystoneForwarder → `MarketMeta.onReport` | CoinGecko (crypto, DeFi, PAXG) and Frankfurter (fiat), with DON consensus. `MetaSource(epoch, 0, forwarder)` |

> **CRE does not serve Arc mainnet.** `arc-mainnet` has a chain selector but
> no CRE capability DON, so `config.*.json` refuses
> `chainSelectorName: "arc-mainnet"` and points at `postFromFeeds`. On mainnet
> MarketMeta is deployed with `CRE_FORWARDER` unset (zero), and `onReport`
> accepts nothing.

The workflow can't read the Data Feeds because they only exist on Arc
mainnet. So it uses the same 24h moves from public off-chain sources and the
same curve, which makes testnet games behave like mainnet ones.

```
cron (every 10 min) ─┬─► CoinGecko /simple/price            13 fighters: crypto, DeFi, PAXG (one batched call per node)
                     └─► Frankfurter /v1/latest + /v1/<yesterday>  7 fiat fighters (USD → XXX, inverted)
                                   │
                     median per coin across the DON (ConsensusAggregationByFields)
                                   │
              bps = clamp(round(change% × 40), −1500, +1500), every coin, coinId order
                                   │
       abi.encode(uint64 epoch, uint16[] coinIds, int16[] bps) ─► signed report
                                   │
            KeystoneForwarder ─► MarketMeta.onReport ─► modifierBps[epoch][coinId]
```

No API keys are involved. Both sources are keyless, so the workflow declares no
secrets. There is no Pyth: the old stock fighters and their Hermes path are gone.

## Why it is load-bearing

This isn't a side feed. It decides fights.

- `MempireArena` snapshots `MarketMeta.currentEpoch()` into the match when a
  player joins (`m.metaEpoch = marketMeta.currentEpoch()`).
- Both game clients read `modifierBps[metaEpoch][coinId]` (or
  `modifiersFor(epoch, coinIds)`) and apply it to the fighters' stats. They
  never compute it, so they always agree, and a match keeps the same numbers
  from first card to last even if a new epoch lands mid-match.
- An asset that ran today fights a little stronger today, and one that dumped
  fights a little weaker. The cap is ±15%, and the modifier never touches
  elixir, so its effect is smaller than levels. The market reshuffles the meta
  without making wins something you can buy.
- The contract only accepts reports from the configured forwarder, requires
  strictly increasing epochs, and rejects any |bps| > 1500. No single server
  can post the meta. A DON has to agree on it, or, on mainnet, the Chainlink
  feeds fix it (`postFromFeeds` computes the numbers on chain).

## The math (`market-meta/meta.ts`, unit tested)

| | |
|---|---|
| Modifier | `bps = clamp(round(change% × 40), −1500, +1500)`. This is the same mapping as `MarketMeta.momentumBps` (`move × 2/5` in bps) |
| Anchor | a +20% day → **+800 bps** (8% stronger); −20% → −800 |
| Cap | ±1500 bps (±15%), reached at a ±37.5% day. Matches `MarketMeta.MAX_BPS` |
| Rounding | nearest integer, halves **away from zero**, so +x% and −x% are exact opposites (`Math.round` would send −2.5 → −2 but +2.5 → +3). Never emits −0 |
| No data | 0 bps (neutral). A coin is never guessed |
| Epoch | `floor(unixSeconds / epochSeconds)` from DON consensus time (`runtime.now()`). Staging uses 600 s, the same windows as `MarketMeta.EPOCH_SECONDS`, so a re-run 10 minutes later gives a new, higher epoch. `config.production.json` uses hourly epochs (3600) with an hourly cron |
| Report | `abi.encode(uint64 epoch, uint16[] coinIds, int16[] bps)`. The tests round-trip it through viem `decodeAbiParameters` with exactly `(uint64,uint16[],int16[])` and pin the golden bytes Solidity's `abi.encode` produces |
| Layout | all 20 coins, ascending `coinId`. A flat coin is written as an explicit 0, so `0` never means "not reported" |

### Data sources

- **Crypto, DeFi and PAXG (13 fighters, every roster coin with a
  `coingeckoId`).** CoinGecko
  `https://api.coingecko.com/api/v3/simple/price?ids=…&vs_currencies=usd&include_24hr_change=true`
  (keyless), one batched request per node. The modifier comes from
  `usd_24h_change`. A coin CoinGecko doesn't return is written as 0 and counted
  in the logs.
- **Fiat (7 fighters: `kind: "rwa"`, `coingeckoId: null`, pair `XXX / USD`).**
  [Frankfurter](https://frankfurter.dev) (keyless, European Central Bank
  reference rates), two batched requests per node:
  - `https://api.frankfurter.dev/v1/latest?from=USD&to=AUD,BRL,CAD,EUR,JPY,KRW,MXN`
  - `https://api.frankfurter.dev/v1/<yesterday, UTC>?from=USD&to=…`. The date
    comes from DON consensus time, so every node asks the same question. For a
    weekend or holiday, Frankfurter answers with the last business day's fixing.

  Both return
  `{ "amount": 1.0, "base": "USD", "date": "YYYY-MM-DD", "rates": { "EUR": 0.89469, … } }`
  (verified against the live API; the tests use recorded responses). Those
  rates are **USD → XXX**, but the fighters track the Chainlink **XXX / USD**
  feeds, which are the reciprocal. So the fighter's move is
  `past / latest − 1`: a stronger dollar is a weaker EUR fighter. For example,
  on 2026-10-07 USD→EUR went 0.88739 → 0.89469, which is −0.816% for EUR and
  gives **−33 bps**.

  When both requests return the same fixing (`latest.date` ≤ the previous
  day's `date`), every fiat fighter gets 0 bps and the log says so. That
  happens on weekends, on ECB holidays, and each day before that day's ECB
  fixing is published (~16:00 CET). If Frankfurter fails (HTTP error or an
  unexpected body), the fiat fighters get **0 bps for that epoch**, the log
  says `FX unavailable (…)`, and the rest of the report still goes out.

  The old `api.frankfurter.app` host now 301-redirects to
  `api.frankfurter.dev/v1`, so the config uses the `.dev/v1` root directly
  rather than relying on redirects.
- If **CoinGecko** fails across the DON, the workflow throws and writes
  **nothing**. A report of all zeros would wipe the meta. With no report,
  matches keep using the previous epoch.

### Consensus: why a median per coin

Each node fetches the sources itself and turns every change into an integer
bps. The DON then takes a **median of each coin's field independently**
(`ConsensusAggregationByFields` with `median` for every `c<coinId>` key, plus
the `missing` / `sameFixing` counters). Identical-result consensus on the whole
bps array was rejected because CoinGecko and FX answers can differ slightly
between nodes (edge caches, a fixing published between two requests). One coin
off by 1 bps would sink quorum for the entire report. A per-coin median
tolerates up to f faulty or lagging nodes and still lands on an honest value.
The curve is monotonic, so the median of the bps equals the bps of the median
change. Medians run in float64, so `normalizeBps` re-rounds and re-clamps the
consensus output. That keeps the result deterministic even if an even node
count averages two neighbours.

### On-chain write

- Before writing, the workflow reads `MarketMeta.currentEpoch()` (latest
  block). If the chain is already at this epoch (for example, the cron fired
  twice in one window), it logs and skips the write instead of paying for a
  `StaleEpoch` revert.
- `gasLimit: 1500000`. This was measured when the roster had 36 coins: a
  direct `onReport` call with every coin non-zero used ~941k gas (cold
  SSTOREs plus `MetaPosted` / `MetaSource` events and calldata). With 20 coins
  the call needs well under that, and the rest of the limit covers the
  forwarder's signature checks. Gas on Arc is paid in USDC by the forwarder's
  transmitter.
- The workflow fails loudly when `txStatus != SUCCESS`, and also when the
  forwarder tx succeeded but `onReport` itself reverted
  (`receiverContractExecutionStatus == REVERTED`). The usual causes are a
  wrong forwarder or a stale epoch.
- If `marketMetaAddress` is the zero address (the shipped state until
  MarketMeta is deployed on Arc testnet), the workflow computes, logs and
  returns the encoded report and **does not write**.

## Layout

```
cre/
├── project.yaml              RPCs per target (arc-testnet → https://rpc.testnet.arc.io) + forwarder notes
├── secrets.yaml              empty: the workflow reads no secrets (both sources are keyless)
├── .env.example              CRE_ETH_PRIVATE_KEY (copy to .env, gitignored)
├── scripts/gen-roster.ts     shared/roster.json → market-meta/roster.ts (validates kinds, CoinGecko ids, fiat pairs)
└── market-meta/
    ├── workflow.yaml         staging-settings (10-min) / production-settings (hourly); secrets-path ""
    ├── config.staging.json   arc-testnet, 10-min epochs  ← marketMetaAddress TODO
    ├── config.production.json  arc-testnet, hourly epochs  ← marketMetaAddress TODO
    ├── main.ts               triggers, HTTP fetch + consensus, report, write
    ├── meta.ts               pure math / parsing (CoinGecko, Frankfurter) / encoding
    ├── roster.ts             GENERATED — do not edit
    ├── fixtures.ts           recorded Frankfurter responses + CoinGecko body builder (tests only)
    ├── meta.test.ts          curve, epoch, CoinGecko + FX parsers, ABI round-trip + golden bytes
    ├── main.test.ts          whole handler against the SDK's HTTP/EVM mocks (weekday, weekend, FX down, …), config checks
    └── roster.test.ts        fails if roster.ts drifts from shared/roster.json
```

The roster is compiled in because a WASM workflow can't read files. Each row
carries `coinId`, `ticker`, `kind` (`crypto` | `defi` | `rwa`), the Chainlink
`pair`, `coingeckoId` (null only for fiat) and `feedId`. `feedId` is
`keccak256(pair)` and the workflow treats it as an opaque bytes32. After any
change to `shared/roster.json`:

```bash
cd cre/market-meta && bun run gen:roster
```

## Develop

```bash
cd cre/market-meta
bun install            # then `bunx cre-setup` once if the postinstall didn't run it
bun run gen:roster     # regenerate roster.ts (20 coins)
bun run typecheck      # workflow (WASM-restricted types) + tests
bun test               # 43 tests, no network
bunx cre-compile main.ts dist/market-meta.wasm   # offline WASM build, no login needed
```

## Before the first simulation: TODO

1. **Set the MarketMeta address.** After `contracts/script/Deploy.s.sol` runs on
   Arc testnet, copy `marketMeta` from `shared/deployments/5042002.json` into
   `market-meta/config.staging.json` → `marketMetaAddress`. For
   `simulate --broadcast`, that deployment's forwarder must be Arc testnet's
   simulation forwarder **`0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`**. Deploy
   with `CRE_FORWARDER=0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`, or call
   `MarketMeta.setForwarder(0x6E9E…eDc1)` as owner. Leave
   `expectedWorkflowOwner` unset while simulating.
2. **Log in.** `cre workflow simulate` (and `cre init`) refuse to run without
   a CRE session:
   ```bash
   cre login            # opens a browser; finish sign-in there
   cre whoami
   ```
   Or set `CRE_API_KEY` for non-interactive use.
3. **Env.** `cp .env.example .env` in `cre/`, then set `CRE_ETH_PRIVATE_KEY`
   to a funded Arc-testnet key (the deployer works). Gas on Arc is USDC, so
   fund it from the Circle faucet (Arc Testnet). It's only needed for
   `--broadcast`; without it the CLI uses a built-in dummy key. No data-source
   keys are needed.

## Simulate (run from `cre/`)

A dry run sends no transaction. It fetches real prices and FX rates, runs
consensus, and logs the modifier table and the encoded report (or the
`currentEpoch` check, if the address is set):

```bash
cre workflow simulate market-meta --target staging-settings --non-interactive --trigger-index 0
```

To write for real through the simulation forwarder on Arc testnet, once
`marketMetaAddress` is set:

```bash
cre workflow simulate market-meta --target staging-settings --non-interactive --trigger-index 0 --broadcast
```

Then check it on chain:

```bash
cast call <MarketMeta> "currentEpoch()(uint64)" --rpc-url https://rpc.testnet.arc.io
cast call <MarketMeta> "modifierBps(uint64,uint16)(int16)" <epoch> 0 --rpc-url https://rpc.testnet.arc.io    # BTC
cast call <MarketMeta> "modifierBps(uint64,uint16)(int16)" <epoch> 13 --rpc-url https://rpc.testnet.arc.io   # EUR
cast call <MarketMeta> "epochSource(uint64)(uint8)" <epoch> --rpc-url https://rpc.testnet.arc.io   # 0 = CRE
```

Run it again at least 10 minutes later and you get a new epoch. Within the
same 10-minute window, the workflow logs `skipping write` instead of reverting.

Optional on-demand trigger: set `httpTrigger.enabled: true` and set
`authorizedKeys` to the EVM addresses allowed to fire it. It becomes handler
index 1:

```bash
cre workflow simulate market-meta --target staging-settings --non-interactive --trigger-index 1 --http-payload '{}'
```

Explorer: `https://explorer.testnet.arc.io/tx/<hash>`.

## Deploy (when CRE deploy access is granted; Arc testnet only)

1. Redeploy MarketMeta, or call `setForwarder`, with Arc testnet's
   **production KeystoneForwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62`**.
   Then call `setExpectedWorkflowOwner(<your workflow owner address>)` so only
   this workflow's reports are accepted. Put the MarketMeta address in
   `config.production.json` → `marketMetaAddress`.
2. `cre account link-key --target production-settings` (links the owner key)
3. `cre workflow deploy market-meta --target production-settings` (no
   `cre secrets create` step: the workflow has no secrets)
4. `cre workflow activate market-meta --target production-settings`
5. Monitor with `cre workflow get market-meta --target production-settings`

Production runs hourly (`0 0 * * * *`, `epochSeconds: 3600`). Daily epochs
need only `epochSeconds: 86400` and a daily cron. `onReport` only requires
epochs to increase, not any particular length.

If the `postFromFeeds` keeper also runs against the same testnet MarketMeta,
whichever writer lands first takes the window. The workflow checks
`currentEpoch()` first and skips a write that would be a `StaleEpoch`.
`postFromFeeds` always uses ten-minute epochs (`MarketMeta.EPOCH_SECONDS`),
whose numbers are larger than hourly epoch numbers, so mixing it with the
hourly production config makes every CRE report stale. Run the staging
(10-minute) epochs alongside a keeper, or turn the keeper off.

## Arc mainnet

There's nothing to deploy from this folder for mainnet. Deploy MarketMeta with
`CRE_FORWARDER` unset (zero) and wire `MempireCards` (which holds each
fighter's feed address and `maxPriceAge`). The relay's keeper then calls
`postFromFeeds(coinIds, dayAgoRounds)` each window, and the contract computes
every modifier from the Chainlink Data Feeds itself. Every mainnet epoch
carries `MetaSource(epoch, 1, poster)`, which the indexer records as
`ChainlinkFeeds`.
