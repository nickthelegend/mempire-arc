import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { keyedCanvas } from '../lib/chromaKey';
import { coinByMint } from '../lib/coins';
import { FP } from '../sim/fixed';
import { Archetype } from '../sim/types';
import type { SimState, Unit } from '../sim/types';
import { useMatch } from '../state/match';
import { vfx } from './vfx';

/**
 * Units as billboards.
 *
 * Each fighter is the coin's own card art on a plane that turns to face the
 * camera. Two reasons this beats the skinned-mesh path it replaces:
 *
 * 1. **Every coin fights as itself.** The rig path shares five skeletons across
 *    the whole registry, so $BTC and $WIF are literally the same knight. A
 *    billboard costs one texture, so identity is per-coin and free — and the
 *    texture is the card art we already generate.
 * 2. **It is far cheaper.** Sixty-four textured quads against sixty-four skinned
 *    meshes with per-frame bone matrices, on a 30fps mobile floor.
 *
 * Motion is code rather than clips. The whole animation set — deploy, stride,
 * turn, wind-up, strike, recoil, death — is driven from state the simulation
 * already publishes, so it stays in sync with what actually happened without
 * the sim ever knowing this file exists.
 */

/**
 * Full camera-facing billboard, not yaw-only.
 *
 * The arena camera sits at y=38 looking down about 52°. A cylindrical
 * (yaw-only) billboard under that pitch is foreshortened almost flat — the
 * first build put every fighter face-down on the grass. Copying the camera's
 * whole orientation keeps each sprite square-on to the viewer, so it reads
 * upright on screen at any camera angle. This is the standard 2.5D sprite
 * treatment, and the reason particle systems do the same thing.
 */

const OWN_TINT = new THREE.Color('#bcd8ff');
const ENEMY_TINT = new THREE.Color('#ffc0b6');
const WHITE = new THREE.Color('#ffffff');
/** Wind-up tint: a warm charge, distinct from the white of taking a hit. */
const CHARGE = new THREE.Color('#ffe6a8');

const OWN_HEX = '#3fa9ff';
const ENEMY_HEX = '#ff5a4a';

const SPAWN_POP = 0.34;
const HIT_FLASH = 0.16;
const DEATH_TIME = 0.55;
/** How long a strike takes to recover. Short — a blow is not a pose. */
const STRIKE_TIME = 0.26;
/** Height above the ground a unit drops in from when deployed. */
const DROP_HEIGHT = 7;

/** Height in world units, by archetype. Matches the rig path's readability. */
const HEIGHT: Record<number, number> = {
  0: 3.4, 1: 2.5, 2: 3.0, 3: 3.3, 4: 3.0, 5: 2.8,
};

/** Archetypes that hit at a distance, and so need a visible projectile. */
const IS_RANGED: Record<number, boolean> = {
  [Archetype.Ranged]: true, [Archetype.Splash]: true,
};

/**
 * A soft radial alpha mask, drawn once and shared.
 *
 * The card art is a character on a radial glow, not a cut-out — dropping it
 * straight onto a quad would put a visible rectangle on the grass. Fading the
 * outer edge removes the rectangle, and the glow that survives inside the mask
 * reads as an aura around the fighter rather than a background.
 */
function makeAlphaMask(): THREE.Texture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d')!;
  // Generous and soft: a tight mask eats heads and feet off a portrait, and a
  // hard edge reads as a sticker cut out of the grass.
  const grd = g.createRadialGradient(S / 2, S / 2, S * 0.30, S / 2, S / 2, S * 0.70);
  grd.addColorStop(0, '#fff');
  grd.addColorStop(0.80, '#fff');
  grd.addColorStop(1, '#000');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** One loader + cache for every unit texture; the same coin recurs constantly. */
const loader = new THREE.TextureLoader();
const rawTexCache = new Map<string, THREE.Texture>();
const keyedTexCache = new Map<string, THREE.Texture>();

