# Mempire: sponsor gap report

Updated 6 Oct 2026. Everything below runs on an **anvil fork of Monad testnet**: our contracts deployed with real signed transactions, Agora's real AUSD and faucet, live prices, a real MongoDB. Per the hold, there are no testnet transactions and no hosting yet. **There are no mocks in the running product.** Where a sponsor key is missing, the feature is hidden or answers 503 naming the key; it is never faked. Test doubles exist only inside test suites.

Run it all: `./scripts/local-up.sh && ./scripts/test-all.sh`

Bounty scoring is 40% stated requirement, 30% technical, 20% Monad integration and 10% innovation, so each row starts with the requirement.

| Bounty | Track | Status | Live step left |
|---|---|---|---|
| Privy (beyond login) | All | **Met in code**; policy unit-tested; honest "not configured" without keys | Privy app + keys, then a live run |
| Mera: Best UX | All | **Met** (real; no keys needed) | Live demo on a PRF-capable device |
| Mera: Many Keys | All | **Met** (real) | Cross-device demo |
| Chainlink CRE | All | **Built + compiled**, 33 tests | `cre login`, then `simulate --broadcast` |
| Envio | All | **Met locally** (see below) | Envio Cloud deploy after Monad deploy |
| Kimi | All | **Met in code**; tested against a fake Moonshot server (a test double); "not configured" without a key | `MOONSHOT_API_KEY`, then a live run |
| Pyth (not a cash bounty; integration quality) | n/a | **Met.** Locally a signed `LocalPriceOracle` fed with live quotes; the keeper posts live momentum | Hermes key, then real Pyth on Monad |
| Agora AUSD (stake currency; neither Agora bounty fits) | T1 / T2 | The real AUSD contract and faucet, on the fork | n/a |
| Community Team | All | Depends on registration | Pick the community in the portal profile |

---

## Privy: "integrate Privy beyond authentication … bonus for multiple Privy features"

**Built.** Three Privy features, each load-bearing:

1. **An embedded wallet from email sign-in.** Code: `app/src/lib/privy.ts`, and `app/src/components/PrivyGate.tsx`, which lazy-loads `@privy-io/react-auth` only when `VITE_PRIVY_APP_ID` is set.
2. **Native gas sponsorship.** The player's own transactions (approve, stake, mint) go through `useSendTransaction(..., { sponsor: true })`, so a new account plays with zero MON.
3. **A session signer bound by a policy.** The player calls `useSigners().addSigners({ address, signers: [{ signerId, policyIds }] })` on the relay's authorization key. `server/privy.js` creates the policy, `mempire-match-actions`, which is default-deny and allows only:
   - methods `MempireArena.play`, `checkpoint` and `claim`;
   - `to` = the arena;
   - `value` = 0;
   - `chain_id` = this chain.

   During a match the relay sends those calls as the player through `wallets().ethereum().sendTransaction(walletId, { sponsor: true, authorization_context })`. The result is no popups, and no path for the server to touch a stake, a card or a token. The relay also evaluates the same policy before asking Privy.

**Tested.** `server/test-privy.mjs`, 21 checks:
- the policy document: three ALLOW rules, each pinned to the arena, value 0 and this chain, with the calldata decoded by each method's ABI;
- the local policy check: play, checkpoint and claim pass; `cancelMatch`, `withdraw`, a token transfer, any value, another chain, garbage calldata, and a missing or expired consent are all refused;
- with no keys, every route answers 503 and `/api/privy/config` names the four missing keys. There is no mock login route.

**Not yet run live:** the sponsored sends and `addSigners` need a Privy app. The earlier labelled custody mock has been **deleted**: a wallet whose key sits on our relay is not a Privy wallet.

**Keys needed.**
- App: `VITE_PRIVY_APP_ID`.
- Relay: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY` (base64 PKCS8 P-256), `PRIVY_SIGNER_ID` (key quorum id), and optionally `PRIVY_POLICY_ID`. Without it, the policy is created at boot.

**Dashboard steps.**
- Enable Monad Testnet under fee sponsorship and add credits. TEE execution is required.
- Register the authorization key as a 1-of-1 key quorum.

**Account-layer note.** Mera remains the default sign-in. Privy is the email option, and the two never mix inside one account.

## Mera: Best UX ("Mera is the entire account layer … time-to-first-transaction, session design, stateless test")

**Built** (`app/src/lib/passkey.ts`, `app/src/state/wallet.ts`):
- **One passkey ceremony:** PRF → BIP-39 → `m/44'/60'/0'/0/0` → a Mera signing session.
- **Nothing secret stored:** only a credential-id hint is kept.
- **Prompt-free signing:** every in-app signature, including relay auth and the starter-deck onboarding signature.
- **Session design:**
  - 30 minutes idle / 2 hours hard expiry, with a countdown on the account chip;
  - a locked state that reopens with one prompt;
  - "Lock session (zero the key)" on demand;
  - stakes from the Duke tier up re-derive the account from the passkey (step-up) instead of trusting the open session.
