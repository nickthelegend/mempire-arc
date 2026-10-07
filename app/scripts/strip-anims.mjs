// Keep only the clips the game plays. 76 clips of keyframe data dominates the
// file; six is all the state machine ever selects between.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup } from '@gltf-transform/functions';

const KEEP = [
  'Idle', 'Walking_A', 'Running_A', 'Death_A', 'Hit_A',
  '1H_Melee_Attack_Chop', '2H_Melee_Attack_Chop', 'Spellcast_Shoot', 'Unarmed_Melee_Attack_Punch_A',
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const [inPath, outPath] = process.argv.slice(2);
const doc = await io.read(inPath);
const root = doc.getRoot();

const before = root.listAnimations().length;
let kept = 0;
for (const anim of root.listAnimations()) {
  if (KEEP.includes(anim.getName())) { kept++; continue; }
  anim.dispose();
}
await doc.transform(prune(), dedup());
await io.write(outPath, doc);
console.log(`${inPath.split('/').pop()}: ${before} clips -> ${kept}`);
