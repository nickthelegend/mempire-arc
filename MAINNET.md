# Mempire on Arc mainnet — runbook

Mainnet holds real money. Nothing in this repo has been broadcast to Arc mainnet; the steps below are what the
lead runs once the testnet phase is signed off. Every command refuses mainnet without `CONFIRM_MAINNET=yes`.

## 0. What mainnet looks like

| | Arc mainnet (5042) |
|---|---|
| Prices | Chainlink Data Feeds on Arc — the roster's proxies (`shared/roster.json`), read on chain |
| Daily meta | `MarketMeta.postFromFeeds` by the relay's keeper (no CRE on Arc mainnet; `CRE_FORWARDER` is 0) |
| Stakes | USDC, tiers $1 and $5 only (`MAX_TIER=1`), session float ≤ 0.25 USDC, mint fee $0.05 (cap $5) |
| Cross-chain | CCIP router `0xB79791184973589c38e114D43Eb8E4588C283A18`, CCTP V2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, cash-out cap 100 USDC/message |
| Gateway | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` / minter `0x2222222d7164433c4C09B0b0D809a9b52C04C205`; relayed top-ups capped at `GATEWAY_MAX_TOPUP` |
| Ownership | Deployer deploys, then offers ownership of Cards, MarketMeta, Arena and the CCIP gateway to `ADMIN` (a Safe) via `Ownable2Step` — the Safe must `acceptOwnership()` on each |

Owner powers (documented, minimal): treasury address, rake ≤ 20% / tie rake ≤ 20% / power band / timeout ≥ 4 min,
`setLimits(maxTier, paused)` — pause stops **new** matches only, mint fee ≤ $5, register/deactivate fighters,
repoint a fighter's Chainlink proxy (feed migration), relayer address, CCIP remote-entry allowlist and cash-out cap.
No owner path can move an escrowed stake or a player's card.

## 1. Keys and funding

| Account | Holds | Fund with |
|---|---|---|
| Deployer (`../.deployer/deployer.env`) | deploys only | **1 USDC** — measured dry run against live Arc mainnet: 18,675,166 gas ≈ 0.37 USDC at 20 gwei (forge budgets 0.76 at its 40 gwei estimate) |
| Relayer (`RELAYER_PRIVATE_KEY`, never the deployer/owner) | gas for starter decks, keeper, Gateway mints, CCIP retries | **5 USDC** to start — a starter deck ≈ 0.02 USDC; a meta post ≈ 1M gas ≈ 0.02 USDC (hourly ≈ 0.5 USDC/day); a Gateway mint ≈ 0.005 USDC |
| Agent owner (`AGENT_OWNER_PRIVATE_KEY`) | one ERC-8004 `register` | 0.05 USDC |
| Deployer on Base / Ethereum | `MempireRemoteEntry` deploy | ~0.002 ETH on Base; Ethereum optional |

## 2. Deploy

```bash
# Arc Foundry (forge/cast with --network arc). Simulate first, against live mainnet, broadcasting nothing:
DRY_RUN=1 ADMIN=<safe> TREASURY=<safe> RELAYER=<relayer addr> PUBLIC_API_URL=https://<relay host> \
  ARC_FORGE=…/forge ARC_CAST=…/cast sh scripts/deploy.sh mainnet

# Then for real (holds the shared deployer lock; writes deployments/arc-mainnet.json with gas + tx hashes,
# syncs addresses to app/server/indexer, verifies on explorer.arc.io):
CONFIRM_MAINNET=yes VERIFY=1 ADMIN=<safe> TREASURY=<safe> RELAYER=<relayer addr> \
  PUBLIC_API_URL=https://<relay host> sh scripts/deploy.sh mainnet

# The Safe accepts ownership of MempireCards, MarketMeta, MempireArena and MempireCCIPGateway.

# Cross-chain entry from Base (and optionally Ethereum):
CONFIRM_MAINNET=yes sh scripts/deploy-remote.sh base
#   → then the Safe calls MempireCCIPGateway.setRemoteEntry(15971525489660198786, <entry>, 6)
#     (Ethereum: selector 5009297550715157269, domain 0), and set VITE_REMOTE_ENTRY_BASE in Vercel.