/**
 * Loads a unit texture, falling back when the file is not there yet.
 *
 * Card art arrives one file at a time, so `card_<ticker>.png` is requested
 * optimistically and the round coin badge is swapped in on a 404. The texture
 * object is reused either way, so the material never has to be rebuilt and a
 * unit already on the field just changes what it is showing.
 */
function textureFor(
  url: string, fallback: string, onKeyed: (t: THREE.Texture) => void,
): THREE.Texture {
  // Chroma-keyed art becomes a true cut-out, which is the difference between a
  // character standing on the grass and a portrait in a locket. Un-keyed art
  // (the round coin badges) resolves null and keeps the soft radial mask.
  //
  // Subscribed for EVERY material, cached or not. Hanging this off the raw
  // cache miss instead meant only the first unit of a coin ever learned that
  // the cut-out was ready; a second copy deployed while keying was still in
  // flight took the raw texture and kept it — a character on flat magenta,
  // standing on the grass for the rest of the match.
  void keyedCanvas(url).then((c) => {
    if (!c) return;
    // A CanvasTexture is the right carrier for a keyed cut-out; assigning a
    // canvas onto the existing image-backed texture is not type-safe and can
    // skip the upload, so swap the whole map instead. One per URL, shared by
    // every material showing that coin.
    let keyedTex = keyedTexCache.get(url);
    if (!keyedTex) {
      keyedTex = new THREE.CanvasTexture(c);
      keyedTex.colorSpace = THREE.SRGBColorSpace;
      keyedTex.anisotropy = 4;
      keyedTexCache.set(url, keyedTex);
    }
    onKeyed(keyedTex);
  });

  const hit = rawTexCache.get(url);
  if (hit) return hit;
  const t = loader.load(url, undefined, undefined, () => {
    if (fallback === url) return;
    loader.load(fallback, (fb) => { t.image = fb.image; t.needsUpdate = true; });
  });
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  rawTexCache.set(url, t);
  return t;
}

interface LiveUnit {
  group: THREE.Group;
  sprite: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  shadow: THREE.Mesh;
  shadowMat: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  ringDone: boolean;
  /** Billboarded health bar; hidden until the unit has landed. */
  bar: THREE.Group;
  barFill: THREE.Mesh;
  barFillMat: THREE.MeshBasicMaterial;
  barWidth: number;
  hpShown: number;
  height: number;
  archetype: number;
  lastHp: number;
  spawning: number;
  hitFlash: number;
  dying: number;
  /** Accumulated stride phase — advances with distance, not wall time, so a
   *  slow unit does not moonwalk. */
  phase: number;
  /** Distance walked since the last footfall puff. */
  strideDist: number;
  /**
   * Low-passed speed in world units per second.
   *
   * The sim ticks at 20Hz while this loop runs at ~60Hz, so on two frames out of
   * three the target has not moved at all. Reading movement per-frame therefore
   * flickered between "walking" and "standing" 20 times a second, and every
   * value derived from it — bob, squash, lean, the sprite's Y — snapped between
   * two positions. That was a visible vibration. Smoothing the speed decouples
   * the animation from the tick rate entirely.
   */
  speed: number;
  /**
   * The attack cycle, read from the sim rather than invented.
   *
   * `cooldown` counts down to zero, the unit hits, and it is reset to the
   * archetype's hit interval — buffed by a support aura, which is why the
   * period is captured from the reset value instead of read from the archetype
   * table. Watching it gives two things nothing else can: the exact frame a blow
   * lands, and how close the next one is, which is what anticipation needs.
   */
  lastCooldown: number;
  cycle: number;
  /** 1 at the instant of a hit, decaying over STRIKE_TIME. */
  strike: number;
  /**
   * Hit-stop: seconds the strike pose is held at full extension before it
   * starts recovering.
   *
   * The oldest trick in action games, and the cheapest. Freezing the attacker
   * for two or three frames on contact is what makes a blow feel like it hit
   * something instead of passing through it. It cannot be done by pausing the
   * simulation — that is deterministic lockstep and both clients must step in
   * exact agreement — so it is done here, to the pose only.
   */
  strikeHold: number;
  /** Landing impact, 1 at touchdown, decaying. Drives the squash. */
  landPunch: number;
  /** Smoothed left/right facing in [-1, 1]; sign is the mirror. */
  facing: number;
  /** Recoil impulse in world units, decaying. */
  recoilX: number;
  recoilZ: number;
  baseTint: THREE.Color;
  hex: string;
}

