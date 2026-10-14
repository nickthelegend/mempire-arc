#!/bin/sh
# Deploy Mempire to Arc.
#
#   sh scripts/deploy.sh testnet                         # Arc testnet (5042002)
#   CONFIRM_MAINNET=yes ADMIN=0x… TREASURY=0x… RELAYER=0x… PUBLIC_API_URL=https://… \
#     sh scripts/deploy.sh mainnet                        # Arc mainnet (5042) — see MAINNET.md
#   DRY_RUN=1 sh scripts/deploy.sh testnet|mainnet        # simulate against the live chain, broadcast nothing
#   VERIFY=1 …                                            # verify every contract on the Arc explorer (Blockscout)
#
# One Foundry script (contracts/script/Deploy.s.sol) for both networks. Per network:
#   testnet: Chainlink feeds are mirrored (Chainlink serves Arc mainnet only), CCIP router 0xdE4E…eab8,
#            CCTP TokenMessengerV2 0x8FE6…2DAA, CRE simulation forwarder, all four stake tiers, chest timers ÷60.
#   mainnet: Chainlink's own Arc feed proxies, CCIP router 0xB797…3A18, CCTP 0x28b5…cf5d, no CRE,
#            stakes capped at $1/$5 (MAX_TIER=1), real-time chest timers, ownership offered to ADMIN (a Safe).
#
# The deployer key is never stored in this repo: it is read from DEPLOYER_ENV (default
# ../.deployer/deployer.env, defining DEPLOYER_PRIVATE_KEY) inside this process only. The broadcast
# holds the shared deployer lock so parallel deploys from that wallet never collide on nonces.
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
NETWORK=${1:-${NETWORK:-testnet}}
FORGE=${ARC_FORGE:-forge}
CAST=${ARC_CAST:-cast}
case "$NETWORK" in
  testnet)
    RPC=${ARC_TESTNET_RPC_URL:-https://rpc.testnet.arc.io}; CHAIN=5042002; OUT=deployments/arc-testnet.json
    EXPLORER=https://explorer.testnet.arc.io
    : "${CCIP_ROUTER:=0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8}"
    : "${TOKEN_MESSENGER:=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA}"
    : "${CRE_FORWARDER:=0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1}"
    : "${MAX_TIER:=3}"; : "${TIME_SCALE:=60}" ;;
  mainnet)
    RPC=${ARC_MAINNET_RPC_URL:-https://rpc.mainnet.arc.io}; CHAIN=5042; OUT=deployments/arc-mainnet.json
    EXPLORER=https://explorer.arc.io
    : "${CCIP_ROUTER:=0xB79791184973589c38e114D43Eb8E4588C283A18}"
    : "${TOKEN_MESSENGER:=0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d}"
    CRE_FORWARDER=0x0000000000000000000000000000000000000000
    : "${MAX_TIER:=1}"; : "${TIME_SCALE:=1}" ;;
  *) echo "usage: sh scripts/deploy.sh testnet|mainnet"; exit 1 ;;
esac
command -v "$FORGE" >/dev/null || [ -x "$FORGE" ] || { echo "missing: forge (Arc Foundry: https://docs.arc.io/arc/tutorials/install-arc-foundry)"; exit 1; }
[ -d contracts/node_modules/@chainlink/contracts-ccip ] || (cd contracts && npm ci --no-audit --no-fund --ignore-scripts)
[ "$("$CAST" chain-id --rpc-url "$RPC")" = "$CHAIN" ] || { echo "$RPC is not chain $CHAIN"; exit 1; }

