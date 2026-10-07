# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences that never share a game: crypto people who know the tickers (BONK, WIF, NVDA, BTC) and mobile players who know Clash Royale's loop and want a good three-minute match. Nobody has to hold anything to play — guest mode is a real keypair in the browser — so the top of the funnel is anyone with a phone browser rather than the subset holding eight specific tokens. Connected-wallet players (Phantom/Solflare/Coinbase/Trust/Nightly) are the ones who own cards properly and put SOL on a match. Primary situation: phone browser or desktop, short sessions, real-money psychology once a pot exists even when the stake is 0.05 SOL. Their job: collect fighters, prove skill, take the pot.

## Product Purpose

Mempire (mempire.fun) is a 3D real-time 1v1 card battler on Solana. The roster is the market itself: coins, stocks and crypto as characters. Players mint cards (0.02 SOL each — that mints an account they own, not their coins), build an 8-card deck, and fight Clash Royale-style lane battles where both players stake SOL into an escrowed pot and the winner takes ~90%. Cards climb 1→10 by winning: a win earns a chest, chests drop duplicates, merging a duplicate promotes the card. Success: a judge (or degen) goes open → play → mint → deck → battle → payout in one sitting and immediately queues again.

## Positioning

"Every coin is a fighter." No other battler makes the market its roster — majors, memecoins and tokenised stocks, each with its own art, archetype and stats — with a real pot on every match. The game never custodies, locks or stakes anyone's tokens: coins are characters, not collateral, and holding the underlying token is not required to play it. The only thing a player risks is the SOL they choose to put on a match, escrowed by a program that pays whoever wins. Fully onchain real-time play via MagicBlock Ephemeral Rollups in the full build (gasless, low-latency) — not an offchain game with a token bolted on.

## Operating Context

- Wallet-optional: guest mode is a real browser keypair, so the whole game works with nothing installed; Phantom/Solflare/Coinbase/Trust/Nightly via Solana Wallet Adapter for players who want to own cards and stake SOL. On mainnet a browser-held key is refused for anything that holds value, and the connect screen says so.
- Built for Solana Blitz V7 (deadline Aug 9, 2026); that deadline has passed and the product shipped.
- Devnet today: the program is live and the whole loop — mint, merge, escrowed pot, settlement, timeouts — is proven by a 92-item test plan run against the real product (`TESTPLAN.md`, `VERIFICATION-REPORT.pdf`). The devnet registry is 66 seeded assets (crypto, memecoins, tokenised stocks) against a mock price-oracle PDA.
- Mainnet next, gated on ~4.2 SOL of deploy rent for the `mainnet,rollup` build (`MAINNET.md`), the 36-asset verified roster, and small tiers only. Cluster is an env flip; the deploy keypairs carry the same program IDs.
- Solo founder; Claude owns code end to end (TS/React + Rust/Anchor).
- Anyone demos alone: a bot opponent makes every flow work without a second human. A bot match escrows nothing and says NO STAKE, because a bot has no key to escrow with.

## Capabilities and Constraints

Architecture locked 2026-07-29, amended when staking was removed:

