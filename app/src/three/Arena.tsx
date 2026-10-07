import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { FP } from '../sim/fixed';
import { ARENA_H, ARENA_W, BRIDGE_X, RIVER_BOT, RIVER_TOP } from '../sim/engine';
import { causticTexture, grassTexture, stoneTexture, waterTexture, woodTexture } from './textures';
import { Boxes, Spheres, type Box } from './Boxes';

const W = ARENA_W / FP; // 18
const H = ARENA_H / FP; // 32
const RT = RIVER_TOP / FP;
const RB = RIVER_BOT / FP;

const FRAME = 1.3; // wood border thickness
const GOLD = '#ffc422';
const INK = '#10203f';

/**
 * The arena.
 *
 * It used to be a green rectangle in a brown frame, which read as a spread-
 * sheet next to sixty-four pieces of hand-drawn character art. The board is
 * where a player spends three minutes staring, so it gets the same treatment
 * as everything else in this world:
 *
 * - **Gold.** The frame carries the same gold rule the panels and the column
 *   wear, with corner caps and banner posts. It is the one line that ties the
 *   board to the rest of the game.
 * - **Depth.** Stone banks, a sunken river bed, raised bridges with posts, and
 *   a soft darkening toward the outer tiles so the field is not uniformly lit.
 * - **Movement.** Two water layers scrolling at different speeds and in
 *   different directions. One scrolling texture reads as a conveyor belt.
 * - **Wear.** Faint tracks from each bridge toward the towers — the paths
 *   every unit in every match actually walks.
 *
 * Everything is memoised and disposed on unmount; this subtree rebuilds on
 * every match start.
 */
