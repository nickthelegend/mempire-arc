#!/usr/bin/env bash
# Stop what local-up started — by PID only (other sessions share this machine),
# and only if that PID still runs what we started: after a reboot a stale PID
# file can name an unrelated process.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
expect() { case $1 in relay) echo "node index.js";; anvil) echo "anvil";; mongo) echo "mongod";; vite) echo "vite";; esac; }
for p in relay anvil mongo vite; do
  f="$ROOT/.local/$p.pid"
  [ -f "$f" ] || continue
  pid=$(cat "$f")
  if ps -o command= -p "$pid" 2>/dev/null | grep -q "$(expect $p)"; then
    kill "$pid" 2>/dev/null && echo "stopped $p"
  else
    echo "skipped $p: pid $pid is not ours any more"
  fi
  rm -f "$f"
done
