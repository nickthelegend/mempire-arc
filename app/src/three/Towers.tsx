import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { PALETTE } from '../lib/palette';
import { FP } from '../sim/fixed';
import type { Tower } from '../sim/types';
import { useMatch } from '../state/match';

const STONE = '#c9cbd2';
const STONE_DARK = '#9fa2ac';
const TRIM_OWN = '#2f6fd0';
const TRIM_ENEMY = '#d0392f';

/**
 * A tower reads as a fortification: a stepped stone base, crenellations, and a
 * cannon or crown on top. Cylinders never looked like something you defend.
 *
 * The HP bar is billboarded and carries a crown, matching what players of the
 * genre already know how to read at a glance.
 */
export function TowerMesh({ index }: { index: number }) {
  const group = useRef<THREE.Group>(null);
  const barGroup = useRef<THREE.Group>(null);
  const barFill = useRef<THREE.Mesh>(null);
  const barMat = useRef<THREE.MeshBasicMaterial>(null);
  const turret = useRef<THREE.Group>(null);
  const lastHp = useRef(Infinity);
  const shake = useRef(0);

  const sim0 = useMatch.getState().sim;
  const spec = useMemo(() => {
    if (!sim0) return null;
    const t = sim0.towers[index];
    return {
      isKing: t.kind === 'king',
      x: t.x / FP,
      z: t.y / FP,
      // friendly is this client's seat, which is player 1 for the second
      // human in a match — never a hardcoded 0
      own: t.owner === useMatch.getState().perspective,
    };
  }, [index, sim0]);

  useFrame(({ camera }, dt) => {
    const sim = useMatch.getState().sim;
    if (!sim || !group.current) return;
    const t: Tower = sim.towers[index];
    const pct = Math.max(0, t.hp / t.maxHp);

    group.current.visible = t.hp > 0;
    if (barFill.current) barFill.current.scale.x = Math.max(0.001, pct);
    if (barMat.current) {
      // green while healthy, red when hurt — gold is money, never damage
      barMat.current.color.set(
        pct > 0.4
          ? (t.owner === useMatch.getState().perspective ? '#4fd14f' : '#ff6b5a')
          : PALETTE.red,
      );
    }
    barGroup.current?.quaternion.copy(camera.quaternion);

    // recoil on damage, so incoming fire is felt not just counted
    if (t.hp < lastHp.current) shake.current = 0.18;
    lastHp.current = t.hp;
    if (shake.current > 0) {
      shake.current = Math.max(0, shake.current - dt);
      const k = shake.current / 0.18;
      group.current.position.y = -k * 0.14;
      group.current.rotation.z = Math.sin(shake.current * 90) * k * 0.035;
    } else {
      group.current.position.y = 0;
      group.current.rotation.z = 0;
    }

    // turret tracks the nearest enemy it could fire on
    if (turret.current) {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (const u of sim.units) {
        if (u.owner === t.owner || u.hp <= 0) continue;
        const d = (u.x - t.x) ** 2 + (u.y - t.y) ** 2;
        if (d < bestD) { bestD = d; best = { x: u.x, y: u.y }; }
      }
      if (best) {
        const want = Math.atan2(best.x / FP - (t.x / FP), best.y / FP - (t.y / FP));
        let delta = want - turret.current.rotation.y;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        turret.current.rotation.y += delta * Math.min(1, dt * 6);
      }
    }
  });

  if (!spec) return null;
  const { isKing, x, z, own } = spec;
  const trim = own ? TRIM_OWN : TRIM_ENEMY;
  const baseW = isKing ? 3.0 : 2.3;
  const h1 = isKing ? 1.1 : 0.9;   // lower block
  const h2 = isKing ? 0.9 : 0.7;   // upper block
  const top = h1 + h2;

  return (
    <group ref={group} position={[x, 0, z]}>
      {/* lower stone block */}
      <mesh position={[0, h1 / 2, 0]}>
        <boxGeometry args={[baseW, h1, baseW]} />
        <meshStandardMaterial color={STONE_DARK} roughness={0.88} />
      </mesh>
      {/* upper block, inset */}
      <mesh position={[0, h1 + h2 / 2, 0]}>
        <boxGeometry args={[baseW * 0.78, h2, baseW * 0.78]} />
        <meshStandardMaterial color={STONE} roughness={0.85} />
      </mesh>
      {/* crenellations around the rim */}
      {Array.from({ length: 4 }).flatMap((_, side) => (
        Array.from({ length: 3 }).map((__, i) => {
          const span = baseW * 0.78;
          const off = (i - 1) * (span / 2.6);
          const edge = span / 2;
          const pos: [number, number, number] = side === 0
            ? [off, top + 0.13, -edge]
            : side === 1
              ? [off, top + 0.13, edge]
              : side === 2
                ? [-edge, top + 0.13, off]
                : [edge, top + 0.13, off];
          return (
            <mesh key={`${side}-${i}`} position={pos}>
              <boxGeometry args={[0.32, 0.3, 0.32]} />
              <meshStandardMaterial color={STONE} roughness={0.85} />
            </mesh>
          );
        })
      ))}
      {/* coloured band identifying the side */}
      <mesh position={[0, h1 + 0.06, 0]}>
        <boxGeometry args={[baseW * 0.82, 0.16, baseW * 0.82]} />
        <meshStandardMaterial color={trim} roughness={0.6} />
      </mesh>

      {/* king wears a crown; princess towers get a cannon */}
      {isKing ? (
        <group position={[0, top + 0.42, 0]}>
          <mesh>
            <cylinderGeometry args={[0.5, 0.42, 0.26, 8]} />
            <meshStandardMaterial color={PALETTE.gold} metalness={0.6} roughness={0.32} />
          </mesh>
          {Array.from({ length: 5 }).map((_, i) => {
            const a = (i / 5) * Math.PI * 2;
            return (
              <mesh key={i} position={[Math.cos(a) * 0.4, 0.26, Math.sin(a) * 0.4]}>
                <coneGeometry args={[0.13, 0.34, 4]} />
                <meshStandardMaterial
                  color={PALETTE.goldHi}
                  metalness={0.7}
                  roughness={0.26}
                  emissive={PALETTE.gold}
                  emissiveIntensity={0.3}
                />
              </mesh>
            );
          })}
        </group>
      ) : (
        <group ref={turret} position={[0, top + 0.3, 0]}>
          <mesh>
            <sphereGeometry args={[0.34, 12, 10]} />
            <meshStandardMaterial color="#4a4f5c" roughness={0.5} metalness={0.4} />
          </mesh>
          <mesh position={[0, 0.06, 0.44]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.13, 0.16, 0.88, 10]} />
            <meshStandardMaterial color="#3c414d" roughness={0.45} metalness={0.5} />
          </mesh>
        </group>
      )}

      {/* HP bar with a crown, billboarded */}
      <group ref={barGroup} position={[0, top + (isKing ? 1.35 : 1.15), 0]}>
        <mesh>
          <planeGeometry args={[2.0, 0.32]} />
          <meshBasicMaterial color="#1a1f2e" />
        </mesh>
        <mesh position={[0, 0, 0.01]}>
          <planeGeometry args={[1.9, 0.22]} />
          <meshBasicMaterial color="#0d1120" />
        </mesh>
        <mesh ref={barFill} position={[0, 0, 0.02]}>
          <planeGeometry args={[1.9, 0.22]} />
          <meshBasicMaterial ref={barMat} color="#4fd14f" />
        </mesh>
        <mesh position={[-1.06, 0, 0.02]}>
          <circleGeometry args={[0.19, 14]} />
          <meshBasicMaterial color={trim} />
        </mesh>
      </group>
    </group>
  );
}
