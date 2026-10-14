# Live Arc testnet end to end

Run on **2026-10-13** against the real Arc testnet deployment (`deployments/arc-testnet.json`, chain 5042002): real
transactions, a real relay (`server/index.js` on :8780, in-memory store), nothing forked. Script:
[`server/test-e2e-testnet.mjs`](../server/test-e2e-testnet.mjs). Throwaway player keys live in the gitignored
`.local/testnet-players.json`; leftovers were swept back to the deployer afterwards.

## What is real and what is not (read this first)

| | Status |
|---|---|
| Players, stakes, escrow, plays, claims, payout, rake, $MEMPIRE reward, chest | **Live on Arc testnet** (links below) |
| Pairing of the two players, the escrow handshake (`opened`/`joined`) and the relayed inputs | **Live**, through the relay's WebSocket |
| The match itself | The app's **real deterministic lockstep sim**, driven by its built-in bots for both seats and run **faster than real time** (240 s of game time, 76 card drops). It is not two humans playing a 3-minute match in a browser. The first 8 drops per seat were posted on chain by the session keys; the rest stayed in the sim (each drop is one tx, ~0.001 USDC; capped to fit the float). |
| Settlement | The normal **two-claim path** (both seats claim the sim's winner and final hash; the second claim settles). The timeout path was **not** used here (it is covered by `server/test-e2e.mjs` on a fork). |
| Prices | **Testnet mirror feeds, not Chainlink.** Chainlink Data Feeds exist on Arc *mainnet* only. The testnet deployment's 20 `MirrorAggregator`s hold copies of the Arc-mainnet Chainlink rounds (same round ids, answers, timestamps), written by our relayer (`server/mirror.js`). That is a **testnet-only trust assumption**; on mainnet the contracts read Chainlink's own feeds. The BTC card below was minted at 82,921.19 = the mirrored round of Chainlink's mainnet BTC/USD at 2026-10-13 17:52:49 UTC. |
| Mirror seed | To keep the relayer under 1 USDC the mirrors were seeded **sparsely** (56 rounds: the latest round, the round current 24 h earlier and the one after it, per feed) instead of a full day (~665 rounds, ~1 USDC). The first meta post therefore works, but the relay's keeper cannot post a *later* meta until the mirrors are contiguous over 24 h of relay uptime (it logs "no feed has 24h of history yet"). Prices stay valid only while the relay keeps copying new rounds (max price age is 26 h for crypto, 96 h for FX/gold). |
| Onboarding drip | **Not exercised**: the players were funded directly from the deployer (the drip only pays wallets holding less than `ONBOARD_USDC_DRIP`, set to 0.1 here). The relayer did mint both starter decks. |
| ERC-8004 rating of the AI opponent | **Not run.** The AI agent is not registered on testnet (needs the hosted relay URL for its agent card, `scripts/register-agent.mjs`). `/api/agent` honestly answers `registered: false` and the app hides the rating buttons. |
| CCIP/CCTP entry from Base, Circle Gateway top-up, Arc Memo tags | **Not run live** in this pass (fork only). |

## Transactions

Deployment contracts: arena [`0x8808…d551`](https://explorer.testnet.arc.io/address/0x8808BF690f5b9265AcAF5Fb7759E73073606d551), cards
[`0x1041…c9A`](https://explorer.testnet.arc.io/address/0x1041092bA922a5989588D06b15a62192bdA4fc9A), MarketMeta
[`0x108E…6D`](https://explorer.testnet.arc.io/address/0x108E70F055DFe8A11fedb5DFF32f69f9045E3b6D).

| Step | Transaction |
|---|---|
| Relayer funded (0.5 USDC, from the deployer) | [`0x788468ff…`](https://explorer.testnet.arc.io/tx/0x788468fffe4f0b3c10d7c574f4b0ccd6c3094558df8e3b639258b72008cf9fd0) |
| Onboarding: starter deck of 8 fighters minted by the relayer, player A | [`0xcdd4cfb9…`](https://explorer.testnet.arc.io/tx/0xcdd4cfb94b3bf60440db7751a3ebec2f1a298880185a8781446bd06827ab421c) |
| Onboarding: starter deck, player B | [`0xd4e5e629…`](https://explorer.testnet.arc.io/tx/0xd4e5e629f33a66466281a94fa300dc6215d04011f7e4a85c933075a55bd211c6) |
| Mint a BTC fighter for $0.05 USDC at the feed price (permit inside the tx) | [`0x9345ee2b…`](https://explorer.testnet.arc.io/tx/0x9345ee2b7e4bc992f03e0d8af9c2b83c62f7dc42e8a9eb7d6eedaca5940dbaaf) (a second, accidental re-run mint: [`0x0542f77c…`](https://explorer.testnet.arc.io/tx/0x0542f77c866b68b77ebe285b205a233c68e9e0835a8ac30f09fdb5c89826a3bc)) |
| Daily meta: `MarketMeta.postFromFeeds` for all 20 fighters, signed by the relayer, computed on chain from the feed history | [`0xd4c1477b…`](https://explorer.testnet.arc.io/tx/0xd4c1477bab78a6b9366420b5678b5cdb928ba4f66c12fd1cee6dfaeffc172848) |
| Match created: seat 0 stakes $1 (permit inside the tx) + session float | [`0xf2e6b741…`](https://explorer.testnet.arc.io/tx/0xf2e6b74182735a11a68e8f25f8d63233b026c8f2cac33e78d37c89e33afeca22) |
| Match joined: seat 1 stakes $1 + float | [`0xa6041a11…`](https://explorer.testnet.arc.io/tx/0xa6041a1109ce5286a7619eeb52a5d9fecea64923f062f039a99bcd2b08e6af0b) |
| 8 card drops by seat 0's session key | [`0x489a466e…`](https://explorer.testnet.arc.io/tx/0x489a466ef0058776a5fcd2c3e365983f581e7040175724f927b5ba6d56dedf91) [`0x95b8a726…`](https://explorer.testnet.arc.io/tx/0x95b8a726b54d605ef2bb62ad12dfdb98081024bb35c553b3e30518a94d63aea7) [`0x283a412b…`](https://explorer.testnet.arc.io/tx/0x283a412bc81b50b72aaa7ef387571303aa69b1d3df561d0456a269f3b2fa211c) [`0x2614d489…`](https://explorer.testnet.arc.io/tx/0x2614d489c8eb8786887d1935350aa2bfddaa577d005a330b8f16961f5452bff0) [`0xf95b5603…`](https://explorer.testnet.arc.io/tx/0xf95b5603f39ae7143244d1506b2d9c65e377169ec7b76cb901617180cd6b273e) [`0x8e5da728…`](https://explorer.testnet.arc.io/tx/0x8e5da728e509f90628cafc39a195a70784b85a644fbc66142cf56a61638f876a) [`0x82e462dc…`](https://explorer.testnet.arc.io/tx/0x82e462dc03689ac4713bad74185f966f8405c00420b1838e1ecefb84377bef84) [`0x3b89910d…`](https://explorer.testnet.arc.io/tx/0x3b89910d99a01c1f6f0bd1245239dea6c66a618df7a4d09ca8f86ca617b206f6) |
| 8 card drops by seat 1's session key | [`0x8494caaa…`](https://explorer.testnet.arc.io/tx/0x8494caaa1e13511927dffa5d23c9c9ccbbc49d0e3581214a286fd143c60e4fb1) [`0x76dcd096…`](https://explorer.testnet.arc.io/tx/0x76dcd09694b81d8e3484558dffa2d5c89e3834510d09d013f112402fc5643f4a) [`0x9f73a4bb…`](https://explorer.testnet.arc.io/tx/0x9f73a4bb0b0aa8b6915c499562818a0666e362ca4c48f1b3afd4344837e73fd0) [`0xd2cf7206…`](https://explorer.testnet.arc.io/tx/0xd2cf72064d0f5aef67a28a55ab837bdaf6f03cc63ee2e06b342c8f91a466b248) [`0x0a730e1b…`](https://explorer.testnet.arc.io/tx/0x0a730e1b155260f5840a0bdf81c43ae56a8fa2aa051aa1e071dbe2b321a88abb) [`0x4b99cbe2…`](https://explorer.testnet.arc.io/tx/0x4b99cbe2f5f332311fe0641e76666e66e2038a2ff3957225c708d6f922ebbd6e) [`0x5372f01e…`](https://explorer.testnet.arc.io/tx/0x5372f01e3c9c1e3b70c769879150b216419c715dd7424daae92442e995c20306) [`0xfdbe4d32…`](https://explorer.testnet.arc.io/tx/0xfdbe4d32b807071b86c9bb583b167b80ae66b7b15398bede723157293c4d1881) |
| State-hash checkpoint | [`0x06492465…`](https://explorer.testnet.arc.io/tx/0x06492465abba397bf554eb9e8c046bd7ad0c8b1954a2153fb93e8e8aaa1ee221) |
| Claim, seat 0 (winner = seat 0) | [`0xa9e2a71f…`](https://explorer.testnet.arc.io/tx/0xa9e2a71f59fcb4cb4acb6183bded8940faf853512ea6c40d828ed554a9b59e15) |
| **Claim, seat 1: settles, pays the winner $1.80, rake $0.20, 50 $MEMPIRE + chest** | [`0xe31c6d6a…`](https://explorer.testnet.arc.io/tx/0xe31c6d6a11e030dfbd94a6bfd4538bcb99435a50276a265a909ba0c58de60c68) |

Final state: match #1 `Settled`, winner seat 0 (`0xcf37…8be8`), pot $2.00, winner paid **$1.80**, treasury **+$0.20**,
arena balance **0**. Read back from the arena by the relay at `GET /api/arc/matches` and shown in Empire under
"Settled on Arc testnet". Both players reported the result to the relay (`POST /api/match`); the relay re-read the
match from chain and credited **+0.80 / -1.00 net USDC** to the chain-verified leaderboard.

## Checks that passed (`server/test-e2e-testnet.mjs`)

Relay on Arc testnet with mirror prices; both players hold an 8-fighter starter deck minted on chain; the BTC card is
stamped with exactly the mirrored feed answer; the day-ago round of all 20 fighters is accepted by
`MarketMeta.feedMomentumBps`; a feed-sourced meta epoch exists; the relay paired the two wallets (ranked, $1 USDC tier,
same seed and meta epoch); seat 1 received the `opened` handshake and read the match back from chain before staking;
seat 0 saw `joined`; both stakes escrowed with the meta epoch snapshotted; the arena held the $2 pot; the sim reached a
result; the play log held 16 drops (8/8); the match settled on the second claim; winner paid exactly $1.80, rake $0.20,
the arena held nothing after, the winner got the $MEMPIRE reward.

## What went wrong on the way (kept for honesty)

- First run: `createMatch` reverted (`ERC20: transfer amount exceeds balance`): my funding was 0.1 USDC short because the
  drip was skipped and a duplicate run had minted a second card. Topped up from the deployer.
- Third run: the settling claim failed with "insufficient funds" on a session key (the claim reserves
  gas x max-fee = 0.0155 USDC and the 0.02 float was mostly spent). The match was left Active with the stakes escrowed; I
  topped the session keys up by 0.008 USDC and sent the missing claim by hand (a script that is no longer in the repo).
  The e2e script now tops session keys up before claiming, so a clean re-run does this in one go, but that exact
  clean run **has not been executed**; the match above was completed by the manual claim.
- Gross USDC sent from the deployer for this pass: 2.71 (0.5 relayer, 1.16 + 1.05 players); the players' leftovers (1.85) were swept back, so the
  net cost was about 0.56 USDC, of which 0.32 is still in the relayer. The 2.5 USDC ceiling was exceeded in *gross* terms
  because of the two mistakes above.

## Reproduce

```bash
cd server && set -a && . ./.env.local && set +a        # relayer key; never printed
PORT=8780 META_KEEPER=0 ONBOARD_USDC_DRIP=0.1 node index.js &     # relay on Arc testnet
# fund the two players listed in ../.local/testnet-players.json with ~1.1 USDC each, then:
../app/node_modules/.bin/tsx test-e2e-testnet.mjs
```

`server/test-gateway-journal.mjs` needs MongoDB and was not part of this pass.

## 2026-10-14: two-player browser acceptance (NOT RUN TO COMPLETION)

`npm run e2e:two-players` now implements two isolated Playwright contexts, actual Guest sign-in and automatic
starter-deck onboarding, the $1 Ranked queue, both escrows, real-time card/canvas clicks, normal two-claim settlement,
$1.80 payout verification, private recovery backups and sweeps. It does not import the bot, accelerate the clock,
change app state or submit a replacement claim from the test process. See `scripts/e2e-two-players.mjs` and the README.

**Actual result here:** Chromium launch was refused by the managed macOS sandbox:
`MachPortRendezvous ... bootstrap_check_in ... Permission denied (1100)`.
The command exited before browser creation, onboarding or funding. **No new match, payout, transaction or human-play
claim is made. Gross and net testnet spend in this pass: 0 USDC.** The earlier match #1 above remains the only live
settlement evidence; it is still the earlier accelerated bot match, not a result of the new harness.

Budget is also explicit: default gross funding cap 2 USDC, while two fresh $1 stakes and the app's session floats
need about 2.28 USDC temporarily plus funding gas. The script refuses this excess before sending. Reusing funded
wallets or an explicitly authorized larger temporary float is required; this pass did not assume permission to
reinterpret the limit as net cost. Keys, browser storage and evidence stay in `.local/two-players/` (gitignored, mode 0600).

Read-only checks completed against **live Arc testnet**:

- Match #1 event and both seats recovered from the arena: winner +0.80 USDC; loser −1.00 USDC.
- The event and standings materialized in MongoDB database **mempire_arc**, collections `match_history` and
  `chain_leaderboard`; no synthetic match was inserted into that database.
- Serverless HTTP handler with Mongo deliberately unreachable: `/api/arc/matches` returned real chain history;
  clan reads and persistent writes returned 503 rather than accepting volatile records.
- Atlas restart test: **7/7**, including signed player save, match history, signed clan creation and the clan/founder
  surviving a process restart. This test used a disposable `mempire_arc_test_*` database and removed it afterward;
  its fixture data is not live game evidence.
- WebSocket protocol **24/24**, including refusal to start on only one ready seat or another/settled escrow.
  Positive escrow-ready countdown and complete browser settlement remain **Not run**.
- Typecheck, production build, deterministic sim checks and **7/7 Node unit tests** passed. Lint exits 0 with
  existing warnings; build warns about large chunks. No contract edits or new contract broadcasts in this pass.
- Connected Chrome (not the blocked Playwright runner): all five cold-visitor routes at 390 and 1280, no horizontal
  overflow or broken loaded images. Screens and machine-readable audit: `docs/screens/testnet/recheck-*`.
  A transient RPC history failure displayed an honest unavailable state; reload succeeded. These screenshots
  **do not establish mobile battle playability, passkey success, or two-human gameplay**.

To reproduce the database checks without broadcasting:

```sh
node --env-file=server/.env.local server/test-history-read.mjs
(cd server && node --env-file=.env.local test-persistence.mjs)
```

The full browser acceptance must still be run on a host allowed to launch Chromium. Its printed transaction links
and private `evidence.json` should be copied here only after the payout assertion passes.

## 2026-10-14: second-player onboarding repair — Live (testnet)

Re-run commands (local ports 8700, 8780–8781; stop the other harness first):

```sh
npm run e2e:onboard-api
E2E_STAGE=onboard npm run e2e:two-players
npm run e2e:two-players
npm test && npm run typecheck && npm run build
```

**Root causes reproduced without a browser:** the UI's eight-second HTTP deadline expired even though the first
starter mint completed. The immediately following onboarding returned HTTP 502, with the Arc RPC's `-32005`
“Request exceeds defined limit” (details: “rate limit exceeded”). There was no stuck per-player nonce lock.
The browser also had a silent dead end: it marked onboarding attempted before reading `starterClaimed`, swallowed
a failed read, and never rendered a retry button. An initial failed wallet load also prevented onboarding entirely.

**Changes:** the relay remains authoritative for the already-claimed check. The app reconciles an ambiguous POST
through the durable claim status without resending it, reloads the real wallet, and displays partial errors.
Multicall3 combines read bursts; RPC throttling uses bounded backoff. The local harness disables the unrelated CCIP
watcher (including its retry broadcasts). Health exposes `chain.relayerFunding` with the current balance,
required amount and top-up status. Unaffordable onboarding returns `RELAY_NEEDS_TOP_UP` and a visible operator
funding message. The browser harness prints child stderr, onboarding responses and player state on failure.

**Fresh-wallet API result: PASS.** Same signed EIP-191 request and eight-second HTTP deadline as the UI; two fresh
wallets back-to-back, each verified with eight on-chain cards and a 0.02 USDC drip. Player 1 took 12.075 seconds
(including status reconciliation); player 2 took 7.160 seconds. No HTTP/test timeout was lengthened.

| Player | Starter mint | USDC drip |
|---|---|---|
| `0x77283A28d0916bc23F8B019da05d4A4D6A27d199` | [Mint](https://explorer.testnet.arc.io/tx/0x7f253cf8c81ec2217015d1c42f4924bc682b90cba79dee93778c2d7211648a8f) | [0.02 USDC](https://explorer.testnet.arc.io/tx/0x6421e0deb56330057811166f9eb11dac6d0d7e6080778c602ce2298a299b57b8) |
| `0x5A33Fd60251fbd897AC3f8554e9F349d7264DA90` | [Mint](https://explorer.testnet.arc.io/tx/0xfe6ce35fc212cf2f207cc0b5b6c50d85ea088256ad5597345432d50368da5cd2) | [0.02 USDC](https://explorer.testnet.arc.io/tx/0xc0d74d592759d2fd3726e09ab97d2b4b5b476b324a7b9b0574492e922a37cbcb) |

**Chromium result: onboarding PASS**, both saved guest contexts (1280px and 390px), no horizontal overflow.
The previously blocked `0xC197b197f53989AbFEd867BA60505F10F8199942` received its deck in
[this mint](https://explorer.testnet.arc.io/tx/0xc9de74ca47f5a73d3f21232d8eb21a0634be1e73b81bd9b3516912cf65f3e016).

**Full staked match: NOT COMPLETE.** Ran `npm run e2e:two-players`; both decks passed, then funding safely refused:
“Two $1 stakes plus gas need 2.28 USDC temporary funding. Default gross cap is 2.” Both saved players have zero
USDC. No match or payout occurred in this pass; a 2.30 USDC temporary float needs explicit budget authorization
(or separately funded wallets). The requested approval was still pending when this evidence was recorded.
All started relays, Vite and Chromium processes were stopped. No hosting resources were created.

Testnet USDC used in this investigation: **0.174320075 gross** from the existing relay balance (2.579221375 →
2.4049013), including successful diagnostic mints and the two 0.02 drips. No deployer funding transaction was sent.
Tests: 8 server test entries (including 27 auth/store assertions), 4 onboarding regressions, typecheck and production
build pass; lint exits 0 with existing warnings. Build retains the existing large-chunk warning.
