# 2026-10-14 reassessment — improved, acceptance still incomplete

The mandatory two-player real-time browser settlement is **not verified**. The managed sandbox blocks Chromium
startup before any funding. No new live match or payout is claimed; spend was **0 USDC**.

| Criterion | Before this pass | After | Evidence / remaining limit |
|---|---|---|---|
| Relevance to Arc | 8 | 8 | Same live contracts; direct event-based settlement and money standings now survive relay downtime. No new Arc integration claimed. |
| Technical credibility | 7 | 7 | Atlas persistence and outage handling verified; 24 protocol checks pass. Complete revised escrow-ready match still unrun, so no score uplift. |
| Build quality | 8 | 8 | 11 original portraits, 20/20 assets present; public roster, first-match coaching, ten responsive route screenshots. Actual mobile battle and passkeys remain untested. |
| Worth taking further | 8 | 8 | Vercel HTTP entrypoint and minimal relay requirements documented. No always-on relay or revised frontend deployment; central acceptance remains open. |

Changes: both stakes verified before countdown; separate staked/rating queue pools; claim gas reserve raised from
0.005 to 0.025 USDC; coaching applies to a first live match as well as practice; existing sound and battle VFX retained.
All missing fighters have vector portraits, including NFT metadata and chest previews. Cold visitors can inspect
all 20 fighters, and Empire shows the actual settlement event without sign-in. Empty history points to “Play your first match”.

Storage: Monad Mongo credential reused only in ignored env, **mempire_arc** database. Player history/clans survive
restart (7/7 checks in a disposable DB); real chain events and money standings persist (1 match, 2 player rows).
Mongo outage: chain reads succeed; unavailable clan/trophy data is explicit because those records have no chain events.
No mock clan or match was added to the live database. Relayer tasks are disabled in the Vercel function entrypoint.

Validation: typecheck/build pass; 7 Node unit tests pass (auth/memstore files contain 27 additional assertions);
24 WebSocket checks pass; sim determinism passes; lint exits 0 with pre-existing warnings. Ten connected-Chrome
screens at 1280/390 have no horizontal overflow or broken images. Build retains large-bundle warnings.
The new Playwright command **fails at launch in this environment**; do not confuse these Chrome screens with its acceptance.

Still weak: no new two-player gameplay proof, passkey ceremony unrun, mobile battle unrun, revised frontend not deployed,
no hosted relay, no load test, cold event scanning scales with chain history, legacy integrations retain the statuses below.
The strict 2 USDC gross cap cannot fund two fresh $1 stakes plus session floats; explicit temporary-float approval or
prefunded test wallets is required. See [E2E](E2E-TESTNET.md), [hosting](HOSTING.md) and [screens](screens/testnet/).

---

## Historical 2026-10-13 report (superseded by the reassessment above)

# Judge + fix pass: Mempire on Arc (2026-10-13, Arc testnet only)

Scored as an Arc Microgrants judge first, then fixed. Live evidence: [E2E-TESTNET.md](E2E-TESTNET.md). Screens:
`docs/screens/testnet/` (cold visitor and the winning wallet, desktop 1280 and phone 390).

## Scores

| Criterion | Before | After | Why |
|---|---|---|---|
| Relevance to Arc | 7 | 8 | Before: strong Arc story (USDC gas+stake, sub-second finality, permits, Chainlink, CCIP/CCTP, Gateway, Memo, ERC-8004) but all of it only on a fork. After: deployed and exercised on Arc testnet (USDC stake/gas/permit/session keys, MarketMeta, settlement). CCIP/Gateway/Memo/ERC-8004 still not live. |
| Technical credibility | 5 | 7 | Before: README said "not deployed", claims rested on forks, the Chainlink-on-testnet gap was a footnote. After: real $1 match settled on chain with explorer links, honest labels (Live / Fork / Not run), the mirror-feed trust assumption stated in the README, SUBMISSION and the UI wherever a price is shown. Capped at 7: the match was bot-driven by the app's own sim, not two humans, and one claim was sent by hand. |
| Quality of what was built | 7 | 8 | Big, polished app; typecheck clean, 4/4 relay unit tests, no console errors or failed requests on any route at 1280 and 390. Fixes below. Not 9: Playwright screens only, no passkey ceremony run, 6 of 20 fighters have no card art. |
| Worth taking further | 7 | 8 | Mainnet is one command away and the app now has a real settled match to show; the leaderboard no longer depends on the relay's volatile store for proof. |

## 1. Claims audit (README, SUBMISSION, in-app copy)

