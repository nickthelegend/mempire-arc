# Hosting Mempire on Arc

**Frontend: Vercel. No Railway or paid infrastructure is provisioned by this pass.**
The old Railway URL is legacy deployment information, not proof that the current build is hosted.

## What works without a game relay

The public roster, card art, chain prices, balances, inventory, market modifiers and settled-match receipts read Arc directly.
The public Empire proof panel does not require sign-in, Mongo or WebSockets. Net USDC standings are reconstructed from
`MatchSettled` events and both seats in `getMatch`; draws split after tie rake, voids refund. Failed RPC reads show an
unavailable state instead of claiming there are no matches. The client incrementally scans from the deployment block;
a production indexer will be needed as historical volume grows.

`api/index.mjs` exports the existing Express HTTP app for Vercel functions. `VERCEL=1` skips the listening socket and
all continuous keepers. Configure the Vercel project from the **repo root** using `vercel.json` (install app/server,
build app, serve app/dist). The API needs `MONGODB_URI` (secret), `MONGODB_DB=mempire_arc`, `CHAIN_ID=5042002` and
`RPC_URL=https://rpc.testnet.arc.io`. Set `CORS_ORIGIN` to the frontend origin. Never use a `VITE_` prefix for secrets.
Leave `VITE_API_URL` unset so hosted HTTP calls use the same origin. `VITE_RELAY_URL` is independently optional.

Mongo stores players/history, clans/membership, ladder/pairings and immutable chain event materializations
(`match_history`, `chain_leaderboard`). The Atlas connection reused from the source project is kept only in ignored
`server/.env.local`; its database is separate from Monad. A Mongo startup outage disables persistent writes and clan/ladder
reads instead of accepting temporary records. Chain receipts and money standings still work. **There are no clan or trophy
events on chain**, so those records cannot be reconstructed from Arc; unavailable service is reported honestly.

## The one always-on component (not provisioned)

PvP needs one Node.js process accepting long-lived WebSocket connections at `/ws`, behind HTTPS/WSS termination.
A minimal initial deployment is one instance, roughly 1 vCPU / 512 MB RAM (an estimate, not a load-test result), with
outbound access to Arc RPC and MongoDB. Use `server/Dockerfile` or Node 22+, `npm ci --prefix server`, then
`PORT=8780 node --env-file=server/.env.local server/index.js`. Set frontend `VITE_RELAY_URL=https://<relay-origin>`.

Rooms, input ordering, RTT, hash comparisons and shared countdown live in process memory. Vercel now supports WebSocket servers in [public beta](https://vercel.com/changelog/websocket-support-is-now-in-public-beta) (June 22, 2026), with function duration and billing limits. The HTTP-only entrypoint in this repo has not been adapted or verified for that beta. This implementation still requires both seats to reach the same in-memory room; exporting a socket handler alone does not provide shared matchmaking or restart recovery. Do not run multiple instances without a
shared room/session design; a relay restart drops live matches. On-chain timeout recovery remains available, but is
not reconnect support. A future dedicated socket provider is an engineering choice for the lead, not something this
pass signs up for.

For a local video, run the relay only for the recording. Disable automatic spending with `META_KEEPER=0 MIRROR_KEEPER=0`
and keep onboarding funding explicit (`ONBOARD_USDC_DRIP=0`); stale mirrors then remain a visible testnet limitation.
Do not copy the deployer key to a hosted service. A separately funded relayer is needed for free starter decks and
mirror maintenance. Those transactions spend USDC even though hosting itself is serverless.

## Verification boundary

Local production frontend build and the HTTP handler are checked separately. A successful local build is **not a Vercel
production deployment**. The escrow-ready handshake and complete browser match #3 are proven on live testnet with a local relay; payout and
leaderboard verification passed in a continuation after the harness hit a log-indexing race. This is not a hosted
production acceptance. See E2E-TESTNET.md.
