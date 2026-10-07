#!/usr/bin/env bash
# Every suite, in one go. Prints a summary table. The chain suites start their
# own throwaway fork (server/test-chain.mjs, :8613), so the dev chain is untouched.
#   ./scripts/local-up.sh && ./scripts/test-all.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
declare -a NAMES RESULTS
run() { # name, dir, command…
  local name=$1 dir=$2; shift 2
  local out; out=$( (cd "$ROOT/$dir" && "$@") 2>&1 ); local code=$?
  local tail; tail=$(printf '%s\n' "$out" | grep -E "passed|failed|SIM OK|Tests|tests passed|B14" | tail -1)
  NAMES+=("$name"); RESULTS+=("$([ $code -eq 0 ] && echo PASS || echo FAIL) · ${tail:-exit $code}")
}
run "contracts (forge)"          contracts forge test
run "simulation determinism"     app       npx tsx scripts/sim-test.ts
run "app typecheck"              app       npx tsc -b
run "relay: auth"                server    node test-auth.mjs
run "relay: memstore"            server    node test-memstore.mjs
run "relay: locker"              server    node test-locker.mjs
run "relay: persistence (mongo)" server    node test-persistence.mjs
run "relay: Kimi AI"             server    node test-ai.mjs
run "relay: onboarding (chain)"  server    node test-onboard.mjs
run "relay: settlement (chain)"  server    node test-settlement.mjs
run "relay: Privy (chain)"       server    node test-privy.mjs
run "game end to end (chain)"    server    node test-e2e.mjs
run "CRE workflow"               cre/market-meta bun test
run "Envio handlers"             indexer   pnpm -s test
printf '\n%-28s %s\n' SUITE RESULT
for i in "${!NAMES[@]}"; do printf '%-28s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"; done
printf '%s\n' "${RESULTS[@]}" | grep -q "^FAIL" && exit 1 || exit 0
