# Mempire on Monad: PLAN

Living plan for Monad Metropolis. Statuses are updated in place.
Constraints (6 Oct):
- No Monad testnet transactions and no hosting until the user says go.
- No mocks or fake data in the running product.
- On-chain means real contracts and real signed transactions on a local anvil, either a fork of Monad testnet or a pure local chain.
- Secrets never go in git or on hosting.

## Goals

**Done** means three things:
1. A judge can run the whole game locally with one command and play every flow against real contracts, a real persisted database and real external data.
2. Every sponsor integration either works for real or shows an honest "not configured" state that names the exact key it needs.
3. The repo, README, SUBMISSION.md and docs/DEPLOY-LATER.md make going live after "go" an under-one-hour runbook.

**Winning** means:
- top of the chosen track (recommendation: Track 3, Social/Attention/Culture; see SUBMISSION.md);
- the All-track bounties whose stated requirements we meet: Privy, Mera ×2, Chainlink CRE, Envio, Kimi.

Judging weights:
- Main track: product, technical, Monad integration, track fit and innovation, 20% each.
- Bounties: requirement 40%, technical 30%, Monad 20%, innovation 10%.

## Phases (critical path ★)

1. ★ **Zero-mock product path.** Remove every mock and fixture mode and every fake or seeded datum from the running product; replace them with real sources or honest "not configured" states.
2. ★ **Real local stack.**
   - anvil fork of Monad testnet: real Agora AUSD and faucet contracts;
   - our contracts deployed with real signed transactions;
   - a real persisted MongoDB;
   - the relay, the app, and the Envio indexer.
3. ★ **Zero-mock browser verification.** `docs/TEST-PLAN-ZERO-MOCK.md` executed through Claude in Chrome, with console and network clean.
4. **Quality gate.**
   - all suites, typecheck and lint;
   - forge tests plus slither;
   - a secret scan;
   - 375px layouts, accessibility basics, failure states.
5. **Judge package.** README, SUBMISSION.md, docs/DEPLOY-LATER.md.
6. **Testnet go (BLOCKED: awaiting the user):** deploy, verify, host, run a live smoke test, record video.

## Tasks

