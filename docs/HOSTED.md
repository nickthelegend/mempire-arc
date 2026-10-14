Current production: **Arc mainnet**. See [mainnet hosting and browser checks](HOSTED-MAINNET.md). The report below is historical testnet evidence.

# Mempire — Vercel / Live testnet

LEAD: RUN THESE
```sh
node scripts/e2e-browser-hosted.mjs
npm run typecheck
npm test
```

Frontend and HTTP API: https://mempire-arc.vercel.app. The Vite static export and existing Express request/response API deploy from the repo root using vercel.json. Contract data comes from deployments/arc-testnet.json and its shared/5042002.json copy.
Public cards, art, chain prices, market modifiers and settled-match receipts work without a game relay. The Empire proof panel reads the chain directly. Atlas rejects Vercel access (health persistent=false); clan/ladder persistence is unavailable. Chain reads remain independent of Atlas. No temporary storage is offered as durable player data.

The API reuses existing Atlas credentials with MONGODB_DB=arc_mempire_testnet. No database service was provisioned. VERCEL skips listening sockets and all continuous keepers. No relayer key, AI key or automatic starter funding is configured in this hosted pass.
PvP requires the local relay: one Node process (~512 MiB RAM) with WebSockets, shared in-memory rooms/input ordering and Atlas. HTTP polling cannot preserve the existing real-time lockstep protocol or matchmaking state across isolated invocations. Start it only for the recording; see docs/HOSTING.md for the exact local command. No always-on resource was created. Keeper and mirror work can be called on demand; no scheduled broadcasts were enabled.

Env: VITE_CHAIN_ID=5042002, CHAIN_ID=5042002, VITE_RPC_URL, RPC_URL, MONGODB_URI (secret), MONGODB_DB=arc_mempire_testnet, CORS_ORIGIN, PUBLIC_APP_URL, PUBLIC_API_URL, META_KEEPER=0, MIRROR_KEEPER=0, ONBOARD_USDC_DRIP=0. VITE_API_URL and VITE_RELAY_URL remain unset: same-origin HTTP, explicit no-relay state. All values are uploaded via stdin without logging credentials.
Deploy: vercel link --project mempire-arc; vercel deploy --prod --yes. .vercelignore excludes credentials, contract artifacts and local data.
Screenshots and browser assertions replace deleted-host evidence in docs/screens/hosted/. No transaction was sent during this hosting pass. Earlier real two-player testnet settlement used a local relay; it is not a Vercel PvP claim.

Build, API dependency tracing, and 15 unit tests pass. The Vercel tracer initially evaluated an uninitialized CCIP cursor as null plus BigInt; leaving the cursor uninitialized until its first tick fixes tracing without changing runtime behavior.

Production verification: all five navigation tabs return HTTP 200 with zero console errors or broken images; 390 px mobile fits. Opening the account picker works without a backend write. Health and roster HTTP APIs pass, and arena bytecode is verified on chain 5042002. Full account onboarding, hosted PvP and persistent clans/ladder remain unavailable/not run.
