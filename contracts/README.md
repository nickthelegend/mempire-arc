# Mempire contracts (Arc)

Foundry, Solidity 0.8.28. Built and tested with Circle's [Arc Foundry](https://docs.arc.io/arc/tutorials/install-arc-foundry)
(`--network arc` handles Arc's native USDC and its predeploys).

| Contract | What it does |
|---|---|
| `MempireArena` | Escrowed 1v1 pots in USDC (Arc's ERC-20 at `0x3600…0000`, 6 decimals) on four fixed tiers ($1/$5/$25/$100); stake + session-key gas float pulled by one EIP-2612 permit (the float is forwarded as ERC-20 USDC, which on Arc *is* the key's gas); per-match session keys; the on-chain play log; two-claim settlement (90/10, disputes void, a lone claim stands after the deadline). Owner limits for real money: `maxTier` (mainnet opens $1/$5) and a pause that only stops *new* matches. `createMatchFor`/`joinMatchFor` let the CCIP gateway seat a player on their own instruction. |
| `MempireCards` | Every fighter an ERC-721. `mint` reads the fighter's **Chainlink Data Feed** (`latestRoundData`: answer > 0, complete round, fresh within heartbeat + grace) and stamps the card with it; fee in USDC by permit (capped at $5). Merge, chests, starter decks. |
| `MarketMeta` | The daily buff/nerf. `postFromFeeds` computes each fighter's 24 h move on chain from its Chainlink feed: the latest round against the round that was current 24 h ago (the caller names it; the contract proves it is exactly that round). bps = clamp(move × 0.4, ±15%). On Arc testnet a Chainlink CRE report (`onReport`) can write instead. |
| `ccip/MempireCCIPGateway` | Arc side of cross-chain play: a defensive Chainlink CCIP receiver (allowlisted source selector + sender, try/catch, failed messages stored by hash and retryable by anyone). `ENTER` opens/joins a match for the player; `CASH_OUT` sends their USDC home with CCTP V2. |
| `ccip/MempireRemoteEntry` | Base / Ethereum side: one transaction burns USDC with CCTP V2 Fast Transfer to the player's own address on Arc and `ccipSend`s the instruction; CCIP fee in native, excess refunded; no admin. |
| `testnet/MirrorAggregator` | Arc testnet only (Chainlink serves Arc mainnet): a round-for-round copy of a mainnet feed so testnet runs mainnet's code paths. Refused by the deploy script on 5042. |
| `MempireToken` | $MEMPIRE, fixed supply. |

```bash
npm ci --ignore-scripts                     # Chainlink CCIP 2.0, Data Feeds interfaces, Chainlink Local
forge test --no-match-path 'test/fork/*'    # 71 unit tests
FORK_TESTS=1 forge test --network arc --match-path 'test/fork/*'   # 7 tests on Arc + Base mainnet forks
```

Unit tests run Circle's FiatToken v2.2 bytecode at Arc's USDC address with Arc's EIP-712 domain (`USDC` / `2`),
Chainlink Local's `MockV3Aggregator` for feeds and `CCIPLocalSimulator` for CCIP. The fork tests use the real
Arc mainnet USDC, Chainlink feeds, CCIP router, Memo, Gateway and ERC-8004 registries, and the real Base → Arc
CCIP lane and CCTP — on local forks, nothing broadcast.

Deploy: `sh ../scripts/deploy.sh testnet|mainnet` (see `../MAINNET.md`).