| # | Task | Acceptance | Verify | Status |
|---|---|---|---|---|
| 1.1 | Pyth: replace the fixture/hash "mock mode" with a **signed local oracle** | A local `LocalPriceOracle` (IPyth) accepts only updates signed by the relay's oracle key. Prices come only from live quotes (OKX, then CoinGecko). With no quote: "no live price", never a number. Real Hermes path when `PYTH_API_KEY` is set. | forge tests; relay test; mint in browser | DONE: `LocalPriceOracle` + 6 forge tests; e2e mints BTC on a live OKX quote |
| 1.2 | Privy: remove mock custody | Without keys: no email option in the UI, `/api/privy/*` answers 503 "not configured", and the feature is shown as unavailable. With keys: real path, unchanged. Policy engine unit-tested. | relay tests; browser shows no Privy row | DONE: test-privy 21/21 (policy + honest 503s); mock routes gone |
| 1.3 | Kimi: remove the mock strategist and mock commentary | Without a key: the "vs Kimi" option is disabled with "needs MOONSHOT_API_KEY"; the opponent is the game's own classic bot, labelled as such; no commentary ticker. With a key: real Kimi. Tests use a fake Moonshot server (test double only). | test-ai; browser | DONE: test-ai 46/46; mock strategist/commentary removed |
| 1.4 | Remove seeded/local cards and local chests | No `seedCards`. No local chests that "drop" cards that don't exist on chain. Chests and cards come only from chain. Signed out: an honest empty state. | grep clean; browser | DONE: grep clean; collection, chests and rewards read from chain only |
| 1.5 | Replace the placeholder ad gutters | Desktop gutters show real data (today's market meta board), not "ADVERTISE HERE" | browser at 1440px | DONE: `MarketBoard` replaces `AdSlot` |
| 1.6 | Copy: no old-chain or mock wording on screen | grep for Solana/devnet/SOL/mock in user-visible strings returns nothing | grep; browser | DONE: no Solana/devnet/SOL/mock in UI strings or in comments describing behaviour |
| 2.1 | Fork-based local stack | `scripts/local-up.sh` forks Monad testnet (reads only) on :8612, deploys with real signed txs, uses the real AUSD and faucet, starts mongod :27019 and the relay :8799 | `local-up` output; health | DONE: fork :8612 (chain 31337); real AUSD + faucet; keeper posts live momentum |
| 2.2 | Real persisted DB | The relay runs on MongoDB (own mongod, own dbpath); data survives a relay restart | restart test | DONE: test-persistence 5/5 (restart on real MongoDB) |
| 2.3 | Indexer on the fork stack | Envio local config points at the fork; verify-local is green | `pnpm verify:local` | DONE: seed-local + verify-local 52/52 on the fork |
| 2.4 | Tests never touch the dev chain | Chain suites run on a throwaway fork (:8613, chain 31338) and tear it down | test-all | DONE: onboarding 36, settlement 12, Privy 21, e2e 25 |
| 3.1 | Write the zero-mock test plan | Every screen, endpoint, contract call, integration and edge case, with expected results | file exists | DONE: docs/TEST-PLAN-ZERO-MOCK.md |
| 3.2 | Execute the plan in Chrome | Every item PASS / FAIL / UNTESTED (with reason); console and network clean | the plan file | DONE: 44 items. 37 PASS, 0 FAIL, 4 UNTESTED (Privy, Kimi and CRE keys; Pyth Hermes), 3 awaiting testnet go. 18 defects found and fixed. |
| 4.1 | Quality gate | test-all green; slither triaged; secret scan clean; 375px pass | logs | DONE: test-all green; slither triaged (1 fix); secret scan clean; lint 0 errors; 375px 0 px overflow on every screen; a11y basics clean |
| 5.1 | README | One-command demo, what is new in the window vs pre-existing work, AI disclosure, why Monad, diagram, sponsors | review | DONE |
| 5.2 | SUBMISSION.md | Per-bounty portal fields, evidence, 3-minute demo script with timestamps | review | DONE (testnet TODOs await the go) |
| 5.3 | docs/DEPLOY-LATER.md | Ordered runbook to live in under 1 hour: funding amounts, keys and where to set them, deploy, verify, host, smoke test, shot list | review | DONE: docs/DEPLOY-LATER.md |
| 6.x | Testnet deploy, hosting, live video | Awaiting the user's go and MON funding | — | BLOCKED |

## Gaps (from the code, 6 Oct; statuses 7 Oct)

| Gap | Evidence | Impact | Sev | Fix → task | Status |
|---|---|---|---|---|---|
| Pyth mock mode prices from a fixture file and invents momentum from a hash | `server/pyth.js:29-95`, `shared/prices.fixture.json` | Fake prices could be minted into cards and stats | **P0** | 1.1 | CLOSED: signed `LocalPriceOracle`; live quotes only |
| MockPyth accepts unsigned updates from anyone | `contracts/src/mocks/MockPyth.sol` | Any player could post their own "price" | **P0** | 1.1 | CLOSED: moved to `contracts/test/mocks` (test double only) |
| Privy mock custody holds user keys on the relay | `server/privy.js:127-160`, `app/src/lib/privy.ts:111-160` | A mock presented as a wallet | **P0** | 1.2 | CLOSED: deleted; honest 503 without keys |
| Kimi mock strategist and commentary in the product path | `server/ai.js:163-630`, `app/src/lib/ai.ts:105`, `Commentary.tsx:225` | "Kimi (mock)" is fake AI | **P0** | 1.3 | CLOSED: deleted; "Kimi · not configured" |
| Seeded starter cards in the collection when not on chain | `app/src/state/collection.ts:48-58`, `useChainSync.ts:101` | Shows cards the player doesn't own | **P0** | 1.4 | CLOSED: chain-only collection |
| Local chests drop local-only cards after bot wins | `app/src/state/economy.ts:184-312`, `match.ts:1536`, `Chests.tsx:553` | Rewards that aren't real | **P0** | 1.4 | CLOSED: chain-only chests |
| Placeholder ad boards in the desktop gutters | `app/src/components/AdSlot.tsx`, `Shell.tsx:63,169` | Placeholder content | P2 | 1.5 | CLOSED: `MarketBoard` |
| In-memory store when no MONGODB_URI | `server/memstore.js`, `index.js` | Not a persisted DB | **P1** | 2.2 | CLOSED: MongoDB, one DB per deployment; test-persistence |
| Pure-local mocks for AUSD and faucet | `contracts/src/mocks/MockAUSD.sol`, `DeployLocal.s.sol` | Not the real AUSD contract | P1 | 2.1 (fork uses the real AUSD) | CLOSED: the fork uses Agora's real AUSD and faucet |
| CRE simulate not run | `cre login` absent | Bounty proof missing | P1 | BLOCKED: user `cre login` | BLOCKED: user `cre login` |
| No live Kimi, Privy or Pyth keys | env | Real paths untestable | P1 | BLOCKED: keys | BLOCKED: keys |
| Testnet not deployed | 0 MON | No public demo | P1 | BLOCKED: awaiting go | BLOCKED: awaiting go |
| No CI | `.github/` absent | Nothing guards main | P2 | final round | CLOSED: `.github/workflows/ci.yml` (forge, app typecheck/sim/lint/build, relay incl. MongoDB persistence, CRE, Envio) |
| Production build failed: `@stripe/crypto` (via Privy) imports the optional peer `@stripe/stripe-js` | `vite build` | Vercel build would fail | P2 | final round | CLOSED: peer installed; `vite build` green |
| `THREE.Clock` deprecation warning in the console | `@react-three/fiber` 9.8.1 internals | Console noise | P3 | — | ACCEPTED: third-party; fixed only in fiber 10 canaries |

## Completion checklist (100% = all of these)

Features (8): passkey accounts; guest; onboarding; mint; chests; merge; staked match; locker
Flows (6): first five minutes; practice; staked PvP win; void/dispute; timeout refund; cross-device locker
Data (3): real prices; real persisted DB; indexer live
Integrations (7): Mera ×2; Privy; CRE; Envio; Kimi; Pyth/AUSD
Quality (4): tests green; zero-mock browser pass; secret scan; 375px
Ship (4): README; SUBMISSION; DEPLOY-LATER; testnet live + video

**Initial (6 Oct, before phase 1):** 20 of 32 items are real and verified.
- Features 8/8. Flows 5/6 (the cross-device locker is untested).
- Data 1/3: the indexer only; prices include fixtures and the DB is in-memory.
- Integrations 3/7: Mera ×2 and Envio are real; Privy, Kimi and Pyth run as mocks; CRE is unsimulated.
- Quality 2/4: tests green and the secret scan; zero-mock not done; 375px unaudited.
- Ship 1/4: README is partial.

**Initial ≈ 62%.**

**Final (7 Oct): 28 of 32 items are real and verified.**
- **Features 8/8.** Passkey accounts are verified in real Chrome with a PRF virtual authenticator (sign-up, stateless sign-in). Guest, onboarding, mint, chests, merge (chain e2e), the staked match and the locker all pass.
- **Flows 6/6.** First five minutes; practice; a staked PvP win (25 + 17 plays on chain, settled, credited); void and dispute (forge and the indexer seed); timeout refund (e2e); the locker restored after a storage wipe with the same passkey.
- **Data 3/3.** Live OKX/CoinGecko prices signed into the oracle; MongoDB that survives restarts, one database per deployment; the Envio indexer, with `verify-local` 52/52 on two chains.
- **Integrations 4/7.**
  - Real: Mera ×2, Envio, and Pyth model + AUSD (a signed local oracle and Agora's real AUSD and faucet).
  - **Not yet live:** Privy (keys), Kimi (`MOONSHOT_API_KEY`), CRE (`cre login`). Each shows an honest "not configured" state.
- **Quality 4/4.** 14 suites green; the zero-mock browser pass; the secret scan; 375px.
- **Ship 3/4.** README, SUBMISSION and DEPLOY-LATER are done. The testnet deploy and video await the go.

**Final ≈ 88% (28/32), up from ≈ 62% (20/32).** The four missing items need only the user: three sponsor keys or logins, and the testnet go.
