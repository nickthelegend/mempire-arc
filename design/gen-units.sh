#!/usr/bin/env bash
# Chibi unit concept sheets for the image-to-3D pipeline.
# White background + T-pose are mandatory: shadows and clutter wreck mesh
# reconstruction, and the auto-rig expects a T-pose rest.
set -uo pipefail
cd "$(dirname "$0")"

PRE="Full body character concept of"
POST="standing straight in a strict T-pose with both arms held straight out horizontally to the sides, facing the camera in three-quarter isometric view, on a pure flat white background with no shadow and no ground plane, polished low-poly 3D cartoon render with soft toy-like shading and gentle rim light, chunky rounded chibi proportions with an oversized head and short body, faceted low-poly silhouette, saturated candy colors, clean readable silhouette, game asset turnaround reference, single character only, nothing cropped"

gen() { ./gen.sh "$1" 1:1 "$PRE $2, $POST"; }

gen unit_tank    "a rotund chibi whale knight in gleaming plate armor holding a large round tower shield, blue-grey whale skin, gold armor trim" &
gen unit_swarm   "a tiny fierce chibi shiba inu puppy warrior in light leather armor holding a small bone dagger, orange fur" &
gen unit_ranged  "a chibi green frog archer in a hooded green tunic holding a golden bow, big round eyes" &
gen unit_splash  "a chibi grey tabby cat bomber in a red flight cap hugging a giant round gold coin bomb" &
gen unit_support "a chibi penguin herald in royal purple robes holding a tall banner pole with a purple flag" &
wait
