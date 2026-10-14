> Hosting policy: frontend and ordinary HTTP routes belong on Vercel. No paid relay is provisioned; see [HOSTING.md](../docs/HOSTING.md). Mongo database: `mempire_arc`.

# Mempire relay (Arc)

Player state, the trophy ladder, clans, the PvP matchmaker, and the thin chain
layer the game needs a server for on Arc: onboarding new wallets, serving
Chainlink prices and card metadata, posting the Chainlink-derived market meta,
relaying Circle Gateway mints, finishing CCIP instructions whose USDC arrived
late, reading the AI opponent's ERC-8004 record, and verifying arena payouts
before they reach the leaderboard.

It stores results; the client owns game logic and money moves on chain, never
here. The only key this process signs with is the **relayer's**, which can mint
a once-per-address starter deck, pay a testnet drip, post the meta (whose
numbers the contract computes), submit Gateway mints Circle attested, retry
stored CCIP messages (permissionless) and, on testnet, copy Chainlink rounds
into the feed mirrors. A compromised client cannot do anything through this API
it could not already do locally.

## Run it

```bash
npm install
npm run sync-shared        # vendor ../shared (roster, ABIs, deployments) into ./shared
npm run dev                # reads .env; see .env.example
```

No `MONGODB_URI` is fine locally: the relay boots on an in-memory store and says
so in `/api/health`. Set it for any deployment. The relay is deployed from this
directory alone (`Dockerfile`, one instance — the
matchmaker is in-process state), so `npm run sync-shared` vendors `roster.json`,
`abi/` and `deployments/` into `server/shared/`; rerun and commit after a deploy.

## Configuration

Every variable is documented in [`.env.example`](.env.example); the hosted set is
in [../MAINNET.md](../docs/HOSTING.md). The important ones:

| Variable | Default | Notes |
|---|---|---|
| `CHAIN_ID` | `5042002` | `5042` Arc mainnet, `5042002` Arc testnet, `31337` the local Arc fork. Picks `shared/deployments/<CHAIN_ID>.json`. |
| `RPC_URL` | Arc's public RPC for the chain | |
| `RELAYER_PRIVATE_KEY` | unset | Must be `MempireCards.relayer()`. **Never the deployer/owner** — boot refuses a key that owns a game contract. Fund with USDC (gas). |
| `ONBOARD_USDC_DRIP` | `2` | Test chains only, whatever this says. |
| `ONBOARD_MAINNET_MIN_USDC` | `1` | Mainnet: the free starter deck needs this much USDC held (sybil brake on relayer gas). |
| `META_KEEPER` / `META_KEEPER_EVERY` | on for mainnet/forks / `6` | `MarketMeta.postFromFeeds` cadence. |
| `AI_AGENT_ID` | unset | ERC-8004 id of the AI opponent (`scripts/register-agent.mjs`). |
| `GATEWAY_MAX_TOPUP` | `100` | Mainnet cap per relayed Gateway mint, USDC. |
| `MOONSHOT_API_KEY` | unset | Kimi strategist for the AI opponent. |
| `MONGODB_URI`, `CORS_ORIGIN`, `PUBLIC_APP_URL`, `PUBLIC_API_URL`, `PORT` | | |

## Auth

Every write is signed. The client signs, with EIP-191 `personal_sign`, exactly:

```
Mempire
action: <action>
wallet: <address>
ts: <unix ms>
```

