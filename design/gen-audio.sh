#!/usr/bin/env bash
# Higgsfield audio generation for Mempire.
#   ./gen-audio.sh sfx  <name> <prompt>            -> seed_audio  (short SFX)
#   ./gen-audio.sh music <name> <secs> <prompt>    -> sonilo_music (loops)
# Writes app/public/sfx/<name>.(wav|mp3)
set -euo pipefail
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/app/public/sfx"
mkdir -p "$OUT_DIR"
KIND="$1"

if [ "$KIND" = "sfx" ]; then
  NAME="$2"; PROMPT="$3"
  JSON=$(higgsfield generate create seed_audio --prompt "$PROMPT" --format mp3 --sample_rate 44100 --wait --json 2>&1) \
    || { echo "FAIL $NAME: $(echo "$JSON" | head -c 180)"; exit 1; }
else
  NAME="$2"; SECS="$3"; PROMPT="$4"
  JSON=$(higgsfield generate create sonilo_music --prompt "$PROMPT" --duration "$SECS" --wait --json 2>&1) \
    || { echo "FAIL $NAME: $(echo "$JSON" | head -c 180)"; exit 1; }
fi

URL=$(printf '%s' "$JSON" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d
    print(d.get('result_url') or d.get('min_result_url') or '')
except Exception: print('')
")
[ -z "$URL" ] && { echo "FAIL $NAME: no url in $(printf '%s' "$JSON" | head -c 200)"; exit 1; }
EXT="${URL##*.}"; EXT="${EXT%%\?*}"
curl -sL "$URL" -o "$OUT_DIR/$NAME.$EXT"
echo "OK $NAME -> $NAME.$EXT ($(wc -c < "$OUT_DIR/$NAME.$EXT") bytes)"
