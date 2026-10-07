import * as THREE from 'three';

/**
 * Battle effects: sparks, dust, shockwave rings, and flying shots.
 *
 * Everything here is presentation only and never feeds back into the sim — the
 * simulation is deterministic lockstep and must produce the same state hash on
 * both clients, so a particle can never be allowed to influence it. That is also
 * why this module uses `Math.random` freely: it is deliberately outside the
 * simulated world, unlike `sim/` which may only use the seeded xorshift.
 *
 * It is a **pool**, not an allocator. A crowded push can put forty units in
 * contact at once, each landing a hit twice a second; allocating a mesh and a
 * material per spark would hand the GC a steady stream of garbage and stutter
 * the frame exactly when the screen is busiest. Meshes are created once, parked
 * invisible, and reused.
 */

/** Hard ceilings. Past these, new effects are dropped rather than queued —
 *  during a big push nobody can distinguish 90 sparks from 140, but everyone
 *  can feel the frame the allocator lost. */
const MAX_PARTICLES = 140;
const MAX_SHOTS = 40;

interface Particle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vx: number; vy: number; vz: number;
  drag: number;
  gravity: number;
  life: number;
  maxLife: number;
  from: number; // scale at birth
  to: number; // scale at death
  spin: number;
  opacity: number;
  /** Ground decals stay flat; sparks turn to face the camera. */
  flat: boolean;
}

interface Shot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  speed: number;
  arc: number;
  /** Fired when the shot lands, so the impact reads as caused by the shot. */
  onArrive?: (at: THREE.Vector3) => void;
}

/** Soft round sprite — one texture behind every spark, puff and shot. */
function softDot(): THREE.Texture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.85)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Four-point star, for impact sparks. Reads as a hit; a dot reads as smoke. */
function sparkDot(): THREE.Texture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d')!;
  g.translate(S / 2, S / 2);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.beginPath();
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2;
    const b = a + Math.PI / 4;
    g.lineTo(Math.cos(a) * S * 0.5, Math.sin(a) * S * 0.5);
    g.lineTo(Math.cos(b) * S * 0.11, Math.sin(b) * S * 0.11);
  }
  g.closePath();
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

class Vfx {
  readonly group = new THREE.Group();

  private quad = new THREE.PlaneGeometry(1, 1);

  private ringGeo = new THREE.RingGeometry(0.62, 0.78, 28);

  private dotTex: THREE.Texture | null = null;

  private starTex: THREE.Texture | null = null;

  private live: Particle[] = [];

  private idle: Particle[] = [];

  private shots: Shot[] = [];

  private idleShots: Shot[] = [];

  private tmp = new THREE.Vector3();

  /** Current camera-shake energy, decaying. Read by the camera rig. */
  private shakeAmt = 0;

  /** Seeded so a shake is smooth noise rather than per-frame static. */
  private shakeT = 0;

  constructor() {
    // Effects are additive-ish overlays: they must never occlude a unit, and
    // sorting them against each other is wasted work at this size.
    this.group.renderOrder = 900;
  }

  /** Lazily built so this module can be imported outside a browser (tests). */
  private tex(star: boolean): THREE.Texture {
    if (star) {
      this.starTex ??= sparkDot();
      return this.starTex;
    }
    this.dotTex ??= softDot();
    return this.dotTex;
  }