| Claim | Status | Action |
|---|---|---|
| "Arc testnet: not deployed yet" / "blocked on funds" (README, SUBMISSION) | **False now** (31 txs live) | Rewritten with the live deployment and e2e link |
| "Every fighter is priced by Chainlink on Arc" (landing, Cards, card detail, tutorial, loading tips, README, SUBMISSION) | True on mainnet (fork-verified); **false on testnet** (mirrors written by our relayer) | Reworded everywhere; testnet UI shows `MIRROR_NOTE`, the meta strip says "testnet mirror feeds"; README trust note |
| "Live testnet CCIP send is a user-run script" / CCIP+CCTP entry | **Fork / Chainlink Local only; never live** | Labelled "Not run live" |
| Gateway top-up "mints on Arc in about a second" | API reads live; **mint never ran live** | Labelled |
| Memo-tagged stakes and payouts | Fork only; the live e2e used plain calls | Labelled |
| ERC-8004 rating of the AI opponent | Fork only; **agent not registered on testnet** (app correctly hides the buttons) | Labelled "Not run live" |
| "AI opponent / vs Kimi" | LLM-planned only if `MOONSHOT_API_KEY` is set (it is not in this deployment) | README/SUBMISSION say so |
| Envio "Live on Arc" panel | Codegen + handler tests; **not deployed**, panel hidden | Labelled; Empire now lists settled matches from arena events via the relay |
| CRE meta writer | Tests/WASM only; **not run live**; the live meta came from `postFromFeeds` | Labelled |
| Test-suite counts (71 unit, 37/37, ...) | From the port's fork runs; **not re-run** except relay units | README states which were re-run |
| "Settlement in the same sub-second block" | Settlement lands in the second claim's block (true, live); "sub-second" measured on the fork only | Reworded to "the block the second result lands" |
| Passkey (WebAuthn PRF) sign-in | Never exercised in a browser | Already labelled in SUBMISSION; kept |
| Live app URL / demo video `TODO` placeholders in SUBMISSION | Placeholders | Replaced by "Not hosted yet" / "None" |

## 2. Mocks audit

grep of `app/src` and `server/*.js` for mock/stub/fake/placeholder/lorem/TODO/old-chain words (Monad, MON, AUSD, Kuru, Privy, Mera): **no
old-chain text, no mock data paths**. What remains is labelled in the code and now in the docs: a "demo pacing" time scale
(chest unlock 1/60, shop rotation 3 min) on non-mainnet builds (`DEMO_TIME_SCALE`), mirror feeds on testnet, a `TODO(security)`
note in the matchmaker (queue address is asserted; ranked play requires a signature, and unsigned queues are demoted to casual).
One real wart removed: the unstyled "Check original transaction" button that sat under every page (a crash-recovery
tool) is now a small muted link with a tooltip.

## 3. Screens audit (Playwright, Arc testnet deployment, relay on :8780)

5 routes (Arena, Cards, Deck, Clan, Empire) x {cold visitor, winning wallet} x {1280, 390}: **0 console errors, 0 failed requests,
0 horizontal overflow, 0 Monad/MON/AUSD/lorem/undefined/NaN text.** Findings and fixes:

- 6 fighters (JPY, CAD, AAVE, HYPE, MXN, KRW) have **no card art**: the market side-boards showed blank squares. Fixed with a coloured
  initial badge under the image (the card frame already had a procedural fallback). The art itself is still missing.
- The Empire "Battles" empty state said "No battles yet" for a wallet that had just won on chain. Reworded
  ("played from this browser"), and a new **"Settled on Arc testnet"** panel lists the arena's `MatchSettled` events with pot, payout and an
  explorer link (`server/recent.js`, `GET /api/arc/matches`). It shows the live match #1 even when the relay's store is empty.
- Leaderboard shows the live match (Net USDC tab: winner +$0.80, loser -$1.00, chain-verified) with honest empty states for
  Trophies ("No ranked matches yet"), USDC and Clans. The relay store is in memory without MongoDB: after a relay restart those tabs empty
  out, which is why the chain-read panel was added. The Clan screen has no clans on this deployment (empty state tested).
- Cold visitors are routed to sign-in before Empire/Cards content; the screenshots show that gate.
- Explorer links go to `explorer.testnet.arc.io` (checked: tx and address pages return 200).

## 4. Feature check (live, real transactions)

See [E2E-TESTNET.md](E2E-TESTNET.md): onboarding (starter decks), mint at the feed price, daily meta from feeds (20 fighters), a relay-paired $1
staked match (16 drops on chain) and settlement paying $1.80. Not done: onboarding drip, ERC-8004 rating, CCIP/CCTP, Gateway, Memo.

## Fixes made

- `server/mirror.js`: sparse first seed (latest + day-ago round + successor per feed, 56 rounds, ~0.09 USDC) instead of a 30 h backfill
  (~665 rounds, ~1 USDC). Full history only accumulates with uptime.
- `server/recent.js` + Empire "Settled on Arc" panel; testnet mirror disclosure in 6 UI places; market-board badge fallback; recovery button styling.
- `server/test-e2e-testnet.mjs`: the live e2e (resumable-friendly: idempotent mint/meta, session-key gas top-up before claims).
- README, SUBMISSION rewritten to the evidence above.

## Still weak

- No hosted app or relay URL; judges must run it locally. No demo video.
- The live match was bot-vs-bot through the real sim, run faster than real time, with the last claim sent by hand; a clean one-shot
  re-run of the script has not been executed. No two-human browser match on testnet.
- Testnet prices are our relayer's mirrors; the keeper cannot post a fresh meta until 24 h of mirror history exists, and prices go stale
  (26 h) if the relay stops copying rounds. Testnet explorer verification of the contracts is not done.
- CCIP/CCTP, Gateway mint, Memo, ERC-8004, CRE, Envio, passkeys: not run live. 6 fighters lack art.
- Gross spend was 2.71 USDC (over the 2.5 ceiling) after two avoidable mistakes; net cost about 0.56 USDC, of which 0.32 is still in the relayer.