- **Holdings are never touched.** No custody, no locking, no staking of player tokens; there are no vaults and no stake/unstake instructions in the program. The only value a player puts at risk is SOL they choose to wager on a match, and that sits in a match escrow that pays out to the winner.
- Battle model: onchain input log + deterministic lockstep client sim. Inputs {tick, card_index, x, y}; both clients sim identically; state hash every 40 ticks; a mismatch voids the match and both stakes go home. Fixed-point i32 math (1/1024), 20 ticks/sec, 3 min + 60 s overtime, 2-tick input delay, xorshift seed derived by the matchmaker from match id XOR both deck hashes (order-independent, but server-trusted — not yet commit-reveal).
- Cards: an Anchor `Card` PDA *is* the card. In the full build the `nft` feature adds `tokenize_card`, which mints a Metaplex 1-of-1 over an existing card so it renders in wallets and explorers; the lean launch build ships cards as program accounts and adds the NFT layer later by extend-and-upgrade. Bubblegum cNFTs are not in the build.
- Power: coin mint hash → one of 6 global archetypes (`fnv1a(mint) % 6` → tank, swarm, ranged, splash/siege, support, spell), fixed by the mint so nobody can reroll into a better one. Level 1–10 scales stats on the diminishing curve `1 + 0.6·√((lvl−1)/9)`; level never changes elixir cost.
- Levels are earned, not bought: win → chest → duplicate → merge (`upgrade_card`, capped at 10). The duplicate is closed and its rent returned; the merge charges 100 × current level $MEMPIRE. No amount of money produces a level without a duplicate, and duplicates come only from playing.
- Eligibility gate: ≥$25k liquidity, ≥48 h old, Jupiter-priced (mocked on devnet). It is a claim about the *coin*, not about the player's wallet — it is what stops a god card minted from a token launched this morning. Mainnet roster: 36 assets built from Jupiter's verified list — majors (BTC/ETH/SOL), memecoins (BONK/WIF/POPCAT/MEW/PEPE), tokenised stocks (NVDA/META/MSTR/V). Identity never comes from symbol search.
- Fees: mint 0.02 SOL, rake 10% (5% on exact tie), merge 100×level $MEMPIRE, chest skip 25 / extra chest slot 100 / shop 250 / paid reroll 35 / clan charter 250 $MEMPIRE, 5% royalty on tokenised cards. Nothing on that list changes a match outcome, and no fee is taken on anyone's own tokens because the game never holds them.
- Matches: 4 power-bracketed tiers, fixed SOL stakes (0.05 Pauper / 0.25 Knight / 1 Duke / 5 Emperor); SOL-only pots; stakes escrow only when a match actually starts, so cancelling a search costs nothing; the matchmaker calls `create_match` with onchain deck validation; two-claim settlement — both seats record a result and the program pays only when they agree; `claim_timeout` for an abandoned opponent, permissionless after a further grace period so a pot never locks.
- The rollup is optional: with the `rollup` feature the match log delegates to a MagicBlock ER (card plays and hash checkpoints onchain, sealed to the two seats by an ER-local permission, VRF-rolled chests). Settlement works identically with or without it; the lean build rolls chests from a local seed and labels them as such.
- Decks: 8 cards, one card per coin per deck, 3 saved slots in a Player PDA. Elixir: 1 per 2.8 s, cap 10, doubles in the last 60 s of regulation and throughout overtime.
- Stack: Vite SPA + React + TS + React Three Fiber + Zustand; Anchor programs; Helius; Express + MongoDB relay (persistence, leaderboard, clans, cached coin feed — authoritative for nothing that holds value); Vercel + Railway.
- Mobile browser: 30 fps cap, ≤40 units, shadows off, ≤2k tris/unit, one 512 px atlas, GPU instancing.
- Program size is a product decision, because deploy rent scales with bytes: lean 469,736 B = 3.27 SOL; `rollup` 599,040 B = 4.17 SOL; full (`nft` + `rollup`) 710,304 B = 4.94 SOL. That rent is a refundable deposit — `solana program close` returns it — not a spend. The launch target is `rollup`: the 0.90 SOL over lean is what keeps the MagicBlock integration live on mainnet rather than devnet-only.
- Known residual (`AUDIT.md` C9): the programs are not third-party audited, and a losing player can contradict the result to force a void and recover their own stake, denying the winner the pot. They cannot steal. Closing it needs the play log verified onchain; small tier caps are the compensating control until then.

## Brand Commitments

- Name: Mempire. Domain: mempire.fun. The name plays on meme + empire; crown/throne/empire motifs are on-theme.
- Layout law: dark UI, single centered mobile-width column (430 px), arcade-cabinet framing on desktop; side gutters intentionally empty and now carrying ad-slot boards.
- Visual world: **Royale Arcade** — quilted royal-blue field, carved wood panels, fat buttons that depress into their own base edge, chunky outlined display type (Lilita One). Solana purple and teal survive as the energy accent; royal gold means exactly one thing: SOL is moving. This supersedes the near-black "Solana Royale" world chosen 2026-07-29; `DESIGN.md` is the authority.
- Voice: **degen seasoning** — controls stay crisp and scannable (Battle, Merge, Claim); degen flavour lives in moments: victory ("POT SECURED"), empty states, taunts. Never meme-speak on a destructive or financial confirmation.
- Gameplay identity: Clash Royale-like (lanes, towers, elixir, real-time card drops) — explicitly not Clash of Clans base-building.

## Evidence on Hand

- No users, testimonials, press, or metrics exist. Do not fabricate any.
- Art and audio exist and are committed, generated through the Higgsfield CLI pipeline (`design/gen.sh`, `gen-audio.sh`, `slice.py`) under one byte-identical STYLE FORMULA.
- Everything verified so far is devnet: the 92-item test plan against the live product, the onchain e2e scripts, a 48-assertion clan test, a 12-assertion human-vs-human protocol test. Mainnet execution is unproven.
- Rake and fee numbers are design decisions, not market-tested claims. The build sizes and SOL rent figures are measured from this repo's own builds.

## Product Principles

1. **The market is the roster.** Every fighter is a real asset with a real identity — and the game never touches anyone's holdings. Coins are characters, not collateral; breaking that promise breaks the product.
2. **Fast to fun.** Open to first battle in seconds: no install, no wallet, no holdings required. Mid-match wallet popups are the enemy (session keys, still to ship).
3. **Power is won, never bought.** Levels come only from chests and merges; diminishing curves, tier caps and bracketed matchmaking are load-bearing, not tuning details.
4. **Every action can pay, openly.** Fees are stated in the UI at the moment they apply; the rake is never hidden.
5. **Demo-proof.** Every flow must complete solo — guest keypair, bot opponent, seeded coins, mock oracle — with no second human and no mainnet dependency.

## Accessibility & Inclusion

Mobile browser is a first-class target: touch-first drag-to-deploy battle controls, 30 fps floor on mid-tier phones, and a 12 px legibility floor verified at 320/375/430 px. Starting requires no wallet and no crypto literacy. Money moments (stake, pot, loss) must be unambiguous to non-native English speakers — plain numbers beat slang there.
