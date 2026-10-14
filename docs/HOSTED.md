# Hosted Arc testnet

Live: https://app-production-ddd3.up.railway.app (Arc testnet)

Railway project `mempire-arc-testnet`: `app` (Vite/nginx), `relay` (Express + WebSocket matchmaking + keepers), `MongoDB` (persistent database).
Relay: https://relay-production-9f6c.up.railway.app — `/api/health` reports chain 5042002 and persistent storage. Frontend CORS is explicitly allowed. Addresses come from the versioned Arc testnet deployment in shared/deployments/5042002.json, matching deployments/arc-testnet.json.

Deploy from the repo root with `railway up --service relay`, then `railway up --service app`. Dockerfiles are in `docker/`; build upload ignores exclude env files, keys, local test wallets, dependencies and generated output. The relay key is a Railway secret; Mongo uses a Railway service reference. The frontend receives only its public API URL and chain ID.

## Evidence

- Public route and health responses: `docs/screens/hosted/*-http.json`.
- Browser route screenshots and console check: `docs/screens/hosted/`.
- Real testnet action: BTC fighter mint for 0.05 USDC, gas-inclusive ceiling 0.06229908 USDC. Transaction: https://explorer.testnet.arc.io/tx/0xc630f17a58f452dca41cc8df19f1987a5a2ca0af057c77ec1911997c0d1dac80 . Script: `server/hosted-smoke.mjs` (source the deployer environment inside a command and hold the shared deployer lock).
- The stale preflight requirement for the removed oracle was replaced with the deployed CCIP gateway check. CCIP log scans use 100-block chunks, at most ten per tick, to respect the public RPC limits.

## Limits

Prices are relayer-maintained testnet mirrors of Chainlink mainnet reads, clearly labeled in the app. The mirror may temporarily report public RPC throttling while catching up. The bot is the scripted classic bot; no Kimi key or live ERC-8004 agent registration is configured. Cross-chain travel is not a hosted end-to-end claim. Match staking requires a wallet and testnet USDC; the hosted smoke uses the cheaper mint path rather than a 1-USDC staked match. Prior full match evidence remains in docs/E2E-TESTNET.md.

Verified 2026-10-14: all six route documents and health returned 200; all five hash navigation views rendered without console errors, and `/battle` safely returned to Arena without an active match. Live market meta was visible. WebSocket upgrade and exact-origin CORS passed. Railway app and relay deployments both reached SUCCESS.
