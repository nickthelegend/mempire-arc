# Mainnet transaction dry-sign

```sh
npm run dryrun:mainnet
node scripts/e2e-browser-dryrun-mainnet.mjs
```

Run from this repository in the shared `arc/` workspace, after installing its dependencies. Requires Node 22.15+ (synchronous module hooks), TypeScript, and Circle Arc Foundry at `../.tools/arcfoundry/anvil`. Contract artifacts used by the script must be built with the repository's normal contract build command. The scripts import the app/SDK ABI or the same generated contract ABI. Mainnet deployments are read from the checked-in deployment record.

The runner reads `https://rpc.mainnet.arc.io` and pins the latest block. It probes both `eth_call` and `eth_estimateGas` with a native-USDC balance override. Dependent transaction sequences run on one locally owned Arc fork at `127.0.0.1:9508`, chain 5042, guarded by a shared workspace lock. It refuses an occupied port. Only signer balances are overridden; contracts, access control, oracle prices and DEX liquidity are not replaced. Successes are applied on localhost to create the state for the next transaction. No public-network transaction is sent.

Fresh keys stay in memory. Where the deployed application requires a role, the runner reads only its named key from `../.deployer/mainnet/` and verifies the expected public address. Private keys, notes and signed raw transactions are never logged or saved. Each transaction is signed, decoded and checked for destination, chain ID, nonce, calldata, value and recovered sender. Its exact signed fields are then checked with both call and estimation. An expected revert passes only when both methods decode the required custom error. The process stops its own fork by PID in `finally`.

Evidence is written to `docs/dryrun-mainnet.json`. Gas is the estimate, and USDC fee is `gas × pinned mainnet baseFeePerGas / 1e18`, excluding priority tips and principal. Reverted estimates have no gas quote. Signed hashes in the evidence are local-only and are not explorer links. A nonzero exit or FAIL verdict means the requested sequence did not complete.

Scope: deployed-contract user transactions and genuine signatures; no hosted relayer, browser wallet, third-party AI provider or cross-chain delivery assertion. New launches and registrations created during the sequence exist only on the fork. Kakushi generates a genuine Noir UltraHonk withdrawal proof with one proving thread. Mempire drives the real game engine locally and exercises one play plus agreeing settlement claims, not a two-browser match.

The browser command opens only the first route of each configured hosted surface, using the installed Chrome and repository Playwright (or the shared Thenar Playwright installation). It writes `docs/dryrun-browser-mainnet.json`, closes its own browser, and does not alter video screenshots. This is a page-load smoke check, not a browser transaction test.