  private take(star: boolean, flat: boolean): Particle | null {
    if (this.live.length >= MAX_PARTICLES) return null;
    const p = this.idle.pop();
    if (p) {
      p.mat.map = this.tex(star);
      p.mat.needsUpdate = true;
      p.flat = flat;
      p.mesh.visible = true;
      this.live.push(p);
      return p;
    }
    const mat = new THREE.MeshBasicMaterial({
      map: this.tex(star),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.quad, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const np: Particle = {
      mesh,
      mat,
      vx: 0, vy: 0, vz: 0,
      drag: 2, gravity: 0, life: 0, maxLife: 1,
      from: 1, to: 1, spin: 0, opacity: 1, flat,
    };
    this.live.push(np);
    return np;
  }

  /**
   * A hit landing. Sparks fly outward from the impact point, biased along the
   * blow's direction so the burst reads as "struck from over there" rather than
   * as a generic explosion.
   */
  impact(
    x: number, y: number, z: number,
    dirX: number, dirZ: number,
    color: THREE.ColorRepresentation,
    strength = 1,
  ): void {
    const n = Math.round(4 + strength * 4);
    for (let i = 0; i < n; i += 1) {
      const p = this.take(true, false);
      if (!p) return;
      const a = Math.random() * Math.PI * 2;
      const spread = 2.2 + Math.random() * 3.4;
      p.mesh.position.set(x, y, z);
      // Two thirds of the blow direction plus a third scatter: directional but
      // not a rigid fan.
      p.vx = dirX * spread * 0.66 + Math.cos(a) * spread * 0.4;
      p.vz = dirZ * spread * 0.66 + Math.sin(a) * spread * 0.4;
      p.vy = 1.4 + Math.random() * 3.2;
      p.drag = 5.5;
      p.gravity = -9;
      p.maxLife = 0.22 + Math.random() * 0.16;
      p.life = p.maxLife;
      p.from = 0.42 + Math.random() * 0.3 * strength;
      p.to = 0.04;
      p.spin = (Math.random() - 0.5) * 9;
      p.opacity = 0.95;
      p.mat.color.set(color);
      p.mat.blending = THREE.AdditiveBlending;
    }
  }

  /**
   * Ground dust: a landing, a heavy footfall, a body hitting the grass. Flat to
   * the ground and un-lit, so it reads as kicked-up dirt rather than a puff of
   * smoke floating at chest height.
   */
  dust(x: number, z: number, strength = 1): void {
    const n = Math.round(3 + strength * 3);
    for (let i = 0; i < n; i += 1) {
      const p = this.take(false, true);
      if (!p) return;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.3 * strength;
      p.mesh.position.set(x + Math.cos(a) * r, 0.05 + Math.random() * 0.1, z + Math.sin(a) * r);
      const out = (1.1 + Math.random() * 1.5) * strength;
      p.vx = Math.cos(a) * out;
      p.vz = Math.sin(a) * out;
      p.vy = 0.15;
      p.drag = 3.4;
      p.gravity = 0;
      p.maxLife = 0.42 + Math.random() * 0.3;
      p.life = p.maxLife;
      p.from = 0.3 * strength;
      p.to = 1.5 * strength;
      p.spin = (Math.random() - 0.5) * 2;
      p.opacity = 0.42;
      p.mat.color.set('#d8c9a4');
      // Dirt is opaque, not glowing; additive dust over bright grass vanishes.
      p.mat.blending = THREE.NormalBlending;
    }
  }

  /**
   * A burst of coins. Every fighter on this board is somebody's bag, so a unit
   * dying spills its holdings — the one death cue that could only belong to this
   * game, and the reason it is worth spending particles on rather than reusing
   * the generic spark.
   */
  coins(x: number, y: number, z: number, n = 6): void {
    for (let i = 0; i < n; i += 1) {
      const p = this.take(false, false);
      if (!p) return;
      const a = Math.random() * Math.PI * 2;
      const out = 1.6 + Math.random() * 2.4;
      p.mesh.position.set(x, y, z);
      p.vx = Math.cos(a) * out;
      p.vz = Math.sin(a) * out;
      p.vy = 3.6 + Math.random() * 2.8;
      p.drag = 1.4;
      p.gravity = -11;
      p.maxLife = 0.6 + Math.random() * 0.28;
      p.life = p.maxLife;
      p.from = 0.3;
      p.to = 0.16;
      // Tumbling, so a flat disc reads as a spinning coin rather than a dot.
      p.spin = (Math.random() - 0.5) * 16;
      p.opacity = 1;
      p.mat.color.set('#ffcc3d');
      p.mat.blending = THREE.NormalBlending;
    }
  }

  /**
   * A single bright bloom. Used as the muzzle flash on a ranged shot, where the
   * shot itself leaves the unit too fast to say where it came from.
   */
  flash(x: number, y: number, z: number, color: THREE.ColorRepresentation, size = 1): void {
    const p = this.take(false, false);
    if (!p) return;
    p.mesh.position.set(x, y, z);
    p.vx = 0; p.vz = 0; p.vy = 0; p.drag = 1; p.gravity = 0;
    p.maxLife = 0.13;
    p.life = p.maxLife;
    p.from = 1.5 * size;
    p.to = 0.2 * size;
    p.spin = 0;
    p.opacity = 0.95;
    p.mat.color.set(color);
    p.mat.blending = THREE.AdditiveBlending;
  }

  /** Expanding ground ring — a deploy landing, or a death throwing its weight. */
  shockwave(x: number, z: number, color: THREE.ColorRepresentation, strength = 1): void {
    const p = this.take(false, true);
    if (!p) return;
    p.mesh.geometry = this.ringGeo;
    p.mesh.position.set(x, 0.06, z);
    p.vx = 0; p.vz = 0; p.vy = 0; p.drag = 1; p.gravity = 0;
    p.maxLife = 0.42;
    p.life = p.maxLife;
    p.from = 0.4 * strength;
    p.to = 3.2 * strength;
    p.spin = 0;
    p.opacity = 0.8;
    p.mat.color.set(color);
    p.mat.blending = THREE.AdditiveBlending;
    p.mat.map = null;
    p.mat.needsUpdate = true;
  }

  /**
   * A flying shot. Ranged and splash units resolve damage instantly in the sim,
   * so without this an archer five tiles away simply stands still while its
   * target melts — the single most confusing thing on the field. The shot is
   * cosmetic and its flight time is not simulated; it is timed to look right.
   */
  shot(
    from: THREE.Vector3, to: THREE.Vector3,
    color: THREE.ColorRepresentation,
    arc = 0.9,
    onArrive?: (at: THREE.Vector3) => void,
  ): void {
    if (this.shots.length >= MAX_SHOTS) return;
    let s = this.idleShots.pop();
    if (!s) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.tex(false),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.quad, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      s = {
        mesh, mat, from: new THREE.Vector3(), to: new THREE.Vector3(),
        t: 0, speed: 1, arc,
      };
    }
    s.mesh.visible = true;
    s.mat.map = this.tex(false);
    s.mat.color.set(color);
    s.mat.opacity = 1;
    s.mesh.geometry = this.quad;
    s.from.copy(from);
    s.to.copy(to);
    s.t = 0;
    s.arc = arc;
    s.onArrive = onArrive;
    // Constant flight *speed*, not constant duration: a shot that takes the
    // same time to cross one tile as it does to cross five looks weightless.
    s.speed = Math.max(1.6, 9 / Math.max(1, from.distanceTo(to)));
    this.shots.push(s);
  }

  /**
   * Kick the camera. Reserved for things that genuinely hit the world — a tower
   * losing hit points, a heavy unit going down, a spell landing. Cheap enough to
   * over-use and the first thing to make a game feel like mush if you do, so the
   * total is capped: ten simultaneous impacts must not shake ten times as hard.
   */
  kick(amount: number): void {
    // Camera shake is the one effect here that moves the whole frame, which is
    // exactly what a vestibular-motion sensitivity reacts to. Particles stay —
    // they are local and small — but nothing shakes the viewport. Read live
    // rather than cached so toggling the OS setting takes effect immediately.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    this.shakeAmt = Math.min(0.55, this.shakeAmt + amount);
  }

  /**
   * Camera-shake offset for this frame, in world units, written into `out`.
   *
   * Smooth trig noise rather than random per frame: white noise at 60fps reads
   * as a rendering fault, where a fast decaying wobble reads as impact. Deploy
   * taps raycast through this camera, but the offset peaks at roughly a third of
   * a tile from 38 units up and is gone inside 300ms, so the worst case is a
   * drop landing a few pixels off where it was released.
   */
  shakeOffset(dt: number, out: THREE.Vector3): void {
    if (this.shakeAmt <= 0.0005) {
      this.shakeAmt = 0;
      out.set(0, 0, 0);
      return;
    }
    this.shakeT += dt;
    const a = this.shakeAmt;
    out.set(
      Math.sin(this.shakeT * 47) * a,
      Math.sin(this.shakeT * 61 + 1.7) * a * 0.55,
      Math.cos(this.shakeT * 53 + 0.9) * a,
    );
    this.shakeAmt *= Math.exp(-dt * 9);
  }

  /** Advance every effect. Called once per frame from the scene. */
  update(dt: number, camera: THREE.Camera): void {
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const p = this.live[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        p.mesh.geometry = this.quad;
        this.live.splice(i, 1);
        this.idle.push(p);
        continue;
      }
      const t = 1 - p.life / p.maxLife;
      const decay = Math.exp(-dt * p.drag);
      p.vx *= decay; p.vz *= decay;
      p.vy = p.vy * decay + p.gravity * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      if (p.mesh.position.y < 0.04) { p.mesh.position.y = 0.04; p.vy = 0; }

      const s = p.from + (p.to - p.from) * t;
      p.mesh.scale.set(s, s, s);
      if (p.flat) {
        p.mesh.rotation.set(-Math.PI / 2, 0, p.mesh.rotation.z + p.spin * dt);
      } else {
        p.mesh.quaternion.copy(camera.quaternion);
        p.mesh.rotateZ(p.spin * (1 - p.life / p.maxLife) * 2);
      }
      // Fade out on a curve rather than linearly: a linear fade holds visible
      // far too long and the field never looks clean.
      p.mat.opacity = p.opacity * (1 - t) ** 1.6;
    }

    for (let i = this.shots.length - 1; i >= 0; i -= 1) {
      const s = this.shots[i];
      s.t += dt * s.speed;
      if (s.t >= 1) {
        this.tmp.copy(s.to);
        s.mesh.visible = false;
        this.shots.splice(i, 1);
        this.idleShots.push(s);
        s.onArrive?.(this.tmp);
        s.onArrive = undefined;
        continue;
      }
      s.mesh.position.lerpVectors(s.from, s.to, s.t);
      s.mesh.position.y += Math.sin(s.t * Math.PI) * s.arc;
      s.mesh.quaternion.copy(camera.quaternion);
      // Grows toward the target so it reads as approaching the viewer's focus.
      const sc = 0.34 + s.t * 0.16;
      s.mesh.scale.set(sc, sc, sc);
      s.mat.opacity = 1;
    }
  }

  /** Clear everything without disposing the pool — used when a match ends. */
  reset(): void {
    for (const p of this.live) { p.mesh.visible = false; p.mesh.geometry = this.quad; }
    this.idle.push(...this.live);
    this.live.length = 0;
    for (const s of this.shots) { s.mesh.visible = false; s.onArrive = undefined; }
    this.idleShots.push(...this.shots);
    this.shots.length = 0;
    this.shakeAmt = 0;
  }
}

/**
 * One shared instance. Module state rather than context because the unit
 * renderer emits effects from inside a `useFrame` hot loop, where a context read
 * per hit would be pure overhead — and because there is only ever one arena.
 */
export const vfx = new Vfx();
