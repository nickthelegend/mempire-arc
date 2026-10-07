#!/usr/bin/env bash
# The whole game locally, for real, on a fork of Arc MAINNET (nothing is ever broadcast to it):
#   - arc-anvil (Circle's Arc Foundry, --network arc: Arc's native USDC, Memo/CallFrom precompile)
#     forking Arc mainnet on :8710, chain id 31337 — Arc's real USDC, Chainlink's real Data
#     Feeds, Chainlink's real CCIP router, Circle's CCTP and Gateway contracts are all there
#   - our contracts deployed with real signed transactions (DeployLocal, dev keys at mnemonic index 7100+)
#   - MongoDB on :27019 if mongod is installed (else the relay's in-memory store)
#   - the relay on :8799 (keeper posting the Chainlink-feed meta, ccip-watch), app on :5191
#
#   ARC_ANVIL=…/arc-anvil ARC_FORGE=…/forge ARC_CAST=…/cast ./scripts/local-up.sh
#   ./scripts/local-up.sh --no-relay     # chain + contracts only
#   ./scripts/local-down.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.local"; mkdir -p "$RUN/mongo"
ANVIL=${ARC_ANVIL:-arc-anvil}; FORGE=${ARC_FORGE:-forge}; CAST=${ARC_CAST:-cast}
RPC=http://127.0.0.1:8710
FORK_URL="${FORK_URL:-https://rpc.mainnet.arc.io}"
MNEMONIC="test test test test test test test test test test test junk"
devkey() { "$CAST" wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index $((7100 + $1)); }
devaddr() { "$CAST" wallet address --mnemonic "$MNEMONIC" --mnemonic-index $((7100 + $1)); }

if ! "$CAST" chain-id --rpc-url $RPC >/dev/null 2>&1; then
  # --block-time 1: an empty block every second, as a live chain does, so timers that read
  # block.timestamp (chests, timeouts, feed freshness) move.
  "$ANVIL" --network arc --port 8710 --chain-id 31337 --fork-url "$FORK_URL" --silent \
    --block-time 1 --prune-history 300 --retries 10 --timeout 60000 >"$RUN/anvil.log" 2>&1 </dev/null &
  echo $! >"$RUN/anvil.pid"
  for _ in $(seq 120); do "$CAST" chain-id --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done
fi
for i in 0 1 2 3 4; do
  a=$(devaddr $i)
  "$CAST" rpc anvil_setCode "$a" 0x --rpc-url $RPC >/dev/null
  "$CAST" rpc anvil_setBalance "$a" 0x21e19e0c9bab2400000 --rpc-url $RPC >/dev/null # 10,000 USDC
done
echo "arc-anvil $RPC (fork of Arc mainnet, chain $("$CAST" chain-id --rpc-url $RPC))"

if [ ! -f "$ROOT/shared/deployments/31337.json" ] || [ "$("$CAST" code "$(jq -r .arena "$ROOT/shared/deployments/31337.json")" --rpc-url $RPC)" = 0x ]; then
  (cd "$ROOT/contracts" && "$FORGE" script script/DeployLocal.s.sol --network arc --rpc-url $RPC --broadcast --silent >/dev/null)
fi
PATH="$(dirname "$FORGE"):$PATH" sh "$ROOT/contracts/export-abi.sh" >/dev/null
node "$ROOT/app/scripts/sync-shared.mjs" >/dev/null
(cd "$ROOT/server" && node sync-shared.mjs >/dev/null)
(cd "$ROOT/indexer" && node scripts/sync-addresses.mjs --chain 31337 >/dev/null 2>&1 || true)
echo "contracts → shared/deployments/31337.json"
[ "${1:-}" = "--no-relay" ] && exit 0

MONGO=""
if command -v mongod >/dev/null; then
  lsof -iTCP:27019 -sTCP:LISTEN >/dev/null 2>&1 || { mongod --port 27019 --bind_ip 127.0.0.1 --dbpath "$RUN/mongo" --logpath "$RUN/mongo.log" --fork >/dev/null; lsof -ti tcp:27019 -sTCP:LISTEN | head -1 >"$RUN/mongo.pid"; }
  MONGO="mongodb://127.0.0.1:27019"; echo "mongo  $MONGO"
fi
DB="mempire_local_$(jq -r .startBlock "$ROOT/shared/deployments/31337.json")"
if ! lsof -iTCP:8799 -sTCP:LISTEN >/dev/null 2>&1; then
  (cd "$ROOT/server" && exec >/dev/null && CHAIN_ID=31337 RPC_URL=$RPC PORT=8799 PUBLIC_APP_URL=http://localhost:5191 \
    MONGODB_URI="$MONGO" MONGODB_DB="$DB" RELAYER_PRIVATE_KEY="$(devkey 1)" META_KEEPER_EVERY=1 \
    exec nohup node index.js >"$RUN/relay.log" 2>&1 </dev/null) &
  echo $! >"$RUN/relay.pid"
  for _ in $(seq 240); do curl -sf localhost:8799/api/health >/dev/null && break; sleep 0.5; done
fi
echo "relay  http://localhost:8799"
if ! lsof -iTCP:5191 -sTCP:LISTEN >/dev/null 2>&1; then
  (cd "$ROOT/app" && exec >/dev/null && VITE_CHAIN_ID=31337 VITE_API_URL=http://localhost:8799 VITE_RPC_URL=$RPC \
    exec nohup node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5191 >"$RUN/vite.log" 2>&1 </dev/null) &
  echo $! >"$RUN/vite.pid"
  for _ in $(seq 120); do curl -sf localhost:5191 >/dev/null && break; sleep 0.5; done
fi
echo "app    http://localhost:5191"
