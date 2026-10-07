#!/usr/bin/env bash
# Deploy the four contracts to Monad testnet, register the roster, fund the
# reward pool, verify everything on Sourcify, and fan the addresses out to the
# app, relay and indexer.
#
#   ./scripts/deploy-testnet.sh
#
# Reads the deployer and relayer keys from keys/ (gitignored). Never prints a key.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${RPC_URL:-https://testnet-rpc.monad.xyz}"
SOURCIFY="${SOURCIFY_URL:-https://sourcify-api-monad.blockvision.org/}"

key() { node -e "const j=require('$ROOT/keys/$1.json'); process.stdout.write((j[0]||j).private_key)"; }
addr() { node -e "const j=require('$ROOT/keys/$1.json'); process.stdout.write((j[0]||j).address)"; }

DEPLOYER_PRIVATE_KEY="$(key deployer)"
RELAYER="$(addr relayer)"
DEPLOYER="$(addr deployer)"
echo "deployer $DEPLOYER — $(cast balance "$DEPLOYER" --ether --rpc-url "$RPC") MON"
echo "relayer  $RELAYER — $(cast balance "$RELAYER" --ether --rpc-url "$RPC") MON"

cd "$ROOT/contracts"
DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
RELAYER="$RELAYER" \
PYTH="0x2880aB155794e7179c9eE2e38200202908C17B43" \
AUSD="0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC" \
CRE_FORWARDER="${CRE_FORWARDER:-0xB9F79d863261869B234c481D1f9A7af84AeAd192}" \
METADATA_BASE_URI="${METADATA_BASE_URI:-https://mempire-monad-relay.up.railway.app/nft/}" \
TIME_SCALE="${TIME_SCALE:-60}" \
forge script script/Deploy.s.sol \
  --rpc-url "$RPC" --broadcast --slow \
  --verify --verifier sourcify --verifier-url "$SOURCIFY"

cd "$ROOT"
./contracts/export-abi.sh
node app/scripts/sync-shared.mjs
(cd server && npm run --silent sync-shared 2>/dev/null || true)
(cd indexer && node scripts/sync-addresses.mjs 2>/dev/null || true)
echo
cat shared/deployments/10143.json