# The AI opponent's ERC-8004 identity:
CONFIRM_MAINNET=yes PUBLIC_API_URL=https://<relay host> node scripts/register-agent.mjs mainnet   # → AI_AGENT_ID
```

Commit `deployments/arc-mainnet.json`, `shared/deployments/5042.json`, `server/shared/`, `app/src/shared/`
and the indexer's `config.mainnet.yaml` after the deploy.

## 3. Host

### Relay (separate always-on server; do not provision without a hosting decision)

One instance (the matchmaker is in-process). `server/Dockerfile`, root directory `server/`. Frontend and ordinary HTTP routes belong on Vercel; see [the hosting boundary](docs/HOSTING.md). No paid relay is authorized by this runbook.

| Variable | Value |
|---|---|
| `CHAIN_ID` | `5042` |
| `RPC_URL` | `https://rpc.mainnet.arc.io` (or a provider RPC) |
| `RELAYER_PRIVATE_KEY` | the relayer key (secret) |
| `MONGODB_URI`, `MONGODB_DB` | Atlas URI (secret), `arc_mempire_mainnet` |
| `CORS_ORIGIN` | the Vercel app origin |
| `PUBLIC_APP_URL` / `PUBLIC_API_URL` | app origin / this relay's origin |
| `ONBOARD_MAINNET_MIN_USDC` | `1` |
| `META_KEEPER` / `META_KEEPER_EVERY` | unset (on by default on mainnet) / `6` (hourly) |
| `GATEWAY_MAX_TOPUP` | `100` |
| `AI_AGENT_ID` | from `register-agent.mjs` |
| `MOONSHOT_API_KEY` | optional (Kimi AI opponent) |

Background jobs that must run (all inside this one process): the meta keeper, `ccip-watch` (completes CCIP
instructions whose USDC arrived after them). The testnet feed mirror is off on mainnet.

### App (Vercel)

Root directory repository root, build `npm run build` via `vercel.json` (preflight refuses a build without a deployment for its chain).

| Variable | Value |
|---|---|
| `VITE_CHAIN_ID` | `5042` |
| `VITE_API_URL` | unset for same-origin HTTP functions; use `VITE_RELAY_URL` only for a separate game relay |
| `VITE_RPC_URL` | optional provider RPC |
| `VITE_INDEXER_URL` | Envio endpoint (optional) |
| `VITE_REMOTE_ENTRY_BASE` / `VITE_REMOTE_ENTRY_ETHEREUM` | from `deploy-remote.sh` |

### Indexer (Envio hosted)

`cd indexer && pnpm sync:mainnet && pnpm codegen:mainnet`, deploy `config.mainnet.yaml` (HyperSync network `arc`).

## 4. Smoke test (small, real money)

1. Two passkey accounts each hold $3 USDC on Arc (any wallet/exchange, or Circle Gateway "Top up Arc").
2. Each signs in → starter deck lands (needs $1 held) → Arena → $1 Pauper → Ranked; play; the winner's balance
   rises by $0.80 net in the block of the second claim. Check the `Memo` event tagged with the match id.
3. Cards → mint one fighter ($0.05) → the card shows Chainlink's price at mint.
4. Within the hour `MarketMeta.currentEpoch()` advances (`/api/health` → keeper).
5. From Base: Empire → "Enter from Base" with $1 → the match appears on Arc (track on ccip.chain.link).

## 5. USDC needed

| | Testnet | Mainnet |
|---|---|---|
| Deploy | 31,910,920 gas incl. 20 feed mirrors ≈ 0.8 USDC at 25 gwei → fund **2 USDC** | 18,675,166 gas ≈ 0.37 USDC → fund **1 USDC** |
| Relayer | **10 USDC**: 2 USDC drip per new player, feed-mirror backfill + upkeep (~0.3–0.5 USDC/day), keeper | **5 USDC** |
| Agent owner | 0.1 | 0.05 |
| Demo (2 players, 1 match, 1 mint, 1 Gateway top-up) | from the drip | **≈ 4 USDC** (2 × $1 stake + floats + mint + $1 top-up) + ~0.001 ETH on Base for one cross-chain entry |
| **Total** | **≈ 12 USDC** | **≈ 10 USDC** (+ ~0.003 ETH on Base) |
