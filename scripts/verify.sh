#!/bin/sh
# Verify the deployed contracts on the Arc explorer (Blockscout).
#   sh scripts/verify.sh testnet|mainnet
set -e
cd "$(dirname "$0")/.."
NETWORK=${1:-testnet}
FORGE=${ARC_FORGE:-forge}
case "$NETWORK" in
  testnet) CHAIN=5042002; URL=https://explorer.testnet.arc.io/api/ ;;
  mainnet) CHAIN=5042; URL=https://explorer.arc.io/api/ ;;
esac
D=deployments/arc-$NETWORK.json
v() { (cd contracts && "$FORGE" verify-contract --chain "$CHAIN" --verifier blockscout --verifier-url "$URL" --watch "$@") || echo "verify failed: $2"; }
get() { node -e "console.log(require('./$D').$1)"; }
v "$(get token)" src/MempireToken.sol:MempireToken
v "$(get cards)" src/MempireCards.sol:MempireCards
v "$(get marketMeta)" src/MarketMeta.sol:MarketMeta
v "$(get arena)" src/MempireArena.sol:MempireArena
[ "$(get ccipGateway)" = 0x0000000000000000000000000000000000000000 ] || v "$(get ccipGateway)" src/ccip/MempireCCIPGateway.sol:MempireCCIPGateway
