# Mempire — Arc Microgrants submission

| | |
|---|---|
| Project | Mempire: a real-time 1v1 card battler where the market is the meta |
| Network | Arc (testnet deploy pending deployer funding; mainnet-ready: `CONFIRM_MAINNET=yes sh scripts/deploy.sh mainnet`) |
| Repo | https://github.com/nickthelegend/mempire-arc (MIT) |
| Live app | `TODO: Vercel URL after deploy` |
| Demo video | `TODO` |

## Description (≤150 words)

Mempire turns the market into a card game on Arc. Every fighter — BTC, LINK, gold, the euro — is
priced by its Chainlink Data Feed on Arc, and each fighter's 24-hour move is computed on chain into a small buff or
nerf. Two players stake a dollar of USDC, play a three-minute lane battle where every card drop is a sub-second Arc
transaction from a per-match session key, and the arena pays the winner in the block both results land. Players
hold one token: USDC is the stake and the gas. Sign-in is a passkey. USDC on Base, Ethereum or Arbitrum works
too: Circle Gateway tops you up on Arc in a second, and from Base one transaction moves the dollar with CCTP while
Chainlink CCIP carries the instruction that opens your match. Stakes and payouts carry Arc Memo tags; the AI
opponent has an ERC-8004 identity.

## What it uses Arc for

- **USDC as gas and stake** — one token; the session key's gas float is an ERC-20 USDC transfer that is native gas.
- **Sub-second finality** — every card play is its own transaction; settlement in the second claim's block.
- **Chainlink Data Feeds on Arc** — every fighter's price, read in the mint; the daily meta computed on chain from feed history.
- **Chainlink CCIP + Circle CCTP V2** — enter or cash out from Base/Ethereum; defensive receiver on Arc.
- **Circle Gateway** — unified USDC balance, minted on Arc on demand.
- **Arc Memo** — stakes and payouts tagged with the match id.
- **ERC-8004** — the AI opponent's identity and player-written reputation.
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

- Arc testnet deployment is blocked on deployer funds (0 USDC); dry runs pass against live testnet and mainnet.
- Verified on local forks of Arc and Base mainnet (real USDC, Chainlink feeds, CCIP router, CCTP, Gateway, Memo,
  ERC-8004) and against Circle's live Gateway API; live CCIP sends are user-run (`scripts/ccip-send.mjs`, testnet).
- Arc testnet has no Chainlink feeds; the testnet deploy mirrors the mainnet feeds round-for-round (testnet only).
- The browser pass used guest accounts; the passkey PRF ceremony was not exercised in this port's browser test.
