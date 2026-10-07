# Going live on Monad testnet: the runbook

Everything below is **on hold until the user funds the keys and says go**.
Until then nothing touches Monad testnet, and nothing is hosted. The order
matters. Budget: about 50 minutes, plus waiting on the user for steps 1 and 9.

Rule for every step: **the user's secrets go into hosting dashboards by the
user**, never into git, a chat or a script. The deployer key never leaves this
machine.

| # | Step | Who | Time |
|---|---|---|---|
| 0 | Preconditions | user | 5 min |
| 1 | Fund the two keys | user | 2 min |
| 2 | Reserve the relay's URL on Railway | user / Claude | 3 min |
| 3 | Deploy and verify the contracts | Claude | 5 min |
| 4 | Commit the addresses | Claude | 2 min |
| 5 | Host the relay on Railway | user sets secrets | 8 min |
| 6 | Indexer on Envio Cloud | user / Claude | 8 min |
| 7 | Host the app on Vercel | user sets env | 5 min |
| 8 | Chainlink CRE simulate --broadcast | user logs in | 5 min |
| 9 | Privy dashboard | user | 5 min |
| 10 | Smoke test | Claude + user | 5 min |
| 11 | Record the video | user | — |

---

## 0. Preconditions

- The portal registration exists. Pick the track (recommendation: **03 Social, Attention & Culture**, see SUBMISSION.md) and the community supporter field.
- Accounts: Railway, Vercel, MongoDB Atlas (free M0 is enough), Envio, a Pyth Hermes key, and optionally Privy, Moonshot and CRE.
- On this machine, check that the keys exist and print **addresses only**:

  ```bash
  for k in deployer relayer; do node -e "const j=require('./keys/$k.json'); console.log('$k', (j[0]||j).address)"; done
  ```

## 1. Fund the two keys (the user)

| Key | Address | Send | Why |
|---|---|---|---|
| deployer (owner) | `0x81e43BBd1Fb657819E425b5A3bdf2d97d5AA7a96` | **2.5 MON** | 10 deploy transactions, 18.0M gas limit × ~102 gwei ≈ 1.84 MON, plus the CRE `--broadcast` |
| relayer | `0x91c8B2ccDd9f8f13065658e8E60E71916B0593aD` | **15 MON** | About 0.39 MON per new player: the starter mint (≈ 1.23M gas limit ≈ 0.13 MON), the **0.25 MON drip** (enough for a first staked match: a 0.2 MON session float, swept back to the player, plus the stake tx), and the faucet call. So ~25 onboards ≈ 10 MON. Plus the meta keeper at `META_KEEPER_EVERY=36`, ≈ 0.7 MON/day for a week. |

Monad bills the **gas limit**, not the gas used; these figures already account for that. Check the balances (read-only):

```bash
cast balance 0x81e43BBd1Fb657819E425b5A3bdf2d97d5AA7a96 --ether --rpc-url https://testnet-rpc.monad.xyz
cast balance 0x91c8B2ccDd9f8f13065658e8E60E71916B0593aD --ether --rpc-url https://testnet-rpc.monad.xyz
```

Then the user says **go**.

## 2. Reserve the relay's URL

Create the Railway service from this repo: root directory `server/`. `railway.json` builds the Dockerfile and health-checks `/api/health`. Generate a domain, e.g. `https://mempire-monad-relay.up.railway.app`. The contracts need it for NFT metadata, so it comes first. Don't deploy yet: without env vars the relay would boot with nothing to serve.

## 3. Deploy and verify

```bash
METADATA_BASE_URI=https://<relay-domain>/nft/ ./scripts/deploy-testnet.sh
```

The script:
- reads both keys from `keys/` without printing them;
- deploys `MempireToken`, `MempireCards`, `MarketMeta` and `MempireArena` against **real Pyth** `0x2880…7B43`, **real AUSD** `0xa901…22dC`, the faucet `0xd236…e6C` and the CRE simulation forwarder `0xB9F7…D192`;
- registers the 36-coin roster and funds the win-reward pool;
- verifies everything on **Sourcify** (MonadVision);
- writes `shared/deployments/10143.json` and syncs the ABIs and addresses into `app/`, `server/` and `indexer/`.

Check: every contract page on `https://testnet.monadvision.com/address/<addr>` shows "verified".

If the base URI was wrong, the owner can call `MempireCards.setBaseURI(string)`; no redeploy is needed.

## 4. Commit the addresses

```bash
git add shared/deployments/10143.json app/src/shared server/shared indexer/config.yaml indexer/abis
git commit -m "deploy: Monad testnet addresses"
git push
```

Then fill the addresses into the README's "Deployed addresses" table and the `TODO`s in SUBMISSION.md.

## 5. Relay on Railway

The user sets these in the Railway dashboard (Variables). Secrets are marked ●.

