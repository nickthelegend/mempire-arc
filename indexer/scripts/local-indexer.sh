#!/usr/bin/env bash
# The indexer against the LOCAL anvil chain (scripts/local-up.sh), with its own
# Postgres and Hasura — nothing hosted, no HyperSync, no API token.
#
#   ./scripts/local-indexer.sh up       # Postgres :5435, Hasura :8090, envio dev on config.local.yaml
#   ./scripts/local-indexer.sh status
#   ./scripts/local-indexer.sh logs     # tail the indexer log
#   ./scripts/local-indexer.sh down     # stop the indexer, remove both containers, restore testnet codegen
#
# GraphQL: http://localhost:8090/v1/graphql   (public role; admin secret "testing")
#
# Why not plain `envio dev`: Envio 3.13 creates its Docker resources under fixed
# global names (envio-postgres, envio-hasura, envio-network) on :5433/:8080, so
# on a machine where another project already runs them, `envio dev` would attach
# to that project's database and replace its Hasura table tracking — and
# `envio stop` would delete them. This script starts its own containers under
# mempire-* names first; `envio dev` then finds Postgres (ENVIO_PG_HOST/PORT)
# and Hasura (HASURA_EXTERNAL_PORT) already running and only runs the indexer.
# Never run `envio stop` here: it removes the envio-* containers by name.
#
# Ports and names can be overridden from the environment (see the defaults below).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RUN="$HERE/.local"
mkdir -p "$RUN"

PG_PORT="${MEMPIRE_PG_PORT:-5435}"
HASURA_PORT="${MEMPIRE_HASURA_PORT:-8090}"
INDEXER_PORT="${MEMPIRE_INDEXER_PORT:-9911}"
RPC="${MEMPIRE_RPC:-http://127.0.0.1:8612}"
NET=mempire-envio-net
PG=mempire-envio-postgres
HASURA=mempire-envio-hasura
SECRET=testing
CONFIG=config.local.yaml

