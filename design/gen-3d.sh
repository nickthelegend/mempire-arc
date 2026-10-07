#!/usr/bin/env bash
# Concept PNG -> textured, rigged, animated GLB via Higgsfield image_to_3d.
# Inputs must be a single T-posed figure on flat white (see gen-units.sh).
#   ./gen-3d.sh <unit_name> [animation_action_id]
set -uo pipefail
cd "$(dirname "$0")"
OUT="../app/public/models"
mkdir -p "$OUT"

NAME="$1"
ACTION="${2:-1}"        # 1 = Walking
SRC="generated/${NAME}.png"
[ -f "$SRC" ] || { echo "FAIL $NAME: missing $SRC"; exit 1; }

JSON=$(higgsfield generate create image_to_3d \
  --image "$SRC" \
  --should_texture true \
  --enable_rigging true \
  --enable_animation true \
  --animation_action_id "$ACTION" \
  --pose_mode t-pose \
  --topology triangle \
  --target_polycount 8000 \
  --symmetry_mode auto \
  --wait --json 2>&1) || { echo "FAIL $NAME: $(echo "$JSON" | head -c 200)"; exit 1; }

URL=$(printf '%s' "$JSON" | python3 -c "
import json,sys
def walk(o,out):
    if isinstance(o,dict):
        for k,v in o.items():
            if isinstance(v,str) and v.startswith('http') and '.glb' in v.lower(): out.append(v)
            else: walk(v,out)
    elif isinstance(o,list):
        for i in o: walk(i,out)
try:
    d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d
    u=[]; walk(d,u)
    print(u[0] if u else (d.get('result_url') or ''))
except Exception: print('')
")
[ -z "$URL" ] && { echo "FAIL $NAME: no glb url — $(printf '%s' "$JSON" | head -c 300)"; exit 1; }
curl -sL "$URL" -o "$OUT/${NAME}.glb"
echo "OK $NAME -> ${NAME}.glb ($(wc -c < "$OUT/${NAME}.glb") bytes)"