| Variable | Value |
|---|---|
| `CHAIN_ID` | `10143` |
| `RPC_URL` | `https://testnet-rpc.monad.xyz` (or an Alchemy Monad URL) |
| ● `RELAYER_PRIVATE_KEY` | the relayer key from `keys/relayer.json`. The relay refuses an owner key. |
| ● `MONGODB_URI` | the Atlas connection string; `MONGODB_DB=mempire` |
| `AUSD_FAUCET` | `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C` |
| `CORS_ORIGIN`, `PUBLIC_APP_URL` | the Vercel URL from step 7 (update after step 7) |
| ● `PYTH_API_KEY` | the Hermes key. Without it, minting answers "no live price". |
| `META_KEEPER`, `META_KEEPER_EVERY` | `1` and `36`. Set `META_KEEPER=0` if CRE (step 8) is the meta's writer. |
| ● `MOONSHOT_API_KEY` | optional: enables "vs Kimi" and the caster |
| ● `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY`, `PRIVY_SIGNER_ID` | optional: enables email sign-in (step 9) |

Do **not** set `ORACLE_PRIVATE_KEY`. It is for the local chain only, and the relay ignores it on 10143.

Deploy, then run `curl https://<relay>/api/health`. Expect:
- `persistent: true`;
- `chain.chainId: 10143`, `deployment: true`;
- `pyth: "hermes"`;
- the relayer address equal to `0x91c8…93aD`.

## 6. Indexer on Envio Cloud

1. In `indexer/config.yaml`, check that `start_block` was set from `shared/deployments/10143.json` (`startBlock`) by the sync in step 3. Push.
2. Envio dashboard → new indexer → this repo, directory `indexer/`, config `config.yaml`. Monad testnet uses native HyperSync, so no RPC key is needed.
3. Wait for it to sync, and copy the GraphQL URL.

## 7. App on Vercel

Import the repo with root directory `app/`. `vercel.json` sets the build and SPA rewrites. Environment:

| Variable | Value |
|---|---|
| `VITE_CHAIN_ID` | `10143` |
| `VITE_API_URL` | the Railway relay URL |
| `VITE_INDEXER_URL` | the Envio GraphQL URL (step 6) |
| `VITE_PRIVY_APP_ID` | optional: the Privy app id (step 9) |
| `VITE_RPC_URL` | optional: an Alchemy Monad URL |

Deploy. Then put the Vercel URL into Railway's `CORS_ORIGIN` and `PUBLIC_APP_URL` and redeploy the relay.

## 8. Chainlink CRE (bounty proof)

```bash
cd cre && cre login && cre whoami
# put marketMeta from shared/deployments/10143.json into market-meta/config.staging.json
CRE_ETH_PRIVATE_KEY=<deployer key, in this shell only> \
  cre workflow simulate market-meta --target staging-settings --non-interactive --trigger-index 0 --broadcast
```

Keep the `MetaPosted` / `MetaSource(source=0)` transaction hash for SUBMISSION.md. The forwarder deployed in step 3 is the simulator's `MockKeystoneForwarder`, which is what `--broadcast` writes through.

## 9. Privy (the user, optional but a bounty)

Privy dashboard:
1. Create the app and copy the app id and secret.
2. Enable **Monad Testnet** under gas sponsorship, add credits, and enable TEE execution.
3. Create an authorization key (P-256). Register it as a key quorum and copy its id (`PRIVY_SIGNER_ID`). Base64 the PKCS8 private key into `PRIVY_AUTHORIZATION_KEY`.
4. Allowed origins: the Vercel URL.

The relay creates the policy `mempire-match-actions` at boot: default deny; only arena `play`/`checkpoint`/`claim`, value 0, chain 10143. `GET /api/privy/config` should then say `mode: "privy"`.

## 10. Smoke test (5 min, two browsers)

1. Open the Vercel URL and choose **Play now → Create with passkey**. One prompt. The starter deck lands, and Empire shows 8 cards, AUSD and MON.
2. On the Cards screen, prices are live (Pyth) and the ▲▼ meta is showing. Mint one card: the tx is on MonadVision and the card records its mint price.
3. In a second browser, **Play as Guest**. Both pick Arena → **$ AUSD** → Pauper and are matched.
4. Play to the end. The badge counts on-chain plays. The result shows the pot settled ($1.80 to the winner) and a chest.
5. Open the chest (start the unlock, then open, then reveal) and the cards appear.
6. On **Live on Monad**, the Envio feed shows the plays and the leaderboard shows the win.
7. `curl <relay>/api/health`: the keeper's `epoch` and `hash` are set (or the CRE tx from step 8 is there).

Record the match id, a play tx and the settle tx in SUBMISSION.md → *Verifiable evidence*.

## 11. Video shot list (≤ 3 min; script with timestamps in SUBMISSION.md)

1. The Cards screen: live prices, the ▲▼ meta badges, the MarketBoard gutters.
2. A fresh browser: passkey sign-up, then the starter deck landing with its timing.
3. Two windows side by side: the $1 AUSD stake (one transaction, with the permit) and the match.
4. Close-up on the play badge (*on Monad · n · 0.6s*), then one play opened on MonadVision.
5. The result: pot paid, chest, $MEMPIRE.
6. The chest reveal, then the merge.
7. The card sheet's meta line, then the CRE simulate output and its tx.
8. Stateless: clear site data, sign in with the same passkey, same account. The locker opens.
9. The Live on Monad feed.
