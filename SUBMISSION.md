# Mempire — Arc Microgrants submission

| | |
|---|---|
| Project | Mempire: a real-time 1v1 card battler where the market is the meta |
| Network | **Arc testnet (live, 5042002)**: addresses in `deployments/arc-testnet.json`; mainnet-ready, not deployed: `CONFIRM_MAINNET=yes sh scripts/deploy.sh mainnet` |
| Repo | https://github.com/nickthelegend/mempire-arc (MIT) |
| Live app | Not hosted yet (run locally against Arc testnet: see README); live testnet match: `docs/E2E-TESTNET.md` |
| Demo video | None |

## Description (≤150 words)

Mempire turns the market into a card game on Arc. Every fighter — BTC, LINK, gold, the euro — is
priced from its Chainlink Data Feed (testnet: on-chain mirrors of the mainnet feeds), and each fighter's 24-hour move is computed on chain into a small buff or
nerf. Two players stake a dollar of USDC, play a three-minute lane battle where every card drop is a sub-second Arc
transaction from a per-match session key, and the arena pays the winner in the block both results land. Players
hold one token: USDC is the stake and the gas. Sign-in is a passkey. USDC on Base, Ethereum or Arbitrum works
too: Circle Gateway tops you up on Arc in a second, and from Base one transaction moves the dollar with CCTP while
Chainlink CCIP carries the instruction that opens your match. Stakes and payouts carry Arc Memo tags; the AI
opponent has an ERC-8004 identity.

## What it uses Arc for

- **USDC as gas and stake** — one token; the session key's gas float is an ERC-20 USDC transfer that is native gas.
- **Sub-second finality** — every card play is its own transaction; settlement in the second claim's block.
- **Chainlink Data Feeds on Arc** — every fighter's price, read in the mint; the daily meta computed on chain from feed history. Mainnet reads Chainlink's feeds (fork-verified); the live testnet deployment reads relayer-written mirrors of them, a testnet-only trust assumption.
- **Chainlink CCIP + Circle CCTP V2** — enter or cash out from Base/Ethereum; defensive receiver on Arc. (Fork + Chainlink Local only; never run live.)
- **Circle Gateway** — unified USDC balance; balances read live from Circle's API, the Arc mint was never run live.
- **Arc Memo** — stakes and payouts tagged with the match id (fork-verified; the live testnet e2e used plain calls).
- **ERC-8004** — the AI opponent's identity and player-written reputation (fork-verified; the agent is not registered on testnet yet).
- **USDC permits (EIP-2612)** — stake + gas float in one transaction.

## Demo steps

1. Open the app → **Play now** → create a passkey (or **Play as Guest**). On testnet the relay mints an 8-fighter
   deck and sends 2 USDC; on mainnet hold $1 USDC first.
2. Arena → **$1** tier → **Ranked**. Play cards; the badge shows each play landing on Arc in well under a second.
   When both results land, the winner gets $1.80 in the same block (Memo-tagged with the match id).
3. Cards → mint a fighter for $0.05 → its card shows the Chainlink price at mint; the side boards show today's
   on-chain buffs/nerfs.
4. Empire → **Your USDC, any chain**: the Circle Gateway unified balance per chain → **Top up Arc**; or
   **Enter from Base** (CCTP + CCIP) and follow the message on ccip.chain.link.
5. Play "vs Kimi" and rate the AI opponent — an ERC-8004 feedback transaction.

Locally, all of this runs on a fork of Arc mainnet: `./scripts/local-up.sh` (see README).

## Honest status

- **Live on Arc testnet** (2026-10-13): contracts deployed (31 txs); two wallets onboarded through the relay, a card minted at the
  feed price, the daily meta posted from the feeds on chain, and a $1 staked match paired by the relay, escrowed, played
  (16 card drops on chain), settled and paid ($1.80 to the winner, $0.20 rake). Links: `docs/E2E-TESTNET.md`.
- That match was the app's real simulation driven by its bots for both seats and run faster than real time, settled by the
  two-claim path; it was not two humans playing three minutes in a browser, and the final claim was sent by hand after a
  gas-reserve failure (details in the E2E doc).
- Testnet prices are mirrors of Arc-mainnet Chainlink rounds written by our relayer (Chainlink feeds are mainnet-only),
  seeded sparsely: the relay must keep running to keep them fresh, and the keeper can post a new meta only after 24 h of mirror history.
- Not run live: CCIP/CCTP entry from Base, Gateway top-up mint, Memo tags, the ERC-8004 rating, CRE, the Envio indexer, passkey (WebAuthn PRF) ceremony.
- Verified on local forks of Arc and Base mainnet (real USDC, Chainlink feeds, CCIP router, CCTP, Gateway, Memo,
  ERC-8004) and against Circle's live Gateway API.
- The AI opponent is LLM-planned only when the relay has `MOONSHOT_API_KEY`; otherwise the app offers the classic bot.
- The relay's leaderboard store is in memory unless `MONGODB_URI` is set; Empire's "Settled on Arc" list is read from chain events and survives restarts.