export function Arena({ placing }: { placing: boolean }) {
  const grass = useMemo(grassTexture, []);
  const water = useMemo(waterTexture, []);
  const caustic = useMemo(causticTexture, []);
  const stone = useMemo(() => stoneTexture([10, 1]), []);
  const woodFrame = useMemo(() => woodTexture([6, 1]), []);
  const woodPlank = useMemo(() => woodTexture([2, 1]), []);

  const placeRef = useRef<THREE.MeshBasicMaterial>(null);
  const t = useRef(0);

  useEffect(() => () => {
    [grass, water, caustic, stone, woodFrame, woodPlank].forEach((x) => x.dispose());
  }, [grass, water, caustic, stone, woodFrame, woodPlank]);

  useFrame((_, dt) => {
    t.current += dt;
    // Opposed directions and unequal speeds. Matching them would just be one
    // thicker texture travelling in one direction.
    water.offset.x += dt * 0.045;
    caustic.offset.x -= dt * 0.021;
    caustic.offset.y = Math.sin(t.current * 0.35) * 0.03;
    // The deploy-zone wash breathes, so a held card reads as an invitation
    // rather than as a rectangle that appeared.
    if (placeRef.current) {
      placeRef.current.opacity = 0.1 + Math.sin(t.current * 2.6) * 0.045;
    }
  });

  const midZ = (RT + RB) / 2;

  /**
   * The frame and its gold rule, as instance tables.
   *
   * Eight boxes that never move were eight draw calls, and a draw call is
   * driver-side CPU work — the thing that actually breaks on a slow machine.
   * See Boxes.tsx.
   */
  const frameBoxes = useMemo<Box[]>(() => [
    { pos: [W / 2, 0.16, -FRAME / 2], size: [W + FRAME * 2, 0.34, FRAME] },
    { pos: [W / 2, 0.16, H + FRAME / 2], size: [W + FRAME * 2, 0.34, FRAME] },
    { pos: [-FRAME / 2, 0.16, H / 2], size: [FRAME, 0.34, H] },
    { pos: [W + FRAME / 2, 0.16, H / 2], size: [FRAME, 0.34, H] },
  ], []);

  /** Every static piece of both bridges, grouped by the material it wears. */
  const {
    bridgeStone, bridgeDeck, bridgeRail, bridgePost, finials,
  } = useMemo(() => {
    const stoneB: Box[] = [];
    const deck: Box[] = [];
    const rail: Box[] = [];
    const post: Box[] = [];
    const fin: [number, number, number][] = [];
    const span = RB - RT + 0.7;
    BRIDGE_X.forEach((bx) => {
      const x = bx / FP;
      [RT - 0.1, RB + 0.1].forEach((z) => {
        stoneB.push({ pos: [x, 0.1, z], size: [3.0, 0.26, 0.5] });
      });
      deck.push({ pos: [x, 0.16, midZ], size: [2.6, 0.24, span] });
      [-1.24, 1.24].forEach((off) => {
        rail.push({ pos: [x + off, 0.42, midZ], size: [0.16, 0.28, span] });
        [midZ - span / 2 + 0.12, midZ + span / 2 - 0.12].forEach((z) => {
          post.push({ pos: [x + off, 0.36, z], size: [0.26, 0.62, 0.26] });
          fin.push([x + off, 0.72, z]);
        });
      });
    });
    return {
      bridgeStone: stoneB, bridgeDeck: deck, bridgeRail: rail,
      bridgePost: post, finials: fin,
    };
  }, [midZ]);

  const goldRuleBoxes = useMemo<Box[]>(() => [
    { pos: [W / 2, 0.335, -0.22], size: [W + 0.88, 0.05, 0.44] },
    { pos: [W / 2, 0.335, H + 0.22], size: [W + 0.88, 0.05, 0.44] },
    { pos: [-0.22, 0.335, H / 2], size: [0.44, 0.05, H] },
    { pos: [W + 0.22, 0.335, H / 2], size: [0.44, 0.05, H] },
  ], []);

  return (
    <group>
      {/* ── wood frame ─────────────────────────────────────────────── */}
      <Boxes boxes={frameBoxes} castShadow>
        <meshStandardMaterial map={woodFrame} roughness={0.8} />
      </Boxes>

      {/* The gold rule around the playing field. The same line the game's
          panels wear, and the one thing that makes the board look like it
          belongs to this product rather than to the genre in general.
          Inlaid flush into the wood rather than raised on top of it. Raised,
          the side pieces were seen edge-on from a camera 33 units up and read
          as a gold wall, while the two ends — seen from above — read as a
          hairline. Flush is the same line on all four. */}
      <Boxes boxes={goldRuleBoxes}>
        <meshStandardMaterial color={GOLD} roughness={0.32} metalness={0.65} emissive="#4a3200" />
      </Boxes>

      {/* Corner caps, so the gold rule terminates in something rather than
          simply stopping. */}
      {[[-0.22, -0.22], [W + 0.22, -0.22], [-0.22, H + 0.22], [W + 0.22, H + 0.22]].map(([x, z], i) => (
        <mesh key={`cap${i}`} position={[x, 0.42, z]} castShadow>
          <cylinderGeometry args={[0.4, 0.46, 0.5, 8]} />
          <meshStandardMaterial color={GOLD} roughness={0.28} metalness={0.7} emissive="#4a3200" />
        </mesh>
      ))}

      {/* ── grass, one continuous field ─────────────────────────────
          Both halves share the same material: tinting one side made the
          board look like two different lawns stitched together. Ownership
          is read from the towers and the unit rings instead. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0, H / 2]} receiveShadow>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial map={grass} roughness={0.92} />
      </mesh>

      {/* Worn tracks from each bridge to each tower. Faint on purpose — this
          is the shape of every match that has ever been played here, and it
          should read as history rather than as painted lane markings. */}
      {BRIDGE_X.map((bx) => {
        const x = bx / FP;
        return [6, H - 6].map((z) => (
          <mesh
            key={`${bx}-${z}`}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[x, 0.012, (z + midZ) / 2]}
          >
            <planeGeometry args={[2.1, Math.abs(midZ - z)]} />
            <meshBasicMaterial color="#c8a86a" transparent opacity={0.12} depthWrite={false} />
          </mesh>
        ));
      })}

      {/* ── river ──────────────────────────────────────────────────── */}
      {/* The bed, below the surface, so the channel has a bottom to see. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, -0.06, midZ]}>
        <planeGeometry args={[W, RB - RT]} />
        <meshStandardMaterial color="#0d4a6b" roughness={1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.02, midZ]}>
        <planeGeometry args={[W, RB - RT]} />
        <meshStandardMaterial
          map={water}
          transparent
          opacity={0.94}
          // Rough and non-metallic. A near-mirror surface under this arena's
          // light (ambient 2.1, sun 2.3) returns white, which is how the river
          // ended up looking like poured concrete.
          roughness={0.72}
          metalness={0}
        />
      </mesh>
      {/* caustics, scrolling against the water */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.035, midZ]}>
        <planeGeometry args={[W, RB - RT]} />
        <meshBasicMaterial
          map={caustic}
          transparent
          // Additive white over an entire plane bleaches whatever is under it.
          // At 0.16 it reads as light catching the surface; at the 0.34 this
          // started on, the river came out silver.
          opacity={0.16}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Foam where the water meets the stone. Without it the river is a
          rectangle laid on grass; with it, the water touches something. */}
      {[RT + 0.07, RB - 0.07].map((z) => (
        <mesh key={`foam${z}`} rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.045, z]}>
          {/* Narrow. Two wide strips on a two-tile river is a third of the
              channel painted white, and the water stops being water. */}
          <planeGeometry args={[W, 0.14]} />
          <meshBasicMaterial color="#dffaff" transparent opacity={0.3} depthWrite={false} />
        </mesh>
      ))}

      {/* stone banks */}
      {[RT, RB].map((z) => (
        <mesh key={z} position={[W / 2, 0.09, z]} castShadow receiveShadow>
          <boxGeometry args={[W, 0.2, 0.22]} />
          <meshStandardMaterial map={stone} roughness={0.86} />
        </mesh>
      ))}

      {/* ── bridges ────────────────────────────────────────────────── */}
      {/* Bridges. The stone abutments, the decks, the rails and the posts are
          each a table rather than a mesh per piece — two bridges were twenty-six
          draw calls for geometry that never moves. The gold finials stay
          spheres, so they get their own instanced mesh below. */}
      <Boxes boxes={bridgeStone} castShadow receiveShadow>
        <meshStandardMaterial map={stone} roughness={0.88} />
      </Boxes>
      <Boxes boxes={bridgeDeck} castShadow receiveShadow>
        <meshStandardMaterial map={woodPlank} roughness={0.82} />
      </Boxes>
      <Boxes boxes={bridgeRail} castShadow>
        <meshStandardMaterial color="#7a5424" roughness={0.85} />
      </Boxes>
      <Boxes boxes={bridgePost} castShadow>
        <meshStandardMaterial color="#6b4720" roughness={0.88} />
      </Boxes>
      <Spheres at={finials} r={0.15}>
        <meshStandardMaterial color={GOLD} roughness={0.3} metalness={0.7} />
      </Spheres>

      {/* ── own-half highlight while a card is held ────────────────── */}
      {placing && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.05, RT / 2]}>
            <planeGeometry args={[W, RT]} />
            <meshBasicMaterial ref={placeRef} color="#bfe9ff" transparent opacity={0.12} depthWrite={false} />
          </mesh>
          {/* The boundary of what is allowed, stated as a line. A wash alone
              leaves the player guessing where the legal area stops. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, 0.055, RT - 0.06]}>
            <planeGeometry args={[W, 0.12]} />
            <meshBasicMaterial color={GOLD} transparent opacity={0.75} depthWrite={false} />
          </mesh>
        </>
      )}

      {/* ── banners on the frame ───────────────────────────────────── */}
      {[0, 1].map((side) => (
        [W * 0.22, W * 0.78].map((x) => (
          <Banner
            key={`${side}-${x}`}
            x={x}
            z={side ? H + FRAME / 2 : -FRAME / 2}
            colour={side ? '#c9433f' : '#3f6fc9'}
          />
        ))
      ))}

      {/* Scenery outside the frame is gone: the board no longer stands in a
          meadow, it stands on the sand floor of a colosseum, and a pine tree
          between the plinth and the barrier wall reads as a mistake. The
          banners stay — a bowl with pennants over it is right. */}
    </group>
  );
}

/**
 * A pennant on a pole, in the owning side's colour.
 *
 * Blue and red rather than the arena's gold: gold means money is moving
 * everywhere else in this product, and a decorative flag is not that.
 */
function Banner({ x, z, colour }: { x: number; z: number; colour: string }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 1.1, 0]} castShadow>
        <cylinderGeometry args={[0.07, 0.09, 2.2, 6]} />
        <meshStandardMaterial color="#5b3a17" roughness={0.9} />
      </mesh>
      <mesh position={[0, 2.25, 0]}>
        <sphereGeometry args={[0.15, 8, 6]} />
        <meshStandardMaterial color={GOLD} roughness={0.3} metalness={0.7} />
      </mesh>
      <mesh position={[0.42, 1.62, 0]} castShadow>
        <boxGeometry args={[0.8, 0.62, 0.05]} />
        <meshStandardMaterial color={colour} roughness={0.75} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0.42, 1.28, 0]}>
        <boxGeometry args={[0.8, 0.08, 0.06]} />
        <meshStandardMaterial color={INK} roughness={0.8} />
      </mesh>
    </group>
  );
}