function disposeUnit(lu: LiveUnit): void {
  // Per-unit materials are cloned, so they are ours to release. Geometries and
  // textures are shared and deliberately never disposed here — StrictMode
  // double-invokes effect cleanup in dev and would tear them out from under
  // every other unit.
  lu.mat.dispose();
  lu.shadowMat.dispose();
  (lu.ring.material as THREE.Material).dispose();
  lu.barFillMat.dispose();
  ((lu.bar.children[0] as THREE.Mesh).material as THREE.Material).dispose();
}

/** Smoothstep, for easing a value in over a window rather than switching it on. */
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export function UnitsBillboard() {
  const root = useRef<THREE.Group>(null);
  const live = useRef(new Map<number, LiveUnit>());
  const { camera } = useThree();
  const playerDeck = useMatch((s) => s.playerDeck);
  const botDeck = useMatch((s) => s.botDeck);

  const alphaMask = useMemo(makeAlphaMask, []);
  const planeGeo = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  // Left-anchored so the health fill drains from the right, like every health
  // bar the player has ever seen, without repositioning it every frame.
  const barGeo = useMemo(() => new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0), []);
  const ringGeo = useMemo(() => new THREE.RingGeometry(0.36, 0.52, 24), []);
  const shadowGeo = useMemo(() => new THREE.CircleGeometry(0.46, 18), []);

  // Scratch vectors, reused every frame for every unit. Allocating a Vector3
  // per unit per frame is the classic way to hand three.js a GC pause.
  const camRight = useMemo(() => new THREE.Vector3(), []);
  const shotFrom = useMemo(() => new THREE.Vector3(), []);
  const shotTo = useMemo(() => new THREE.Vector3(), []);

  // The VFX pool is a module singleton shared with nothing else in the scene;
  // mounting it here keeps sparks in the same coordinate space as the units
  // that emit them, and clears the field between matches.
  useEffect(() => {
    const g = root.current;
    g?.add(vfx.group);
    return () => { vfx.reset(); g?.remove(vfx.group); };
  }, []);

  /**
   * Cut out every card in the match before a card can be played.
   *
   * Keying is asynchronous, and the raw render is a character on a solid
   * magenta field. Deploying a coin whose art had not been keyed yet therefore
   * dropped a bright magenta rectangle onto the grass for a few frames —
   * precisely at the moment the player is watching hardest. The soft radial mask
   * does not save it: that mask only rounds the corners, so the flat edges stay
   * hard. Sixteen cards, keyed once at mount, and the field never shows one.
   */
  useEffect(() => {
    const mints = new Set<string>();
    for (const c of [...playerDeck, ...botDeck]) mints.add(c.coinId);
    for (const mint of mints) {
      const art = coinByMint(mint)?.cardArt;
      if (art) void keyedCanvas(art);
    }
    // Keyed on the decks rather than on mount: this component mounts with the
    // battle scene, which can be a frame ahead of the opponent's deck arriving
    // over the wire. Warming an empty deck warms nothing.
  }, [playerDeck, botDeck]);

  const spawn = (u: Unit, coinId: string, me: 0 | 1): LiveUnit => {
    const group = new THREE.Group();
    const coin = coinByMint(coinId);
    // Card art when the file exists, the round coin badge until it does — so
    // the battlefield stays populated while the art set fills in.
    const fallback = coin?.logoUrl ?? '/art/avatar_guest.webp';
    const url = coin?.cardArt ?? fallback;
    const mine = u.owner === me;
    const tint = mine ? OWN_TINT : ENEMY_TINT;
    const hex = mine ? OWN_HEX : ENEMY_HEX;

    const mat = new THREE.MeshBasicMaterial({
      map: textureFor(url, fallback, (keyedTex) => {
        // A cut-out carries its own alpha; the radial mask would only clip it.
        mat.map = keyedTex;
        mat.alphaMap = null;
        mat.needsUpdate = true;
      }),
      alphaMap: alphaMask,
      transparent: true,
      alphaTest: 0.04,
      depthWrite: false,
      color: tint.clone(),
      toneMapped: false,
    });

    const h = HEIGHT[u.archetype] ?? 3.0;
    const sprite = new THREE.Mesh(planeGeo, mat);
    sprite.scale.set(h * 0.78, h, 1);
    // Anchored so the sprite's foot sits near the group origin — the group is
    // the unit's actual position on the board, which is what the shadow marks.
    sprite.position.y = h * 0.46;
    sprite.frustumCulled = false;
    // Never paint art that has not been through the keyer. The raw render is a
    // character on flat magenta, and the radial mask only rounds the corners —
    // the flat edges stay hard, so an unkeyed frame is a magenta card lying on
    // the grass. Warming above means this promise is normally already settled
    // and the unit appears on its very first frame; when it is not, a unit that
    // arrives a beat late is far less jarring than one that arrives as a
    // rectangle. Resolving to null (art that needs no keying) shows it too.
    sprite.visible = false;
    void keyedCanvas(url).then(() => { sprite.visible = true; })
      .catch(() => { sprite.visible = true; });
    group.add(sprite);

    const shadowMat = new THREE.MeshBasicMaterial({
      color: '#12280b', transparent: true, opacity: 0.42, depthWrite: false,
    });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    group.add(shadow);

    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: hex, transparent: true, opacity: 0.95,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    group.add(ring);

    // Health bar. Two quads: a dark trough and a coloured fill that drains.
    // Sized off the unit so a tank's bar reads heavier than a swarm unit's.
    const barWidth = h * 0.52;
    const bar = new THREE.Group();
    const trough = new THREE.Mesh(barGeo, new THREE.MeshBasicMaterial({
      color: '#12161d', transparent: true, opacity: 0.72, depthWrite: false,
      depthTest: false,
    }));
    trough.scale.set(barWidth, 0.17, 1);
    trough.position.x = -barWidth / 2;
    const barFillMat = new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity: 1, depthWrite: false, depthTest: false,
      toneMapped: false,
    });
    const barFill = new THREE.Mesh(barGeo, barFillMat);
    barFill.scale.set(barWidth, 0.12, 1);
    barFill.position.set(-barWidth / 2, 0, 0.01);
    bar.add(trough, barFill);
    bar.position.y = h * 1.02;
    bar.visible = false;
    // Bars must never be hidden behind a nearer fighter — an occluded health
    // bar is worse than no health bar, because it reads as "already dead".
    bar.renderOrder = 800;
    group.add(bar);

    group.position.set(u.x / FP, 0, u.y / FP);

    return {
      group, sprite, mat, shadow, shadowMat, ring, ringDone: false,
      bar, barFill, barFillMat, barWidth, hpShown: 1,
      height: h, archetype: u.archetype,
      lastHp: u.hp, spawning: 0, hitFlash: 0, dying: 0,
      phase: 0, strideDist: 0, speed: 0,
      lastCooldown: u.cooldown, cycle: 0, strike: 0, strikeHold: 0, landPunch: 0,
      facing: 1, recoilX: 0, recoilZ: 0,
      baseTint: tint.clone(), hex,
    };
  };

  useFrame((_state, dtRaw) => {
    const store = useMatch.getState();
    const sim: SimState | null = store.sim;
    if (!sim || !root.current) return;
    const dt = Math.min(dtRaw, 0.05); // a backgrounded tab must not jump the field
    const seen = new Set<number>();
    const deckOf = (o: 0 | 1) => (o === store.perspective ? store.playerDeck : store.botDeck);

    // The camera's right vector in world space, recomputed once. Screen-space
    // left/right is what decides which way a sprite should face; deriving it
    // from world +X would make every unit face the wrong way from seat 1.
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);

    // Target lookup. Attacks aim at a unit id or a tower index, and the strike
    // has to know where that is to throw sparks at the right place.
    const byId = new Map<number, Unit>();
    for (const u of sim.units) byId.set(u.id, u);

    for (const u of sim.units) {
      seen.add(u.id);
      let lu = live.current.get(u.id);
      if (!lu) {
        const deck = deckOf(u.owner);
        const coinId = deck[u.cardIndex]?.coinId ?? deck[0]?.coinId ?? '';
        lu = spawn(u, coinId, store.perspective);
        live.current.set(u.id, lu);
        root.current.add(lu.group);
      }

      const tx = u.x / FP;
      const tz = u.y / FP;
      const beforeX = lu.group.position.x;
      const beforeZ = lu.group.position.z;
      const k = 1 - Math.exp(-dt * 11);
      lu.group.position.x += (tx - lu.group.position.x) * k;
      lu.group.position.z += (tz - lu.group.position.z) * k;

      // Speed comes from the SMOOTHED position, not the sim target, and is then
      // low-passed. Both steps matter: the target only moves on a tick, and even
      // the smoothed delta is noisy at frame level.
      const stepped = Math.hypot(
        lu.group.position.x - beforeX,
        lu.group.position.z - beforeZ,
      );
      const instant = dt > 0 ? stepped / dt : 0;
      lu.speed += (instant - lu.speed) * (1 - Math.exp(-dt * 6));

      // Stride advances with distance covered, so a slow unit does not moonwalk.
      lu.phase += lu.speed * dt * 4.4;

      // ── where this unit is aiming ─────────────────────────────────────────
      // Both for facing and for throwing the strike's sparks at something real.
      let aimX = 0;
      let aimZ = 0;
      let aimY = 1.0;
      let hasAim = false;
      if (u.targetUnit >= 0) {
        const t = byId.get(u.targetUnit);
        if (t) {
          aimX = t.x / FP; aimZ = t.y / FP;
          aimY = (HEIGHT[t.archetype] ?? 3) * 0.42;
          hasAim = true;
        }
      }
      if (!hasAim && u.targetTower >= 0) {
        const t = sim.towers[u.targetTower];
        if (t) {
          aimX = t.x / FP; aimZ = t.y / FP;
          aimY = t.kind === 'king' ? 2.4 : 1.9;
          hasAim = true;
        }
      }

      let dirX = 0;
      let dirZ = 0;
      if (hasAim) {
        dirX = aimX - lu.group.position.x;
        dirZ = aimZ - lu.group.position.z;
      } else {
        // Not engaged: face the way it is walking.
        dirX = tx - beforeX;
        dirZ = tz - beforeZ;
      }
      const dLen = Math.hypot(dirX, dirZ);
      if (dLen > 1e-4) { dirX /= dLen; dirZ /= dLen; }

      // ── the attack cycle, read off the simulation ─────────────────────────
      // A cooldown that jumps upward means the reset ran, which means a blow
      // landed on this exact tick. That is the only moment worth punctuating,
      // and it is free — the sim already computed it.
      if (u.cooldown > lu.lastCooldown) {
        lu.cycle = u.cooldown;
        lu.strike = 1;
        if (hasAim) {
          const ranged = IS_RANGED[u.archetype];
          if (ranged) {
            // Fire something visible. Without this an archer five tiles away
            // stands perfectly still while its target melts, which reads as a
            // bug rather than as combat.
            shotFrom.set(
              lu.group.position.x + dirX * 0.4,
              lu.height * 0.56,
              lu.group.position.z + dirZ * 0.4,
            );
            shotTo.set(aimX, aimY, aimZ);
            // The shot leaves too fast to see where it came from; the flash is
            // what ties the bolt to the unit that fired it.
            vfx.flash(shotFrom.x, shotFrom.y, shotFrom.z, lu.hex, 0.7);
            vfx.shot(shotFrom, shotTo, lu.hex, 0.85, (at) => {
              const splash = u.archetype === Archetype.Splash;
              vfx.impact(at.x, at.y, at.z, dirX, dirZ, lu!.hex, splash ? 1.6 : 0.9);
              if (splash) {
                vfx.shockwave(at.x, at.z, lu!.hex, 1.3);
                vfx.dust(at.x, at.z, 1.1);
                vfx.kick(0.05);
              }
            });
          } else {
            // Melee connects on the frame it is thrown.
            const heavy = u.archetype === Archetype.Tank;
            vfx.impact(
              lu.group.position.x + dirX * 0.9,
              lu.height * 0.44,
              lu.group.position.z + dirZ * 0.9,
              dirX, dirZ, lu.hex, heavy ? 1.5 : 0.85,
            );
            // A tank's swing gets longer hit-stop than a swarm unit's jab, so
            // weight class is legible from the timing alone.
            lu.strikeHold = heavy ? 0.075 : 0.04;
          }
        }
      }
      lu.lastCooldown = u.cooldown;
      if (lu.strikeHold > 0) lu.strikeHold -= dt; // held at full extension
      else lu.strike = Math.max(0, lu.strike - dt / STRIKE_TIME);

      // Anticipation: only in the last third of the cycle, and only while
      // actually engaged. A unit walking across the field must not twitch
      // because its cooldown happens to be ticking down.
      const charge = lu.cycle > 0 && u.state === 'attack'
        ? 1 - u.cooldown / lu.cycle
        : 0;
      const windup = smoothstep(0.62, 1, charge);
      // Strike decays fast, so the blow is a snap and the recovery is the part
      // you actually see. Melee reaches; ranged braces instead of lunging.
      const strikeCurve = lu.strike ** 1.4;
      const reach = IS_RANGED[u.archetype]
        ? strikeCurve * 0.16
        : strikeCurve * 0.62 - windup * 0.26;

      // Face the camera completely, every frame. Quaternion copy rather than
      // Euler assignment: mixing an axis-by-axis yaw with the lean below fights
      // over rotation order and tips the sprite.
      lu.sprite.quaternion.copy(camera.quaternion);
      lu.bar.quaternion.copy(camera.quaternion);

      // Mirror toward whatever this unit is dealing with. Screen-space, so it
      // stays correct from either seat, and smoothed so a unit that is pinned
      // between two targets turns instead of strobing.
      const screenDir = dirX * camRight.x + dirZ * camRight.z;
      if (Math.abs(screenDir) > 0.15) {
        const want = screenDir > 0 ? 1 : -1;
        lu.facing += (want - lu.facing) * (1 - Math.exp(-dt * 9));
      }
      // Narrows through the turn rather than popping, but never past 0.86 —
      // a sprite that squeezes to nothing reads as a glitch, not a pivot.
      const faceSign = lu.facing >= 0 ? 1 : -1;
      const faceSquash = 0.86 + 0.14 * Math.min(1, Math.abs(lu.facing));

      if (u.hp < lu.lastHp) {
        lu.hitFlash = HIT_FLASH;
        // Knocked back along the incoming blow. The attacker is almost always
        // whatever this unit is facing, so recoiling away from its own aim is
        // both cheap and right nearly every time.
        lu.recoilX -= dirX * 0.32;
        lu.recoilZ -= dirZ * 0.32;
      }
      lu.lastHp = u.hp;
      const recoilDecay = Math.exp(-dt * 9);
      lu.recoilX *= recoilDecay;
      lu.recoilZ *= recoilDecay;

      // ── the animation ─────────────────────────────────────────────────────
      const h = lu.height;
      // Gait blends in with speed rather than switching on — the last of the
      // step-function behaviour that made units judder.
      const gait = Math.min(1, lu.speed / 1.6);
      const bob = Math.abs(Math.sin(lu.phase)) * gait;
      const breathe = Math.sin(performance.now() / 620 + lu.group.position.x) * 0.012;
      // Squash on the down-beat of the stride: the classic weight cue, and the
      // single biggest thing that stops a billboard reading as a sticker.
      // The strike adds its own thrust deformation on top.
      const squash = 1 - bob * 0.07 + breathe * (1 - gait) + strikeCurve * 0.13;
      const stretch = 1 + bob * 0.09 - breathe * (1 - gait) - strikeCurve * 0.09
        + windup * 0.05;

      // Deploy: fall in and land, rather than materialising. The landing is what
      // sells it — a drop with no dust is just a unit sliding down a wire.
      lu.landPunch = Math.max(0, lu.landPunch - dt / 0.24);
      let drop = 0;
      const pop = lu.spawning < SPAWN_POP
        ? (() => {
          lu.spawning += dt;
          const t = Math.min(1, lu.spawning / SPAWN_POP);
          const eased = 1 - (1 - t) ** 3;
          // Accelerating fall, so it reads as gravity and not a lerp.
          drop = DROP_HEIGHT * (1 - t) ** 2;
          lu.ring.scale.setScalar(0.4 + t * 3.4);
          (lu.ring.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - t);
          if (t >= 1 && !lu.ringDone) {
            lu.ringDone = true;
            lu.group.remove(lu.ring);
            (lu.ring.material as THREE.Material).dispose();
            vfx.dust(lu.group.position.x, lu.group.position.z, 1.5);
            vfx.shockwave(lu.group.position.x, lu.group.position.z, lu.hex, 1.1);
            lu.bar.visible = true;
            // Touchdown. Decays over its own timer rather than being sampled
            // from `t`, so the squash outlives the spawn window and reads as
            // recovery instead of stopping dead the instant the drop ends.
            lu.landPunch = 1;
            vfx.kick(0.035);
          }
          return eased * (1 + 0.16 * Math.sin(Math.PI * t));
        })()
        : 1;

      // Absorbing the landing: wide and low on contact, springing back over a
      // quarter second. Weight, for free.
      const punch = lu.landPunch ** 2;
      const landX = 1 + punch * 0.26;
      const landY = 1 - punch * 0.24;

      lu.sprite.scale.set(
        h * 0.78 * squash * pop * faceSquash * landX * faceSign,
        h * stretch * pop * landY,
        1,
      );
      lu.sprite.position.set(
        dirX * reach + lu.recoilX,
        h * 0.46 * stretch * pop * landY + bob * 0.12 + drop,
        dirZ * reach + lu.recoilZ,
      );

      // Lean into the stride — applied AFTER the billboard quaternion, so it is
      // a roll in screen space. A static image that rocks reads as momentum,
      // which is most of what a walk cycle communicates at this size. The strike
      // rolls the other way, into the blow.
      const lean = gait * 0.09;
      lu.sprite.rotateZ(
        -lean * Math.sin(lu.phase * 0.5)
        - faceSign * (strikeCurve * 0.24 - windup * 0.1),
      );

      // Footfall dust on the down-beat, rate-limited by distance so a fast unit
      // does not carpet the field and a slow one still leaves prints.
      lu.strideDist += lu.speed * dt;
      if (gait > 0.35 && lu.strideDist > 1.5) {
        lu.strideDist = 0;
        vfx.dust(lu.group.position.x, lu.group.position.z, 0.45);
      }

      if (lu.hitFlash > 0) {
        lu.hitFlash = Math.max(0, lu.hitFlash - dt);
        const f = lu.hitFlash / HIT_FLASH;
        // Tint only — never scale. Scaling here fights the stride and the unit
        // visibly stutters on every hit.
        lu.mat.color.copy(lu.baseTint).lerp(WHITE, f * 0.85);
      } else {
        // Winding up runs hot. Subtle — it must read as "about to swing", never
        // compete with the white flash that means "just took damage".
        lu.mat.color.copy(lu.baseTint);
        if (windup > 0) lu.mat.color.lerp(CHARGE, windup * 0.22);
      }

      // Health drains toward the true value instead of stepping to it, so a
      // burst of chip damage reads as one continuous loss.
      const hpPct = Math.max(0, Math.min(1, u.hp / u.maxHp));
      lu.hpShown += (hpPct - lu.hpShown) * (1 - Math.exp(-dt * 9));
      lu.barFill.scale.x = lu.barWidth * lu.hpShown;
      // Fades toward danger as it empties, so a nearly-dead unit is legible at
      // a glance without reading the bar's length.
      lu.barFillMat.color.set(lu.hpShown < 0.3 ? '#ff4d4d' : lu.hex);
      lu.bar.position.y = h * 1.02 * pop + drop + bob * 0.1;

      lu.shadow.scale.setScalar(pop * (0.9 + bob * 0.16));
      // The shadow tightens and darkens as the unit falls toward it — the cue
      // that tells you where a dropping unit is going to land.
      lu.shadowMat.opacity = 0.42 * (1 - drop / DROP_HEIGHT * 0.7);

      // Nearer units must draw last. With depthWrite off, three.js sorts these
      // by distance but ties resolve arbitrarily and neighbours visibly swap
      // layers; an explicit order keyed on depth makes it stable.
      lu.group.renderOrder = 10 + Math.round(lu.group.position.z * 4);
    }

    // Deaths: topple, sink and fade rather than vanishing mid-field.
    for (const [id, lu] of live.current) {
      if (seen.has(id)) continue;
      const first = lu.dying === 0;
      lu.dying += dt;
      const t = Math.min(1, lu.dying / DEATH_TIME);
      if (first) {
        lu.bar.visible = false;
        // Weight class decides the exit. A tank going down should be an event;
        // four swarm units popping should not each stage a funeral.
        const heavy = lu.archetype === Archetype.Tank || lu.archetype === Archetype.Splash;
        vfx.dust(lu.group.position.x, lu.group.position.z, heavy ? 1.9 : 0.8);
        vfx.impact(
          lu.group.position.x, lu.height * 0.4, lu.group.position.z,
          0, 0, lu.hex, heavy ? 1.8 : 1,
        );
        if (heavy) {
          vfx.shockwave(lu.group.position.x, lu.group.position.z, lu.hex, 1.4);
          vfx.kick(0.09);
        }
        // Every fighter here is somebody's bag. Losing one spills coins.
        vfx.coins(lu.group.position.x, lu.height * 0.5, lu.group.position.z,
          heavy ? 9 : 4);
      }
      const faceSign = lu.facing >= 0 ? 1 : -1;
      // Keep billboarding through the death, then roll in screen space. Writing
      // `rotation.z` directly would compose against whatever Euler the camera
      // quaternion last decomposed to, which tips the corpse off-axis.
      lu.sprite.quaternion.copy(camera.quaternion);
      if (lu.archetype === Archetype.Swarm) {
        // Swarm units pop rather than topple: they are small, they die in
        // fours, and four simultaneous slow falls read as a bug.
        const s = (1 - t) * (1 + Math.sin(t * Math.PI) * 0.5);
        lu.sprite.scale.set(lu.height * 0.78 * s * faceSign, lu.height * s, 1);
        lu.sprite.position.y = lu.height * 0.46 + t * 0.9;
      } else {
        // Topple away from whatever killed it, then sink into the grass.
        lu.sprite.rotateZ(-faceSign * t * 1.15);
        lu.sprite.position.y = (lu.height / 2) * (1 - t * 0.62);
      }
      lu.mat.opacity = 1 - t;
      lu.shadowMat.opacity = 0.3 * (1 - t);
      if (t >= 1) {
        root.current.remove(lu.group);
        disposeUnit(lu);
        live.current.delete(id);
      }
    }

    vfx.update(dt, camera);
  });

  return <group ref={root} />;
}
