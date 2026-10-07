#!/bin/sh
# Copies the compiled ABIs into shared/abi, where the app, relay and indexer read them.
set -e
cd "$(dirname "$0")"
forge build --silent
mkdir -p ../shared/abi
for c in MempireToken MempireCards MempireArena MarketMeta; do
  jq '.abi' "out/$c.sol/$c.json" > "../shared/abi/$c.json"
done
echo "exported $(ls ../shared/abi | wc -l | tr -d ' ') ABIs"