and sends `{ address, ts, signature }` in the body. The server rebuilds the
text from the address as sent, recovers the signer, and refuses anything more
than five minutes off, any signature already used (TTL'd replay store), and any
non-canonical signature (uppercase hex, high-s twins — one signature, one
spelling, or the replay store could be walked past). Handlers act as
`req.wallet`, never as an address read from the body.

**Addresses are stored lowercase everywhere** — Mongo ids, clan rosters,
pairing seats, onboarding claims. A checksummed and a lowercase address are one
account, one row, one claim. Anything that is not `0x` plus 40 hex characters is
a 400.

## Endpoints

**Health** — `GET /api/health`: store, chain id, relayer, `prices` (`chainlink` or testnet `mirror`), CCIP gateway, and the keeper / mirror / ccip-watch status.

**Onboarding** — `POST /api/onboard` (signed `onboard`): mints the eight-fighter starter deck once per address and, on test chains, drips 2 USDC (natively — one balance pays gas and funds the stake). On mainnet the deck needs `ONBOARD_MAINNET_MIN_USDC` held and there is no drip. `GET /api/onboard/:address` → `{ starterClaimed, usdc: { balance, units, wei }, claim }`.

**Prices** — `GET /api/coins`: every fighter at its Chainlink Data Feed answer on Arc (`source: 'chainlink'`, `fresh`, `roundId`, `updatedAt`), with a display-only 24h change (OKX tickers; FX from the feed's own day-ago round).

**Market meta** — the keeper calls `MarketMeta.postFromFeeds(coinIds, dayAgoRounds)`; the contract computes the moves.

**Circle Gateway** — `GET /api/gateway/config`, `GET /api/gateway/balances/:address` (the unified USDC balance per chain, from Circle), `POST /api/gateway/mint` (`{ requests: [{ burnIntent, signature }] }` → Circle `/transfer` → simulate → `GatewayMinter.gatewayMint` on Arc). Refuses intents that mint to anyone but the depositor or anywhere but Arc.

**ERC-8004** — `GET /agents/mempire-ai.json` (the agent card), `GET /api/agent` (identity owner, URI, raters, score for tag `mempire.match`).

**Card metadata** — `GET /nft/:id`: ERC-721 metadata read from chain, incl. the Chainlink price the card was minted at.

**Player state, ladder, clans, analytics** — unchanged game APIs: `/api/player/*`, `POST /api/match/:address` (chain-verified USDC credit), `GET /api/leaderboard` (net USDC), `/api/ladder/*`, `/api/clans/*`, `/api/events`, `/api/analytics/*`.

**WebSocket** — `/ws`: matchmaking (pools by tier, currency USDC, format, ranked), lockstep input relay, desync referee, and the escrow handshake relay (`chain` messages, never acted on).

## Background jobs

| Job | File | What it does |
|---|---|---|
| Meta keeper | `keeper.js` | Finds each feed's day-ago round and posts `postFromFeeds`. |
| Feed mirror (testnet) | `mirror.js` | Copies Arc mainnet Chainlink rounds into the testnet `MirrorAggregator`s. |
| CCIP watch | `ccip-watch.js` | Reads `MessageFailed` from the gateway and retries once CCTP has minted (simulated first). |

## Tests

| Command | Covers |
|---|---|
| `node test-auth.mjs`, `test-memstore.mjs`, `test-locker.mjs`, `test-ai.mjs` | Units (no chain). |
| `node test-interop.mjs` | Real Circle Gateway testnet API + real Arc testnet ERC-8004 registries. |
| `node test-onboard.mjs` | Arc-mainnet fork (arc-anvil): starter deck, 2 USDC drip in both USDC views, Arc fee floor, concurrency, metadata. |
| `node test-settlement.mjs` | Arc-mainnet fork: a \$1 USDC match staked by permit, exact USDC deltas, chain-verified leaderboard credit. |
| `node test-e2e.mjs` | Arc-mainnet fork: Chainlink-priced mint, on-chain meta from feed history, a cross-chain ENTER delivered via the real Arc CCIP router address and completed by ccip-watch, a session-key match, chest, merge, timeout refund. |
| `node test-api.mjs`, `test-pvp.mjs`, `test-clans.mjs`, `test-ladder.mjs` | Against a running relay (`API=…`, `WS=…`). |

The fork suites need Circle's Arc Foundry: `ARC_ANVIL=…/arc-anvil ARC_FORGE=…/forge`. `spar-escrow.mjs` (`SPAR_PRIVATE_KEY`, `SPAR_DELAY_MS`) is a sparring partner that joins a browser's staked match for real.

## What the container does that the bare process does not

- **Runs as non-root.** `node`, uid 1000, from the base image.
- **Ships production dependencies only**, from the lockfile (`npm ci --omit=dev`),
  plus `shared/`. `.dockerignore` keeps `.env` out of the build context entirely.
- **Has a real healthcheck** on `/api/health`.
- **Handles SIGTERM.** `CMD ["node", "index.js"]` rather than `npm start`.

## Rate limiting

Token bucket per IP on mutating routes (80, refill 5/s), per wallet once a
signature is proven (60, 2/s), a read bucket for routes that spend RPC or Hermes
quota (60, 2/s), and an onboarding bucket (10 signed attempts, then one a
minute). Shared through Mongo when configured; in process memory otherwise,
which is correct for the single process memory mode can be.

## Kimi opponent and commentary (`ai.js`)

In bot matches (Practice, and any match that falls back to the AI) the player
can pick **vs Kimi** on the Arena screen. Kimi (Moonshot's OpenAI-compatible
API) then plays the AI seat: every ~3.5 s of game time the client sends the
board from the bot's seat, Kimi answers by calling a tool, the relay validates
the call, and the client plays it through the same `InputEvent` path a card
drop takes. While a plan is late (> 3 s) or the relay is unreachable the
classic heuristic bot covers the seat, so a match never waits on a model. The
key stays on the relay; the browser only ever talks to these routes.

No key means **mock mode** — a
deterministic heuristic strategist (defend the pressured lane, spell a stack,
push a lane whose tower is down, bank to 7 and push the weaker tower with
today's buffed fighter) and template caster lines. Every response carries
`mode: 'kimi' | 'mock'`, and the HUD shows "Kimi (mock)" whenever the mock
answered.

| Variable | Default | Notes |
|---|---|---|
| `MOONSHOT_API_KEY` | unset | Moonshot platform key (platform.moonshot.ai). Unset = mock mode. |
| `KIMI_MODEL` | `kimi-k2.6` | e.g. `kimi-k3`. |
| `AI_MODE` | auto | `mock` forces mock even with a key; `kimi` uses Kimi when a key is set (and warns + mocks when not). Unset = Kimi iff a key is set. |
| `MOONSHOT_BASE_URL` | `https://api.moonshot.ai/v1` | Any OpenAI-compatible endpoint; the tests point it at a local fake. |
| `KIMI_THINKING` | `disabled` | Sent as `thinking: { type }`. `enabled` for deeper (slower) plans, `omit` to leave the field out. A 400 that names it drops the field for the life of the process. |
| `KIMI_TOOL_CHOICE` | `auto` | Thinking-capable Kimi models accept `auto`/`none`; a text answer is nudged into a tool call instead. |
| `AI_TIMEOUT_MS` | `9000` | One plan (all model rounds) or one line. Past it the mock answers, labelled `fallback: 'timeout'`. |
| `AI_MAX_INFLIGHT` | `8` | Concurrent upstream calls; beyond it the mock answers (`fallback: 'busy'`). |
| `AI_PLAN_BURST` / `AI_LINE_BURST` | `8` / `4` | Per-IP buckets on top of the shared limiter (refill 1 per 2 s / 1 per 5 s). |

**Routes**
- `GET /api/ai/status` — `{ mode, model, provider }`. Never the key.
- `POST /api/ai/plan` — body `{ state: { tick, secondsLeft, doubleElixir, elixir: { you, them }, towers: { yours, theirs }, hand: [{ ticker, archetype, level, metaBps, cost }], enemyUnits, yourUnits, meta: { yours, theirs } } }`, where unit groups are `{ lane: left|right, zone: their_back|their_bridge|your_bridge|your_back, archetype, count, hpPct }` from the AI's seat. Kimi gets three tools — `deploy_card({ hand_index, lane, depth: back|mid|bridge, reason? })`, `wait({ reason })`, and the read-only `get_market_meta()` (both decks' MarketMeta modifiers, from the request) — over up to four rounds. A bad call (index out of range, unaffordable card, unknown lane, broken JSON) goes back to the model as a tool error naming the fix; `reasoning_content` is kept on replayed assistant turns. Responds `{ mode, action: { type: 'deploy', handIndex, lane, depth } | { type: 'wait' }, reason, latencyMs, model?, rounds?, fallback?: 'timeout'|'invalid'|'error'|'busy', cached? }`. Identical boards (tick aside) are cached for 12 s. `429` past the bucket.
- `POST /api/ai/commentary` — body `{ events: [{ kind: tower_down|spell|elixir_lead|buffed|nerfed|swarm|double_elixir|overtime|kickoff, side: you|ai, ticker?, lane?, amount?, bps? }], aiName? }` → `{ mode, line, latencyMs, fallback? }`. One line ≤ 90 characters; a line that reads as financial advice or swears is replaced by the template line (`fallback: 'invalid'`). The client asks at most once per 8 s.

`node test-ai.mjs` covers both modes: mock decisions and labels, input
validation and the per-IP limit; then, against a fake OpenAI-compatible server
it starts itself, the request shape (`tools`, `tool_choice`, bearer key,
`thinking`), a `get_market_meta` round trip with reasoning preserved,
correction of a bad call, fallback after four bad answers, a text answer
nudged into a tool call, the timeout and upstream-error fallbacks, the cache,
commentary trimming and filtering, and the `thinking` retry.
