import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

/**
 * A set of axis-aligned boxes sharing one material, drawn in one call.
 *
 * The arena is built from a lot of static rectangular pieces — tiers, walls,
 * gold rules, frame rails, lintels. Written the obvious way that is one draw
 * call each, and a draw call is CPU work in the driver rather than GPU work:
 * on a machine four times slower than a modern laptop the board was spending
 * 64ms in its worst frames with nothing moving on it.
 *
 * They are all boxes with the same material, so they are all the same call
 * with a different matrix. An InstancedMesh of a unit cube, scaled per
 * instance, collapses a whole group to one — and unlike merging geometries it
 * needs no extra dependency and stays readable at the call site.
 *
 * Only for pieces that never move. Anything animated should stay its own mesh
 * rather than rewriting the instance buffer every frame.
 */
export interface Box {
  /** Centre, in world units. */
  pos: readonly [number, number, number];
  /** Full size on each axis, not half-extents. */
  size: readonly [number, number, number];
}

export function Boxes({
  boxes,
  children,
  castShadow = false,
  receiveShadow = false,
}: {
  boxes: Box[];
  /** The material, as a single JSX child. */
  children: React.ReactNode;
  castShadow?: boolean;
  receiveShadow?: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    boxes.forEach((b, i) => {
      dummy.position.set(b.pos[0], b.pos[1], b.pos[2]);
      dummy.scale.set(b.size[0], b.size[1], b.size[2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    // The bounding sphere is computed from the base geometry, which is a unit
    // cube at the origin — so without this every one of these is frustum
    // culled the moment the camera is not looking at world zero.
    mesh.computeBoundingSphere();
  }, [boxes, dummy]);

  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, boxes.length]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      <boxGeometry args={[1, 1, 1]} />
      {children}
    </instancedMesh>
  );
}

/**
 * The same idea for small spheres — bridge finials, banner tops.
 *
 * Separate from `Boxes` because the geometry differs; sharing one component
 * would mean branching on a geometry prop, and two twenty-line components are
 * easier to read than one thirty-line one with a switch in it.
 */
export function Spheres({
  at, r, children,
}: {
  at: readonly (readonly [number, number, number])[];
  r: number;
  children: React.ReactNode;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    at.forEach((p, i) => {
      dummy.position.set(p[0], p[1], p[2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [at, dummy]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, at.length]}>
      <sphereGeometry args={[r, 8, 6]} />
      {children}
    </instancedMesh>
  );
}