- **Stateless test:** clear storage, then "I already have a Mempire passkey" brings back the same address.
- **Time to first transaction:** sign-up, then the starter deck lands on chain about 1–3 s later with no further taps.

**Live step.** A demo on a device with a PRF-capable passkey store (iCloud Keychain, Google Password Manager, 1Password). Desktop Chrome local profiles report `PRF_UNAVAILABLE`, and the app says so and offers guest play. I did not trigger the OS passkey prompt unattended.

## Mera: One Passkey, Many Keys ("at least one PRF namespace doing non-account work")

**Built** (`app/src/lib/locker.ts`, `components/PasskeyLocker.tsx`, `server/locker.js`):
- PRF namespace `mempire.locker.v1` goes into HKDF and yields a **non-extractable AES-256-GCM key** plus a **256-bit storage id**.
- That id is unlinkable to the wallet, because it comes from a different PRF output.
- Saved decks (by fighter ticker) and scouting notes are encrypted in the browser, with the AES-GCM tag bound to the id.
- The relay stores only ciphertext under that id, with no auth by design, since a signature would name the wallet.
- The same passkey on another device opens the locker.

**Tested.** `server/test-locker.mjs` has 10 checks on the store shapes. Client crypto is exercised in-app.

**Live step.** A cross-device demo with the same passkey (laptop, then phone).

## Chainlink CRE ("a CRE workflow as an orchestration layer; CLI simulation accepted")

**Built.** `cre/market-meta`:
- cron trigger;
- HTTP with DON consensus (a median per coin) over CoinGecko, plus Pyth Hermes for stocks when a key is set;
- `bps = clamp(change% × 40, ±1500)`;
- `writeReport` to `MarketMeta.onReport` (`IReceiver`, forwarder-gated, stale epochs rejected).

This is load-bearing: matches snapshot the epoch and the deterministic sim applies the modifiers. There are 33 tests, it compiles to WASM, and the byte-for-byte ABI check passes against Solidity.

**Blocked by login.** `cre` v1.36 is installed but not logged in.

**Live step.** `cre login`, then from `cre/`:

```
cre workflow simulate market-meta --target staging-settings --non-interactive --trigger-index 0 --broadcast
```

On the local chain, `MarketMeta` also accepts the Pyth momentum path (below). Both share one ten-minute epoch clock.

## Envio ("HyperIndex/HyperSync powering a core feature; non-trivial schema, derived entities; consumer UI; data flowing end to end")

**Built.** `indexer/` on HyperIndex V3:
- per-player records and net MON/AUSD;
- per-fighter win rates split by buffed and nerfed days;
- a play feed resolved to fighter and level;
- chests, market epochs (now including their source, CRE or Pyth), and daily aggregates.

The consumer is the app's **Live on Monad** panel (`app/src/components/LiveOnMonad.tsx`). Handler tests pass.

**Local run, data flowing end to end.**
- `indexer/config.local.yaml` points an RPC data source at anvil (chain 31337).
- `pnpm local:up` starts its own Postgres (:5435) and Hasura (:8090) containers, so it never touches another session's `envio-*` containers, and runs `envio dev`.
- `pnpm seed:local` plays real games on the chain: a settled AUSD match with plays and checkpoints, a disputed void, a chest open and a merge.
- `pnpm verify:local` checks every indexed row against the chain: **52/52**, on two separate seeded runs. It exits 1 on any mismatch.
- The app reads it with `VITE_INDEXER_URL=http://localhost:8090/v1/graphql`.
- Handler tests: 9 pass, including `MetaSource` recording whether an epoch came from CRE or Pyth.

**Live step.** After the Monad deploy, `pnpm sync`, then connect the repo in Envio Cloud (root `indexer`).

## Kimi ("genuinely powered by Kimi, not bolted on")

**Built** (`server/ai.js`, `app/src/lib/ai.ts`, `components/Commentary.tsx`). Kimi is the AI seat's strategist, using tool calls:
- `deploy_card({hand_index, lane, depth})`;
- `wait()`;
- `get_market_meta()`.

