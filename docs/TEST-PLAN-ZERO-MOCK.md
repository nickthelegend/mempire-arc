# Zero-mock test plan

Every screen, endpoint, contract call, integration and edge case of the
running product, each against a **real** dependency.

**Rules**
- **PASS** only when the real dependency answered.
- **UNTESTED** names exactly what is missing.
- **AWAITING TESTNET GO** for anything that needs Monad testnet or hosting, which are on hold.
- Test doubles (the fake Moonshot server, `MockPyth`/`MockAUSD` in forge tests) count as unit-test evidence only, never as PASS here.

**Stack under test.** `./scripts/local-up.sh`:
- anvil forking Monad testnet on :8612 (chain 31337);
- our contracts deployed with signed transactions;
- Agora's real AUSD and faucet (from the fork);
- `LocalPriceOracle` fed by live OKX/CoinGecko quotes;
- mongod :27019;
- relay :8799;
- app http://localhost:5181;
- Envio indexer on :8090 (own Postgres :5435).

**How.**
- API and chain items: `curl` against the relay, and `cast` against the fork.
- Browser items: Claude in Chrome in our own tabs, with the console and network checked after each.
- Two players need two origins (`localhost:5181` and `127.0.0.1:5181`), since a guest key lives in the origin's storage.

Last run: 7 Oct 2026.

**Browser used.**
- C1–C8, C10, C12 and C14 ran in the user's Chrome through the Claude in Chrome extension (6 Oct).
- The extension then became unreachable: its host hook timed out on every call. So C9, C11, C13 and C15–C18, plus the passkey items D1 and D2, ran in **real Google Chrome via Playwright** (`channel: "chrome"`, headless), with a CDP WebAuthn virtual authenticator that supports **PRF**, so Mera's real derivation path executes.
- The script is `app/e2e/browser-pass.mjs`. Every item records console errors and warnings, page errors and failed requests, and fails on any of them.
- The one tolerated line is a third-party deprecation warning: `@react-three/fiber` 9.8.1 (latest stable) still constructs `THREE.Clock`, which three r185 deprecates.
- Results and screenshots: `docs/evidence/browser/` (`results.json` plus PNGs).

## Summary

| | Items | PASS | FAIL | UNTESTED | AWAITING TESTNET GO |
|---|---|---|---|---|---|
| A. Relay and data | 11 | 11 | 0 | 0 | 0 |
| B. Contracts on the fork | 6 | 6 | 0 | 0 | 0 |
| C. Browser | 18 | 18 | 0 | 0 | 0 |
| D. Keys and devices | 6 | 2 | 0 | 4 | 0 |
| E. Testnet | 3 | 0 | 0 | 0 | 3 |
| **Total** | **44** | **37** | **0** | **4** | **3** |

The browser pass found 18 defects, all fixed and re-verified above:

