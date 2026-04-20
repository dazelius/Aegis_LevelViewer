import * as THREE from 'three';
import type { GameObjectNode } from './api';

/**
 * A `PlayerPose` is a complete snapshot of WHAT THE USER WAS LOOKING
 * AT in Play mode — enough to reproduce the exact framing from scratch
 * against the CURRENT level state.
 *
 * Deliberately stores only pose data, never a rendered thumbnail: if a
 * designer updates the level, any feed post pinned to a pose shows the
 * NEW state from the saved vantage point, not a stale snapshot. The
 * feed UI re-renders the mini-preview from these fields whenever the
 * pin is shown.
 *
 * All values are in the Three.js right-handed Y-up world frame (the
 * same frame `scene.roots[*].transform` lives in after server-side
 * Unity→Three coord conversion). `yaw` is rotation around +Y;
 * `aimPoint` is the world-space intersection of the camera center ray
 * with the ground plane.
 */
export interface PlayerPose {
  /** Player's foot position on the ground plane. */
  position: [number, number, number];
  /** Player's facing angle (radians, around +Y). In shoulder view
   *  this tracks `cameraYaw`. Preserved separately so M2+ can later
   *  decouple aim-yaw from body-yaw (lean / turn-in-place). */
  yaw: number;
  /** World-space point the camera's center ray hits the ground. */
  aimPoint: [number, number, number];
  /** Camera look yaw around +Y (radians). Driven by the mouse
   *  horizontally in Play mode. */
  cameraYaw: number;
  /** Camera look pitch (radians). Positive = looking down (mouse
   *  pushed forward). Clamped to ±80° by ShoulderCamera. */
  cameraPitch: number;
  /** Camera-to-player orbit distance. Scroll-wheel adjustable within
   *  the scene-scaled [min, max] clamp. */
  cameraDistance: number;
}

/**
 * Default spawn pose for first-time Play-mode entry in a level. Caller
 * fills `position` from the scene's framing center + floorY, and
 * `cameraDistance` from the framing radius so the zoom level adapts
 * from room-scale to map-scale levels alike.
 */
export function defaultPose(
  position: [number, number, number],
  cameraDistance: number,
): PlayerPose {
  return {
    position,
    yaw: 0,
    aimPoint: [position[0], position[1], position[2] - 1],
    cameraYaw: 0,
    cameraPitch: (10 * Math.PI) / 180,
    cameraDistance,
  };
}

/**
 * Walk `roots` depth-first and return the world position of the first
 * GameObject whose name contains `needle` (case-insensitive). Used to
 * resolve named spawn anchors like `SafetyZone_SM` without having to
 * pre-bake world transforms into the scene JSON.
 *
 * Scene transforms in `GameObjectNode` are LOCAL to the parent, so we
 * accumulate a 4×4 down the hierarchy and read translation from the
 * final matrix. This matches what `sceneToR3F` does at render time,
 * guaranteeing "spawn on SafetyZone" = "spawn at the rendered
 * SafetyZone object". Returns `null` if no match is found.
 */
export function findNodeWorldPosition(
  roots: readonly GameObjectNode[],
  needle: string,
): [number, number, number] | null {
  const target = needle.toLowerCase();

  // Scratch so a typical 300-node scene-wide walk allocates once.
  const local = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();

  function walk(node: GameObjectNode, parent: THREE.Matrix4): THREE.Vector3 | null {
    const t = node.transform;
    pos.set(t.position[0], t.position[1], t.position[2]);
    quat.set(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
    scl.set(t.scale[0], t.scale[1], t.scale[2]);
    local.compose(pos, quat, scl);
    // New Matrix4 per node — cheap (16 floats), and we need a stable
    // parent frame for the recursive siblings.
    const world = new THREE.Matrix4().multiplyMatrices(parent, local);

    if (node.name.toLowerCase().includes(target)) {
      const out = new THREE.Vector3();
      out.setFromMatrixPosition(world);
      return out;
    }
    for (const child of node.children) {
      const found = walk(child, world);
      if (found) return found;
    }
    return null;
  }

  const identity = new THREE.Matrix4();
  for (const root of roots) {
    const found = walk(root, identity);
    if (found) return [found.x, found.y, found.z];
  }
  return null;
}
