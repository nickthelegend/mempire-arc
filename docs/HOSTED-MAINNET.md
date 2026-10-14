# Arc mainnet on Vercel

LEAD: RUN THESE
```sh
node scripts/e2e-browser-hosted-mainnet.mjs
```

Live: https://mempire-arc.vercel.app (Arc mainnet, chain 5042).
Production reads `deployments/arc-mainnet.json` with RPC `https://rpc.mainnet.arc.io` and explorer `https://explorer.arc.io`.
Network configuration, contract bytecode, routes, rendered wording and explorer links are checked by the script. Detailed outcomes are in `docs/screens/mainnet/*/results.json`; failures remain failures.

PvP needs the on-demand local WebSocket relay. Hosted HTTP reads do not demonstrate a completed multiplayer match.

Service credentials were supplied to Vercel via stdin from the ignored `.deployer/mainnet/` files. Read-only broker/executor/studio frontends do not receive signing keys. Mainnet databases have separate names from historical data. No new database, Railway or paid resource was provisioned.

The previous production artifacts were retained at `https://mempire-arc-testnet.vercel.app` (Vercel aliases, no extra build). These are frozen historical builds, not a freshly verified preview environment; shared backend URLs may now resolve to mainnet. Do not use them for transaction rehearsals without checking the displayed chain.

This migration performs reads only: no wallet connection, signature, deposit, payment, withdrawal or chain broadcast. Mainnet contract/deployment transaction evidence is recorded separately in the repository. Local executors remain an on-demand demo requirement, not an always-on hosting service provisioned here.


Verified: 5 routes returned HTTP 200 with no rendered testnet wording, wrong Arc explorer link or uncaught page exception. Network APIs and RPC reported chain 5042; expected mainnet contract bytecode was present. Screenshots and machine-readable results are saved beside this report.

## Final hosted polish — 2026-10-15

Atlas now reports persistent:true. `node scripts/check-hosted-persistence.mjs` signs an empty profile for an ephemeral unfunded identity, writes it via the hosted API, and reads it twice. No match, money or leaderboard result is fabricated. Both video players already appear on the hosted leaderboard; no backfill was needed.

Re-run: `node scripts/e2e-browser-hosted-mainnet.mjs`.

No mainnet broadcasts or paid API calls. Live mainnet reads and DB writes only; fork transactions and complete wallet sign-ins: Not run.