- **11 in the product:**
  - a staked win was never credited (the relay didn't say `pending`);
  - the onboarding drip couldn't cover a first stake;
  - the session float was too small, so plays went unlogged;
  - AUSD pots counted up in MON;
  - Empire summed and printed every currency as MON;
  - a false "chest slots full";
  - the starter card claimed queued AUSD had landed;
  - mint was offered with no live price;
  - sub-cent prices read "$0";
  - the shop showed a feed symbol as a price;
  - "testnet" copy appeared on the local fork.
- **7 in the local stack:**
  - the fork mined only on transactions;
  - anvil panicked on a Prague EIP-2935 remote read;
  - PID files named a wrapper shell, not node;
  - the indexer's start block went stale;
  - one database spanned redeploys;
  - 26 dead Solana scripts sat in `app/`;
  - `local-down` would kill a reused PID after a reboot.

## A. Relay and data (API, against the live stack)

| # | Item | Expected | Result | Evidence |
|---|---|---|---|---|
| A1 | `GET /api/health` | `persistent: true`, db `mempire_local_<startBlock>`, chain 31337, `pyth: local`, keeper on | **PASS** | `{"persistent":true,"db":"mempire_local","chain":{"chainId":31337,"pyth":"local",...}}` |
| A2 | `GET /api/coins`: live market data | Every row carries `source` okx/coingecko and `at` ≤ 100 s old; no invented rows | **PASS** | 20 rows, all `okx`, oldest 21 s. Coins without a live quote are absent, not zero. |
| A3 | `GET /api/pyth/update?coinIds=0,26` | `mode: local`; BTC signed from a live quote; NVDA (no live quote) reported in `missing`, not signed | **PASS** | `{"mode":"local","n":1,"missing":["NVDA"],"src":["okx"]}` |
| A4 | Meta keeper | Posts `postFromPyth` once per window with live prices; `epochSource` = 1 (Pyth) | **PASS** | Epochs 2985391 → 2985393 posted by the relay; `epochSource(2985393) = 1`; log: *posted meta epoch … for 20 fighters* |
| A5 | Persistence across a relay restart | A saved player is readable from a fresh relay process and is a real Mongo document | **PASS** | `test-persistence.mjs` 5/5; also the dev relay was restarted by PID and kept its data |
| A6 | `/api/privy/config` with no keys | `mode: off`, names the four missing keys | **PASS** | `{"mode":"off","missing":["PRIVY_APP_ID","PRIVY_APP_SECRET","PRIVY_AUTHORIZATION_KEY","PRIVY_SIGNER_ID"]}` |
| A7 | `/api/ai/status`, `/api/ai/plan` with no key | `off`, names `MOONSHOT_API_KEY`; plan → 503 | **PASS** | status `{"mode":"off","missing":["MOONSHOT_API_KEY"]}`; plan 503 |
| A8 | `/nft/:id` | A real card → ERC-721 JSON; a missing one → 404 | **PASS** | `test-onboard` §6 (7 checks); `/nft/999999` → 404 |
| A9 | `/api/leaderboard` | Only chain-verified settled matches; empty when none were reported | **PASS** | `[]` on the fresh stack (the seed's matches were not reported to the relay; nothing is invented) |
| A10 | Onboarding: starter deck, real AUSD faucet, MON drip, once per address, replay and forgery refused, concurrent nonces | as listed | **PASS** | `test-onboard` 36/36 on a throwaway fork |
| A11 | Settlement → leaderboard money columns equal what the arena paid | as listed | **PASS** | `test-settlement` 12/12 |

## B. Contracts on the fork (real signed transactions)

| # | Item | Expected | Result | Evidence |
|---|---|---|---|---|
| B1 | Mint with a signed live price in the same tx | The card records the posted price | **PASS** | `test-e2e` §2: BTC on a live OKX quote |
| B2 | `postFromPyth` momentum | Modifier = clamp((spot−EMA)/EMA × 2), computed on chain | **PASS** | `test-e2e` §3 (`-4 vs -4`) |
| B3 | $1 AUSD match with Agora's real permit | Escrow, 10 plays logged, 90/10 to the winner, 50 $MEMPIRE, chest | **PASS** | `test-e2e` §4 |
| B4 | Chest unlock → open → reveal; merge | Drops are ERC-721s; merge sets level 2 | **PASS** | `test-e2e` §5 |
| B5 | Timeout refund | Both stakes back, cards unlocked | **PASS** | `test-e2e` §6 |
| B6 | Indexer rows equal the chain | Every entity is checked against events | **PASS** | `verify-local` 52/52 after `seed-local` on the fork |

## C. Browser (Claude in Chrome, then Playwright Chrome)

| # | Screen / flow | Steps | Expected | Result |
|---|---|---|---|---|
| C1 | First load, 1440 px | Open `/` | Arena renders; console has no errors; no failed requests; chain badge reads local | **PASS** after a fix: console clean, all requests 200/304. The footer said "MONAD TESTNET" on the local fork; it now names the network (`NETWORK_LABEL`: "Local Monad fork"). |
| C2 | Desktop gutters | 1440 px | MarketBoard shows the latest epoch and live ▲▼ that match `MarketMeta` | **PASS**: the board's AVAX +1.9% and MON −8.4% equal `modifierBps` 195 and −843 for epoch 2985429 |
| C3 | Copy | Page text on every screen | No mock/Solana/devnet/SOL-as-currency/lamport/◎ | **PASS** after fixes: "testnet" copy on the local fork corrected in 4 places; 26 dead Solana scripts removed from `app/` |
| C4 | Wallet picker | Open the account chip | Passkey + Guest (+ injected); **no email/Privy row** | **PASS**: Passkey, "I already have a passkey", Guest, and Rainbow (the browser's own extension, not touched). No Privy row. |
| C5 | Guest sign-up → onboarding | **Play as Guest** | The starter kit lands; 8 cards = `cardsOf`; AUSD/MON | **PASS** after a fix: *Your deck is on chain · 4.1s*; on chain 8 cards, 10,000 AUSD from Agora's faucet, and the drip. **Found:** a 0.05 MON drip could not cover a staked match ("Not enough MON for gas"); the drip is now 0.25. A faucet-cooldown AUSD is now shown as "on its way", and the app refreshes when the relay's retry pays (seen: queued → paid in ~65 s, UI updated without a reload). |
| C6 | Cards screen | Open Cards and the bag list | Only on-chain cards; prices match `/api/coins`; a coin with no live quote says so | **PASS** after fixes: sub-cent prices read "$0" (now `$0.00000372`); the shop showed a feed symbol as a price (now "no live price") |
| C7 | Mint | Mint AVAX | Tx confirms; the card records the signed price | **PASS**: card #61 AVAX `mintPrice` $11.19 vs the live OKX $11.195 |
| C8 | Mint, no live price | Stocks (no quote over the weekend) | Refused, no tx | **PASS** after a fix: the button was enabled; now "No live price", disabled, for all 11 stocks |
| C9 | Deck | Build 8 from owned cards; reload | Persists | **PASS** (Playwright Chrome): a guest's 8-card deck is identical after a reload. A passkey session is memory-only by design, so after a reload a passkey player signs in again with one prompt ("Sign in as <name>"). |
| C10 | Practice vs bot | Arena | "vs Classic bot"; "Kimi · not configured"; no commentary; no stake/chest | **PASS** (Arena shows both labels; Kimi is disabled) |
| C11 | Staked PvP, two origins | Both guests: $1 AUSD Ranked | Matched; one stake tx each; plays logged; settles; winner paid; chest | **PASS** (Playwright Chrome), passkey player vs guest: match #6 settled `winner 0`, **25 + 17 plays all logged** (badge "LOGGED · 25", none unlogged), result rows in dollars ($2 / −$0.20 / +$1.80, then "PAID"), "Chest granted on chain". Earlier Claude in Chrome runs found and fixed the MON-labelled result, the false "slots full" and the unlogged plays. |
| C12 | Chest | Cards → chest | start → open → reveal; ⛓ seed; drops appear | **PASS** after a stack fix: Silver Chest → +1 $PEPE minted, "⛓ block-hash seed 0xc9ec…". **Found:** the fork mined only on transactions, so the chest timer never passed on chain; the fork now mines every second. |
| C13 | Empire | Open Empire | Real leaderboard / empty state; money in the right currency | **PASS** (Playwright Chrome): the leaderboard row for the winner reads `netAusd 0.8`, credited from the chain after the client's `pending` retry. Empire history reads "pot $2". (The fixes: the relay now answers `pending`; Empire formats per currency; each deployment gets its own DB.) |
| C14 | Live on Monad | Panel | Envio rows match the chain | **PASS**: 5 players, plays and match #3 seat by seat; +$0.80 / −$1.00 per player, the same as the chain |
| C15 | Clan | Create a clan (signed) | Persists across reload | **PASS** (Playwright Chrome): founded "Judges 9608" after paying the 250 $MEMPIRE charter on chain (a real token transfer; the test funded the player from the deployer). The clan shows after a reload, and `/api/clans/mine` returns it. |
| C16 | 375 px | Every screen at 375×812 | No horizontal scroll; nothing clipped | **PASS**: 375×812 on Arena, Cards, Deck, Clan and Empire: 0 px horizontal overflow on each; screenshots `375-*.png` |
| C17 | Accessibility basics | read_page | Named buttons; alt text; focus | **PASS**: on every screen, 0 visible controls without an accessible name, 0 images without alt text, 0 buttons under 32 px |
| C18 | Relay down | Stop the relay (by PID), reload | Honest offline state; recovers | **PASS**: relay stopped by PID → the page renders without a page error and shows no NaN/undefined or invented data; `local-up.sh --relay-only` brings it back, and health answers ok |

## D. Keys and devices (UNTESTED rows name the exact missing dependency)

| # | Item | Missing dependency |
|---|---|---|
| D1 | Mera passkey sign-up, prompt-free sessions, the stateless test | **PASS** (Playwright Chrome, virtual authenticator with PRF): sign-up → address `0x19C0…12c6`, 8 cards on chain, a 30-minute session chip; storage wiped → the same passkey → **the same address**. Still for the live demo: a real platform authenticator (Face ID / Touch ID). |
| D2 | Passkey locker | **PASS** (Playwright Chrome): saved → storage wiped → signed in with the same passkey → "Restored 3 deck(s)". A real two-device demo needs a synced passkey. |
| D3 | Privy email sign-in, sponsored tx, session signer | `VITE_PRIVY_APP_ID` + `PRIVY_APP_ID`/`SECRET`/`AUTHORIZATION_KEY`/`SIGNER_ID` |
| D4 | Kimi opponent and caster | `MOONSHOT_API_KEY` |
| D5 | Chainlink CRE `simulate --broadcast` | `cre login` (and testnet for `--broadcast`) |
| D6 | Pyth Hermes (the real Pyth contract) | `PYTH_API_KEY`, and Monad testnet |

## E. Awaiting testnet go

| # | Item |
|---|---|
| E1 | Deploy plus Sourcify verification on Monad testnet |
| E2 | Relay on Railway, app on Vercel, indexer on Envio Cloud |
| E3 | The live smoke test (docs/DEPLOY-LATER.md §10) and the demo video |