listening() { lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
ours() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

envio_env() {
  export ENVIO_CONFIG="$CONFIG"
  export ENVIO_PG_HOST=127.0.0.1 ENVIO_PG_PORT="$PG_PORT" ENVIO_PG_USER=postgres
  export ENVIO_PG_PASSWORD="$SECRET" ENVIO_PG_DATABASE=envio-dev
  export HASURA_EXTERNAL_PORT="$HASURA_PORT"
  export HASURA_GRAPHQL_ENDPOINT="http://localhost:$HASURA_PORT/v1/metadata"
  export HASURA_GRAPHQL_ADMIN_SECRET="$SECRET"
  export ENVIO_INDEXER_PORT="$INDEXER_PORT"
  export ENVIO_TUI=false LOG_LEVEL="${LOG_LEVEL:-info}"
}

kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

up() {
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 \
    || { echo "anvil is not reachable at $RPC — run scripts/local-up.sh --relay from the repo root"; exit 1; }

  # Addresses and start block: config.local.yaml must match the live
  # deployment. A redeploy can land at the same addresses (same deployer, same
  # nonce) on a fresh fork, so the start block is checked too.
  local dep="$ROOT/shared/deployments/31337.json" key addr
  for key in cards arena marketMeta startBlock; do
    addr=$(node -e "process.stdout.write(String(require('$dep').$key))")
    if ! grep -q "$addr" "$HERE/$CONFIG"; then
      echo "config.local.yaml is behind $dep — syncing"
      (cd "$HERE" && node scripts/sync-addresses.mjs --chain 31337 --config "$CONFIG")
      break
    fi
  done

  if [ -f "$RUN/envio.pid" ] && kill -0 "$(cat "$RUN/envio.pid")" 2>/dev/null; then
    echo "indexer already running (pid $(cat "$RUN/envio.pid"))"; status; return
  fi

  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

  if ! ours "$PG"; then
    listening "$PG_PORT" && { echo "port $PG_PORT is taken by something else"; exit 1; }
    docker rm -f -v "$PG" >/dev/null 2>&1 || true
    docker run -d --name "$PG" --network "$NET" -p "$PG_PORT:5432" \
      -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$SECRET" -e POSTGRES_DB=envio-dev \
      postgres:18.3 >/dev/null
  fi
  for _ in $(seq 60); do docker exec "$PG" pg_isready -U postgres -d envio-dev >/dev/null 2>&1 && break; sleep 0.5; done
  echo "postgres  127.0.0.1:$PG_PORT  ($PG)"

  if ! ours "$HASURA"; then
    listening "$HASURA_PORT" && { echo "port $HASURA_PORT is taken by something else"; exit 1; }
    docker rm -f -v "$HASURA" >/dev/null 2>&1 || true
    # The same settings envio dev gives its own Hasura.
    docker run -d --name "$HASURA" --network "$NET" -p "$HASURA_PORT:8080" \
      -e HASURA_GRAPHQL_DATABASE_URL="postgres://postgres:$SECRET@$PG:5432/envio-dev" \
      -e HASURA_GRAPHQL_ADMIN_SECRET="$SECRET" \
      -e HASURA_GRAPHQL_ENABLE_CONSOLE=true \
      -e HASURA_GRAPHQL_UNAUTHORIZED_ROLE=public \
      -e HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES=true \
      -e HASURA_GRAPHQL_NO_OF_RETRIES=10 \
      -e HASURA_GRAPHQL_CORS_DOMAIN='*' \
      -e HASURA_GRAPHQL_ENABLED_LOG_TYPES="startup, http-log, webhook-log, websocket-log, query-log" \
      hasura/graphql-engine:v2.43.0 >/dev/null
  fi
  for _ in $(seq 120); do curl -sf "http://localhost:$HASURA_PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -sf "http://localhost:$HASURA_PORT/healthz" >/dev/null || { echo "hasura did not come up: docker logs $HASURA"; exit 1; }
  echo "hasura    http://localhost:$HASURA_PORT  ($HASURA)"

  listening "$INDEXER_PORT" && { echo "indexer port $INDEXER_PORT is taken"; exit 1; }
  envio_env
  # -r: a fresh database every `up`; anvil state is the source of truth.
  (cd "$HERE" && exec nohup pnpm exec envio dev -r >"$RUN/envio.log" 2>&1 </dev/null) &
  echo $! >"$RUN/envio.pid"
  echo "indexer   pid $(cat "$RUN/envio.pid"), log $RUN/envio.log, metrics :$INDEXER_PORT"

  # Ready when Hasura serves the indexer's tables and chain_metadata shows a synced chain.
  local q='{"query":"{ chain_metadata { chain_id block_height latest_processed_block } }"}'
  for _ in $(seq 240); do
    if ! kill -0 "$(cat "$RUN/envio.pid")" 2>/dev/null; then echo "indexer exited — see $RUN/envio.log"; tail -30 "$RUN/envio.log"; exit 1; fi
    local out
    out=$(curl -s "http://localhost:$HASURA_PORT/v1/graphql" -H 'content-type: application/json' -d "$q" || true)
    if echo "$out" | grep -q '"latest_processed_block":[0-9]'; then
      echo "synced    $out"
      echo "graphql   http://localhost:$HASURA_PORT/v1/graphql"
      return
    fi
    sleep 1
  done
  echo "indexer did not report progress within 4 minutes — see $RUN/envio.log"; exit 1
}

down() {
  if [ -f "$RUN/envio.pid" ]; then
    kill_tree "$(cat "$RUN/envio.pid")"
    rm -f "$RUN/envio.pid"
    echo "indexer stopped"
  fi
  # Our containers only — never `envio stop`, which deletes the envio-* ones by name.
  docker rm -f -v "$HASURA" "$PG" >/dev/null 2>&1 && echo "removed $HASURA, $PG" || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # envio dev generated types for config.local.yaml; put back the testnet ones.
  (cd "$HERE" && pnpm -s exec envio codegen >/dev/null 2>&1) && echo "codegen restored for config.yaml"
}

status() {
  echo "indexer:  $( [ -f "$RUN/envio.pid" ] && kill -0 "$(cat "$RUN/envio.pid")" 2>/dev/null && echo "running (pid $(cat "$RUN/envio.pid"))" || echo stopped)"
  echo "postgres: $(ours "$PG" && echo "running on :$PG_PORT" || echo stopped)"
  echo "hasura:   $(ours "$HASURA" && echo "running on :$HASURA_PORT" || echo stopped)"
  curl -s "http://localhost:$HASURA_PORT/v1/graphql" -H 'content-type: application/json' \
    -d '{"query":"{ chain_metadata { chain_id block_height latest_processed_block num_events_processed } }"}' 2>/dev/null && echo
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  logs) tail -f "$RUN/envio.log" ;;
  *) echo "usage: $0 up|down|status|logs"; exit 2 ;;
esac
