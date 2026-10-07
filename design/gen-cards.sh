#!/usr/bin/env bash
# Batch-generate every card in app/src/data/cards.json.
#
# Resumable by design: a card whose PNG already sits in app/public/art/ is
# skipped without spending a credit. So an interrupted run, a rate limit, or a
# single bad image costs only what it costs — delete the one file and re-run.
#
#   ./design/gen-cards.sh              # everything missing
#   ./design/gen-cards.sh BTC ETH SOL  # only these
#   QUALITY=medium ./design/gen-cards.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/app/public/art"
RAW="$ROOT/design/generated"
QUALITY="${QUALITY:-high}"
RESOLUTION="${RESOLUTION:-1k}"
mkdir -p "$OUT" "$RAW"

# macOS ships bash 3.2, which has no `mapfile` — the prompt list goes through a
# temp file and a plain read loop instead.
ROWFILE="$(mktemp)"
trap 'rm -f "$ROWFILE"' EXIT
python3 "$ROOT/design/build-prompts.py" "$@" > "$ROWFILE"

total=$(wc -l < "$ROWFILE" | tr -d ' '); made=0; skipped=0; failed=0; i=0
echo "$total card(s) · quality=$QUALITY resolution=$RESOLUTION"

while IFS= read -r row; do
  [ -n "$row" ] || continue
  i=$((i+1))
  ticker="${row%%$'\t'*}"
  prompt="${row#*$'\t'}"
  slug="$(echo "$ticker" | tr '[:upper:]' '[:lower:]')"
  dest="$OUT/card_$slug.png"

  if [ -s "$dest" ]; then
    skipped=$((skipped+1)); echo "[$i/$total] $ticker — already have it"; continue
  fi

  json=$(higgsfield generate create gpt_image_2 \
    --prompt "$prompt" --aspect_ratio "3:4" \
    --quality "$QUALITY" --resolution "$RESOLUTION" \
    --wait --json 2>&1) || true

  url=$(printf '%s' "$json" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d
    print(d.get('result_url') or d.get('min_result_url') or '')
except Exception: print('')
")
  if [ -z "$url" ]; then
    failed=$((failed+1)); echo "[$i/$total] $ticker — FAILED: $(printf '%s' "$json" | head -c 120)"
    sleep 4; continue
  fi

  curl -sL "$url" -o "$RAW/card_$slug.png"
  # Downscale to the size the card frame and the billboard actually sample at.
  python3 - "$RAW/card_$slug.png" "$dest" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
im = im.resize((512, round(512 * im.size[1] / im.size[0])), Image.LANCZOS)
im.save(sys.argv[2], optimize=True)
PY
  made=$((made+1))
  echo "[$i/$total] $ticker — ok ($(wc -c < "$dest" | tr -d ' ') bytes)"
  sleep 2
done < "$ROWFILE"

echo "done · $made new · $skipped skipped · $failed failed"
[ "$failed" -eq 0 ] || echo "re-run to retry the failures (finished cards are skipped)"
