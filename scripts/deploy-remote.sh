#!/bin/sh
# Deploy MempireRemoteEntry on a source chain (the Base / Ethereum side of cross-chain play),
# pointing at the MempireCCIPGateway on Arc, and print the owner call that allowlists it.
#
#   sh scripts/deploy-remote.sh base-sepolia|sepolia         # testnet lanes to Arc testnet
#   CONFIRM_MAINNET=yes sh scripts/deploy-remote.sh base|ethereum   # mainnet lanes to Arc mainnet
#
# Needs the deployer funded in the source chain's native token (ETH). User-run.
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
FORGE=${ARC_FORGE:-forge}
case "$1" in
  base-sepolia) RPC=${SRC_RPC:-https://sepolia.base.org}; ROUTER=0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93; USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e; TM=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA; DOMAIN=6; ARC=5042002; SEL=3034092155422581607; SRCSEL=10344971235874465080 ;;
  sepolia) RPC=${SRC_RPC:-https://ethereum-sepolia-rpc.publicnode.com}; ROUTER=0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59; USDC=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238; TM=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA; DOMAIN=0; ARC=5042002; SEL=3034092155422581607; SRCSEL=16015286601757825753 ;;
  base) RPC=${SRC_RPC:-https://mainnet.base.org}; ROUTER=0x881e3A65B4d4a04dD529061dd0071cf975F58bCD; USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; TM=0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d; DOMAIN=6; ARC=5042; SEL=6370580034781731079; SRCSEL=15971525489660198786 ;;
  ethereum) RPC=${SRC_RPC:-https://ethereum-rpc.publicnode.com}; ROUTER=0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D; USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; TM=0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d; DOMAIN=0; ARC=5042; SEL=6370580034781731079; SRCSEL=5009297550715157269 ;;
  *) echo "usage: sh scripts/deploy-remote.sh base-sepolia|sepolia|base|ethereum"; exit 1 ;;
esac
case "$1" in base|ethereum) [ "$CONFIRM_MAINNET" = yes ] || { echo "mainnet: re-run with CONFIRM_MAINNET=yes"; exit 1; } ;; esac
D=shared/deployments/$ARC.json
GATEWAY=$(node -e "console.log(require('./$D').ccipGateway)")
[ -n "$GATEWAY" ] && [ "$GATEWAY" != 0x0000000000000000000000000000000000000000 ] || { echo "no ccipGateway in $D — deploy Arc first"; exit 1; }
set -a; . "${DEPLOYER_ENV:-$ROOT/../.deployer/deployer.env}"; set +a
LOCK="$ROOT/../.deployer/lock"; until mkdir "$LOCK" 2>/dev/null; do sleep 3; done; trap 'rmdir "$LOCK"' EXIT
OUT=$(cd contracts && "$FORGE" create src/ccip/MempireRemoteEntry.sol:MempireRemoteEntry --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast \
  --constructor-args "$ROUTER" "$SEL" "$GATEWAY" "$USDC" "$TM" 2>&1)
rmdir "$LOCK"; trap - EXIT
ENTRY=$(echo "$OUT" | sed -n 's/^Deployed to: //p')
echo "MempireRemoteEntry on $1: $ENTRY"
echo "Now allowlist it on Arc (owner of the gateway):"
echo "  cast send $GATEWAY 'setRemoteEntry(uint64,address,uint32)' $SRCSEL $ENTRY $DOMAIN --rpc-url <arc rpc> --private-key <owner>"
echo "and set VITE_REMOTE_ENTRY_$( [ "$DOMAIN" = 6 ] && echo BASE || echo ETHEREUM )=$ENTRY for the app."