The relay validates each call, and the bot plays it through the same input path a human uses. A late or bad plan falls back to the heuristic bot. A caster line from Kimi rides the battle HUD.

**Tested.** `server/test-ai.mjs`, 46 checks against a local fake Moonshot server (a test double): request shape, tool-call parsing and retry, timeouts, caching, guardrails, and an honest 503 with no key. The mock strategist and mock commentary are **deleted**. Without a key the Arena offers "vs Classic bot" and shows "Kimi · not configured"; no caster line appears.

**Key needed.** `MOONSHOT_API_KEY` on the relay (`KIMI_MODEL`, default `kimi-k2.6`).

## Pyth ("price-driven stats, fresh update pushed in the same tx")

**Built** in two places:
- **`MempireCards.mint`:** posts a Hermes update in the mint tx. There is no mint without a fresh price, and the card records its mint price.
- **`MarketMeta.postFromPyth`:** permissionless. It posts an update and derives each fighter's modifier from spot vs Pyth's EMA (momentum × 2, clamped ±15%) in the same tx. The relay's keeper calls it each window.

**Tested.**
- Contracts: 61 total, including `LocalPriceOracle` (signature, signer, freshness, chain binding).
- `test-e2e.mjs` on a throwaway fork: a BTC card minted on a live OKX quote records that price; the momentum modifier matches the formula; a match snapshots the epoch.
- The dev relay's keeper posts live momentum for 20 fighters each window.

**Locally**, Hermes doesn't serve a local chain, so `LocalPriceOracle` (IPyth-compatible: `getPriceNoOlderThan`, `getEmaPriceNoOlderThan`) accepts only updates signed by the relay's oracle key. The relay builds them only from live quotes (OKX tickers first, then CoinGecko), at most 100 s old. A coin with no live quote (stocks over a weekend, say) is reported missing and can't be minted: **no live price, no card**. The relay refuses to use an oracle key on any non-dev chain.

**Key needed.** `PYTH_API_KEY` (Hermes has required one since 26 Aug 2026; free trial in Pyth Terminal).

## AUSD

The stake currency is AUSD, with an EIP-2612 permit inside the stake tx, so there's no approve step. Locally it is **Agora's real AUSD** (`0xa901…22dC`, "Agora Dollar") and its **real faucet** (`requestFunds`, which pays 10,000 with a global cooldown), present on the fork. The app reads the permit domain from `eip712Domain()`. Neither Agora bounty fits this product: one is a mobile trading app (T1), the other cross-border remittance (T2).

---

## The game on the local chain: completeness

Browser re-verification on the zero-mock build is tracked item by item in [TEST-PLAN-ZERO-MOCK.md](TEST-PLAN-ZERO-MOCK.md).

| Flow | Status | Evidence |
|---|---|---|
| Guest play, no wallet | ✅ | browser; `test-onboard.mjs` |
| Starter deck + AUSD + gas on first sign-in | ✅ | browser ("Your deck is on chain · 3.5s"); `test-e2e.mjs` |
| Mint with a fresh price (signed live quote locally) | ✅ | `test-e2e.mjs` |
| Chests: timer, skip, open (future block hash), drops | ✅ | browser; `test-e2e.mjs`; forge |
| Merge a duplicate | ✅ | `test-e2e.mjs`; forge |
| Staked match, MON or AUSD (permit), plays logged, 90/10 | ✅ | two-tab browser matches; `test-e2e.mjs` |
| Disagreement → void and refund | ✅ | forge; indexer seed |
| Timeout refund | ✅ | browser (match #4); `test-e2e.mjs` |
| Practice vs the classic bot | ✅ | browser |
| Practice vs Kimi | needs `MOONSHOT_API_KEY` | `test-ai.mjs` (test double) |
| Market meta in the sim (CRE or Pyth) | ✅ | sim harness; `test-e2e.mjs` |
| Passkey locker | ✅ | `test-locker.mjs`; in-app |

## Your to-do list (keys and accounts only)

1. **Privy:**
   - App: `VITE_PRIVY_APP_ID`.
   - Relay: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY`, `PRIVY_SIGNER_ID`.
   - Dashboard: TEE on, sponsorship for Monad Testnet, an authorization-key quorum.
2. **Kimi:** `MOONSHOT_API_KEY` (platform.moonshot.ai).
3. **Pyth:** `PYTH_API_KEY` (Pyth Terminal).
4. **Chainlink:** `cre login`.
5. **Envio:** an Envio Cloud account linked to GitHub (only when deploying).
6. **Metropolis portal:** registration, track choice, and the community field (for the Community Team bounty).