val() { [ -f server/.env.local ] && grep "^$1=" server/.env.local | tail -1 | cut -d= -f2- || true; }
RELAYER=${RELAYER:-$(val RELAYER_ADDRESS)}
PUBLIC_API_URL=${PUBLIC_API_URL:-$(val PUBLIC_API_URL)}
PUBLIC_API_URL=${PUBLIC_API_URL:-http://localhost:8787}
[ -n "$RELAYER" ] || { echo "Set RELAYER (the relay key's address), or run scripts/testnet-setup.sh first."; exit 1; }

if [ "$NETWORK" = mainnet ]; then
  for v in ADMIN TREASURY; do eval "[ -n \"\$$v\" ]" || { echo "mainnet needs $v (see MAINNET.md)"; exit 1; }; done
  case "$PUBLIC_API_URL" in *localhost*|*127.0.0.1*) echo "mainnet needs PUBLIC_API_URL (the hosted relay's origin)"; exit 1 ;; esac
  [ -n "$DRY_RUN" ] || [ "$CONFIRM_MAINNET" = yes ] || { echo "Mainnet holds real money. Re-run with CONFIRM_MAINNET=yes."; exit 1; }
fi

DEPLOYER_ENV=${DEPLOYER_ENV:-$ROOT/../.deployer/deployer.env}
[ -f "$DEPLOYER_ENV" ] || { echo "No deployer key file at $DEPLOYER_ENV (set DEPLOYER_ENV)."; exit 1; }
set -a; . "$DEPLOYER_ENV"; set +a
[ -n "$DEPLOYER_PRIVATE_KEY" ] || { echo "$DEPLOYER_ENV doesn't define DEPLOYER_PRIVATE_KEY"; exit 1; }

export RELAYER CCIP_ROUTER TOKEN_MESSENGER CRE_FORWARDER MAX_TIER TIME_SCALE ADMIN TREASURY
export METADATA_BASE_URI="$PUBLIC_API_URL/nft/" ADDRESSES_OUT="$ROOT/shared/deployments/$CHAIN.json.pending"
cd contracts
run() { DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" "$FORGE" script script/Deploy.s.sol --network arc --rpc-url "$RPC" --slow "$@"; }
if [ -n "$DRY_RUN" ]; then ADDRESSES_OUT=none run; exit 0; fi

LOCK="${DEPLOY_LOCK:-$ROOT/../.deployer/lock}"
until mkdir "$LOCK" 2>/dev/null; do echo "waiting for the deployer lock…"; sleep 3; done
trap 'rmdir "$LOCK" 2>/dev/null; rm -f "$ADDRESSES_OUT"' EXIT
run --broadcast
rmdir "$LOCK"; trap - EXIT
cd "$ROOT"
mv "$ADDRESSES_OUT" "shared/deployments/$CHAIN.json"
# Record what the deploy cost and its transactions next to the addresses.
node -e '
const fs = require("fs");
const [src, out, log, net] = process.argv.slice(1);
const d = JSON.parse(fs.readFileSync(src, "utf8"));
const b = JSON.parse(fs.readFileSync(log, "utf8"));
let gas = 0n, wei = 0n;
for (const r of b.receipts) { gas += BigInt(r.gasUsed); wei += BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice); }
d.network = net;
d.deployGas = { transactions: b.receipts.length, gasUsed: gas.toString(), usdc: (Number(wei) / 1e18).toFixed(6) };
d.deployTxs = b.receipts.map((r) => r.transactionHash);
fs.writeFileSync(src, JSON.stringify(d, null, 2) + "\n");
fs.writeFileSync(out, JSON.stringify(d, null, 2) + "\n");
console.log(`deploy: ${b.receipts.length} txs, ${gas} gas, ${d.deployGas.usdc} USDC`);
' "shared/deployments/$CHAIN.json" "$OUT" "contracts/broadcast/Deploy.s.sol/$CHAIN/run-latest.json" "arc-$NETWORK"
sh contracts/export-abi.sh >/dev/null 2>&1 || true
node app/scripts/sync-shared.mjs >/dev/null
(cd server && node sync-shared.mjs >/dev/null)
(cd indexer && node scripts/sync-addresses.mjs --chain "$CHAIN" >/dev/null 2>&1 || echo "indexer: sync addresses by hand")
echo "addresses: $OUT (also shared/deployments/$CHAIN.json, synced to app/server/indexer)"
if [ -n "$VERIFY" ]; then sh scripts/verify.sh "$NETWORK"; fi
echo "explorer: $EXPLORER/address/$(node -e "console.log(require('./$OUT').arena)")"
