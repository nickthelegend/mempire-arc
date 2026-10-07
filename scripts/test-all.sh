#!/usr/bin/env bash
# Every suite, in one go, with a summary table. Chain suites start their own throwaway
# arc-anvil fork of Arc mainnet (:8711, chain 31338) and tear it down.
#   ARC_ANVIL=… ARC_FORGE=… ./scripts/test-all.sh          (FORK_TESTS=1 also runs the forge fork suites)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORGE=${ARC_FORGE:-forge}
declare -a NAMES RESULTS
run() { # name, dir, command…
  local name=$1 dir=$2; shift 2
  local out; out=$( (cd "$ROOT/$dir" && "$@") 2>&1 ); local code=$?
  local tail; tail=$(printf '%s\n' "$out" | grep -E "passed|failed|SIM OK|Tests|tests passed|pass$" | tail -1)
  NAMES+=("$name"); RESULTS+=("$([ $code -eq 0 ] && echo PASS || echo FAIL) · ${tail:-exit $code}")
}
run "contracts (forge, unit)"     contracts "$FORGE" test --no-match-path 'test/fork/*'
[ "${FORK_TESTS:-0}" = 1 ] && run "contracts (forge, Arc+Base mainnet forks)" contracts env FORK_TESTS=1 "$FORGE" test --network arc --match-path 'test/fork/*'
run "simulation determinism"     app       npx tsx scripts/sim-test.ts
run "app typecheck"              app       npx tsc -b
run "relay: auth"                server    node test-auth.mjs
run "relay: memstore"            server    node test-memstore.mjs
run "relay: locker"              server    node test-locker.mjs
run "relay: Kimi AI"             server    node test-ai.mjs
run "relay: Gateway + ERC-8004"  server    node test-interop.mjs
run "relay: onboarding (fork)"   server    node test-onboard.mjs
run "relay: settlement (fork)"   server    node test-settlement.mjs
run "game end to end (fork)"     server    node test-e2e.mjs
run "CRE workflow"               cre/market-meta bun test
run "Envio handlers"             indexer   pnpm -s test
printf '\n%-40s %s\n' SUITE RESULT
for i in "${!NAMES[@]}"; do printf '%-40s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}"; done
printf '%s\n' "${RESULTS[@]}" | grep -q "^FAIL" && exit 1 || exit 0
