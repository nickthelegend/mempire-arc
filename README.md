# Mempire on Arc

**A real-time 1v1 card battler where the market is the meta — every fighter is priced by Chainlink on Arc, every pot is USDC, and the contract pays the winner in the same sub-second block both results land.**

Every fighter is a real asset: majors (BTC, ETH, SOL…), DeFi tokens (LINK, UNI, AAVE), gold (PAXG) and fiat currencies (EUR, JPY, BRL…). Each one is priced by its **Chainlink Data Feed on Arc**, and yesterday-to-today's move buffs or nerfs it a little — computed on chain. Two players put up a dollar of **USDC**, play a three-minute lane battle, and the arena pays 90% of the pot to the winner. Sign in with a passkey: no seed phrase, no extension, no popups mid-match, and **one token** — USDC is the stake *and* the gas.

- Arc testnet: **not deployed yet** — the shared deployer holds 0 USDC (see [Deployments](#deployments)). Everything below runs end to end today on a local fork of **Arc mainnet** with one command.
- Submission: [SUBMISSION.md](SUBMISSION.md) · Mainnet runbook: [MAINNET.md](MAINNET.md)

---

## Arc stack

| Piece | What it does in Mempire | Contract / file | How it was verified |
|---|---|---|---|
| **USDC as gas + stake** | Players hold one token. Stakes, mint fees and the session key's gas float are USDC; the arena forwards the float as an ERC-20 USDC transfer, which *is* native gas on Arc. Fees floored above Arc's 20 gwei mempool minimum. | `MempireArena._fundSession`, `app/src/chain/account.ts` (`arcFees`), `server/chain.js` (`feeParams`) | Forge fork test: the ERC-20 float shows up as the session key's native balance; e2e: 5 plays cost 0.0043 USDC of gas |
| **Sub-second finality** | Every card drop is its own transaction from the match's session key, final before the unit crosses the bridge; settlement lands in the second claim's block. The badge shows measured send-to-receipt. | `MempireArena.play/claim`, `app/src/components/ArcLogBadge.tsx` | e2e on the fork: plays confirm in ~330–900 ms |
| **EIP-2612 permits on Arc's USDC** | Stake + float, and the mint fee, ride inside one transaction (domain `USDC` / `2`). | `MempireArena._collectStake`, `MempireCards.mint`, `app/src/chain/actions.ts` (`permitFor`) | Unit tests on Circle's FiatToken v2.2 bytecode at `0x3600…`; settlement suite on the fork |
| **Chainlink Data Feeds** | Every fighter's price. `mint` reads `latestRoundData` (answer > 0, complete round, fresh within heartbeat + grace) and stamps the card; `MarketMeta.postFromFeeds` computes the 24 h move from the feed's own round history (the caller only names the day-ago round, which the contract proves). | `MempireCards.priceOf`, `MarketMeta.postFromFeeds`, `server/feeds.js`, `server/keeper.js` | Fork test on Arc mainnet: all 20 feeds live and fresh; a mint stamps Chainlink's BTC/USD; the meta for all 20 recomputed from real history; wrong hints refused |
| **Chainlink CCIP + Circle CCTP V2** | Play from Base or Ethereum: one source transaction burns USDC with CCTP Fast Transfer to the player's own address on Arc and `ccipSend`s the instruction (open/join a match, or cash out). The Arc gateway is a defensive receiver; an instruction that beats its dollars is stored and the relay completes it when CCTP mints. | `ccip/MempireRemoteEntry.sol`, `ccip/MempireCCIPGateway.sol`, `server/ccip-watch.js`, `app/src/lib/ccip.ts`, `scripts/ccip-send.mjs` | Chainlink Local `CCIPLocalSimulator` (8 tests); fork: real Base→Arc lane quoted, real CCTP burn + `ccipSend` from Base, an ENTER delivered via the real Arc router address (184,755 gas) and completed by ccip-watch. Live testnet send is a user-run script |
| **Circle Gateway** | A unified USDC balance: deposit once on Ethereum, Arbitrum, Base or Arc; "Top up Arc" signs burn intents with the passkey and the relay mints on Arc in about a second (paying that gas). "Park $1" deposits idle Arc USDC. | `server/gateway.js`, `app/src/lib/gateway.ts`, `app/src/components/ArcStack.tsx` | Live Circle Gateway API: balances, and a passkey-format burn intent accepted up to the balance check; fork: deposit into the real GatewayWallet credited; forged attestation refused by the real minter |
| **Arc Memo** | Stakes and result claims go through Arc's Memo predeploy tagged `keccak256("mempire:match:<id>")`, so a stake or payout reconciles to its match on any explorer. | `app/src/chain/actions.ts` (`sendTagged`) | Fork test on Arc mainnet: create, join and the settling claim through Memo; the arena still sees the player; the payout lands inside the tagged frame |
| **ERC-8004** | The AI opponent ("vs Kimi") is a registered agent; players rate it after a match from their own accounts. | `server/agent.js`, `app/src/components/AgentRating.tsx`, `scripts/register-agent.mjs` | Fork: register + feedback + summary on the real registries; the owner can't self-rate; relay reads the real Arc testnet registries |
| **Passkeys (WebAuthn PRF)** | The account is derived from the passkey's PRF output; the same plain EOA on every chain, so Gateway intents, permits, Memo and cross-chain entry all just work. | `app/src/lib/passkey.ts` | Type-checked and built; the PRF ceremony itself was not run in this session's browser (guest accounts were used for the browser pass) |
| **Chainlink CRE** (testnet) | Alternative meta writer on Arc testnet (CRE doesn't serve Arc mainnet). | `cre/market-meta`, `MarketMeta.onReport` | Workflow tests + WASM build; `cre workflow simulate` needs `cre login` |
| **Envio HyperIndex** | Leaderboards, play feed, cross-chain message log on `arc-testnet` / `arc`. | `indexer/` | Codegen for all three configs, 21 handler tests |

Not used, deliberately: StableFX/EURC (stakes are dollars; nothing to convert), USYC (a pot is escrowed for minutes, not long enough for yield to matter).

---

## Architecture

```
          passkey (WebAuthn PRF) ──► EOA (same address on every chain)
                                          │
 ┌──────────── browser ─────────────┐     ▼                       ┌──── Base / Ethereum ────┐
 │ React + three.js arena           │  ┌──────────── Arc ───────┐ │ MempireRemoteEntry       │
 │ deterministic lockstep sim       │─►│ MempireArena  USDC pots │◄┼── CCIP (instruction)     │
 │ session key per match ───────────┼─►│   play log · 2-claim    │◄┼── CCTP V2 (the dollars)  │
 │ Gateway intents · Memo tags      │  │ MempireCards  ERC-721   │ └──────────────────────────┘
 └─────────┬────────────────────────┘  │   Chainlink feed @ mint │
           │ ws + https                 │ MarketMeta   24h move  │◄── Chainlink Data Feeds
 ┌─────────▼──────────┐                 │   from feed history    │
 │ relay (Railway)    │── relayer ─────►│ CCIP gateway (Arc)     │◄── Chainlink CCIP router
 │ matchmaker, onboard│                 │ Circle GatewayMinter   │◄── Circle Gateway API
 │ keeper, ccip-watch │                 │ Memo · ERC-8004        │
 │ Gateway relay      │                 └──────────▲─────────────┘
 └────────────────────┘                    Envio HyperIndex (leaderboard, feed, CCIP log)
```

- **Contracts** (`contracts/`): see [contracts/README.md](contracts/README.md). 71 unit tests + 7 mainnet-fork tests.
- **App** (`app/`): React 19 + three.js + viem. Deterministic fixed-point lockstep sim at 20 ticks/s with a state hash every 2 s.
- **Relay** (`server/`): Express + `ws`, MongoDB. See [server/README.md](server/README.md).
- **Indexer** (`indexer/`) and **CRE** (`cre/`).

### Money safety

- Four fixed tiers ($1/$5/$25/$100); mainnet opens only $1 and $5 (`maxTier = 1`). Session float capped at 0.25 USDC; mint fee capped at $5; Gateway top-ups capped per request; CCIP cash-outs capped per message.
- The owner can change the treasury, rake (≤ 20%), tiers and pause **new** matches. Joining, playing, claiming, timeouts, cancels and withdrawals can't be paused; no admin path can move an escrowed stake. A blocklisted recipient's payout is held for `withdraw()` instead of bricking settlement.
- Prices never move money: they stamp cards and set a ±15% stat modifier.

---

## Run it locally (Arc mainnet fork, nothing broadcast)

Needs Node 24+, `jq`, optionally `mongod`, and Circle's **Arc Foundry** (`arc-anvil`, `forge`, `cast` — plain anvil can't move Arc's native USDC).

```bash
(cd contracts && npm ci --ignore-scripts) && (cd app && npm install) && (cd server && npm install)
ARC_ANVIL=…/arc-anvil ARC_FORGE=…/forge ARC_CAST=…/cast ./scripts/local-up.sh   # → http://localhost:5191
./scripts/local-down.sh
```

`local-up.sh` forks **Arc mainnet** on :8710 (chain 31337) with `arc-anvil --network arc`, deploys the game with real signed transactions, and starts the relay (:8799, keeper posting the Chainlink meta, ccip-watch) and the app. Real USDC, Chainlink feeds, CCIP router, Memo, Gateway and ERC-8004 contracts are all on the fork.

**Tests**: `./scripts/test-all.sh` (add `FORK_TESTS=1` for the forge fork suites).

| Suite | Result |
|---|---|
| contracts, unit (FiatToken v2.2 at Arc's USDC, Chainlink Local) | 71/71 |
| contracts, Arc + Base mainnet forks | 7/7 |
| relay: onboarding / settlement / end-to-end (arc-anvil, Arc mainnet fork) | 37/37 · 20/20 · 28/28 |
| relay: Circle Gateway API + ERC-8004 (live testnet services) | 8/8 |
| relay units (auth, memstore, locker, Kimi) | 14 · 13 · 10 · 46 |
| simulation determinism, app typecheck, app build | pass |
| indexer handlers / CRE workflow | 21/21 · 43/43 |

---

## Deployments

| Network | File | Status |
|---|---|---|
| Arc testnet (5042002) | [`deployments/arc-testnet.json`](deployments/arc-testnet.json) | **Blocked**: deployer `0x0648aDF1967692A0c991d7715b0b588452321FBd` has 0 USDC. Dry run passes against the live chain (31.9M gas incl. 20 feed mirrors ≈ 0.8 USDC at 25 gwei). `sh scripts/deploy.sh testnet` |
| Arc mainnet (5042) | [`deployments/arc-mainnet.json`](deployments/arc-mainnet.json) | Not deployed (phase gate). Dry run against live mainnet passes (18.7M gas ≈ 0.37 USDC at 20 gwei). See [MAINNET.md](MAINNET.md) |

External (Arc mainnet / testnet): USDC `0x3600000000000000000000000000000000000000` · CCIP router `0xB79791184973589c38e114D43Eb8E4588C283A18` / `0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8` · CCTP TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` / `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` · GatewayWallet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` / `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` · Memo `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` · ERC-8004 Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` / `0x8004A818BFB912233c491871b3d84c89A494BD9e`. Chainlink feed proxies per fighter: [`shared/roster.json`](shared/roster.json).

## Deploy to mainnet

```bash
CONFIRM_MAINNET=yes ADMIN=<safe> TREASURY=<safe> RELAYER=<relay addr> PUBLIC_API_URL=https://<relay> \
  VERIFY=1 sh scripts/deploy.sh mainnet
```

Full runbook, funding and hosting env: [MAINNET.md](MAINNET.md).

## Attribution

Ported from Mempire on Monad (same team); the game client, art, audio, simulation, matchmaker and clans predate this port. Everything chain-facing was rewritten for Arc in this port: USDC stakes and permits, Chainlink Data Feeds pricing and on-chain meta, CCIP + CCTP cross-chain entry, Circle Gateway, Memo tags, ERC-8004, WebAuthn-PRF passkeys, the Arc fork stack and tests. External code: OpenZeppelin, forge-std, Chainlink contracts / CCIP / Chainlink Local, viem, @scure, three.js / R3F; KayKit models (CC0). Written with Claude Code (Anthropic) under the author's direction. MIT — see [LICENSE](LICENSE).
