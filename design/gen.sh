#!/usr/bin/env bash
# Higgsfield asset generation for Mempire. One asset per call:
#   ./gen.sh <out-name> <aspect> <prompt>
# Writes design/generated/<out-name>.png
set -euo pipefail
OUT_DIR="$(cd "$(dirname "$0")" && pwd)/generated"
mkdir -p "$OUT_DIR"
NAME="$1"; ASPECT="$2"; PROMPT="$3"; MODEL="${4:-gpt_image_2}"

JSON=$(higgsfield generate create "$MODEL" \
  --prompt "$PROMPT" \
  --aspect_ratio "$ASPECT" \
  --quality high \
  --resolution 1k \
  --wait --json 2>&1) || { echo "FAIL $NAME: $(echo "$JSON" | head -c 200)"; exit 1; }

URL=$(printf '%s' "$JSON" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    d=d[0] if isinstance(d,list) else d
    print(d.get('result_url') or d.get('min_result_url') or '')
except Exception: print('')
")
[ -z "$URL" ] && { echo "FAIL $NAME: no url"; exit 1; }
curl -sL "$URL" -o "$OUT_DIR/$NAME.png"
echo "OK $NAME -> $OUT_DIR/$NAME.png ($(wc -c < "$OUT_DIR/$NAME.png") bytes)"
