import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

import {
  listPeers,
  subscribePeers,
  type Peer,
} from './multiplayer';

/**
 * Renders every remote player in the current room as a simple
 * capsule + overhead name label.
 *
 * Why not reuse `CharacterAvatar` for remote players:
 *
 *   1. `loadPlayerCharacter` caches a single `THREE.Group` instance,
 *      so we can only mount the skinned mesh + skeleton at ONE place
 *      in the scene graph — adding a second remote player would
 *      reparent the cached group and delete it from the local
 *      player's spot. Proper multi-instance support needs
 *      `SkeletonUtils.clone` which has its own quirks we don't
 *      want to debug in the same pass as wiring up the network.
 *
 *   2. CharacterAvatar reads and writes `playModeState` for muzzle
 *      tracking + recoil. That module-level singleton is tuned for
 *      the local player; duplicating it for remotes would need a
 *      larger refactor (per-instance state object threaded through
 *      every consumer).
 *
 * The capsule placeholder gets us the "there's another human walking
 * past me" feel today. Future work: swap the capsule for a cloned
 * striker mesh with its own AnimationMixer.
 *
 * Smoothing: we LERP from the last-rendered transform to whatever the
 * network said in the most recent pose message. At a 60 Hz tick and
 * ~20-60 Hz pose broadcasts this reads as smooth walking even with
 * mild packet jitter. A proper pose-buffer interpolator would use two
 * historical samples and time-shift, but single-sample LERP is enough
 * at M1 scale.
 */
export function RemotePlayers() {
  const [peers, setPeers] = useState<Peer[]>(() => listPeers());

  useEffect(() => {
    const unsub = subscribePeers(() => setPeers(listPeers()));
    setPeers(listPeers());
    return unsub;
  }, []);

  if (peers.length === 0) return null;

  return (
    <group userData={{ noCollide: true }}>
      {peers.map((p) => (
        <RemotePlayerAvatar key={p.id} peer={p} />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------

const PLAYER_HEIGHT = 1.8; // metres, approximate striker_low tall
const PLAYER_RADIUS = 0.35; // matches PlayerController.playerRadius
const CROUCH_FACTOR = 0.6; // rough crouch silhouette

const LERP_POS = 12; // 1/s; ≈ 80ms to settle. Higher = snappier, lower = smoother
const LERP_YAW = 12;

function RemotePlayerAvatar({ peer }: { peer: Peer }) {
  const groupRef = useRef<THREE.Group>(null);
  const nameSpriteRef = useRef<THREE.Sprite | null>(null);

  // Target pose updated from the latest network sample via a closure
  // over peer — we read `peer.pose` every frame rather than snapshotting
  // at mount because the multiplayer manager mutates the same Peer
  // object in place when new poses arrive.
  const targetPos = useMemo(() => new THREE.Vector3(), []);

  // Keep these in refs so useFrame can mutate without re-rendering.
  const currentYawRef = useRef<number>(0);
  const initRef = useRef(false);

  // Cheap material palette — colour each remote player by hashing
  // their id so "bob" stays blue across the session. Not unique
  // across >16 players but the collision rate is tolerable.
  const color = useMemo(() => colorForId(peer.id), [peer.id]);

  // Build a name-tag sprite once per peer. Rebuilt when the nickname
  // changes (peer join → empty nickname → peer_join updates it shortly
  // after; we key on nickname so React replaces the sprite).
  useEffect(() => {
    const tex = makeNameTagTexture(peer.nickname || 'Guest', color);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false, // always visible through geometry
      depthWrite: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.raycast = () => {}; // never collide
    sprite.userData.noCollide = true;
    sprite.renderOrder = 9999;
    // Aspect-corrected scale: tex is 256×64 so keep a 4:1 ratio.
    sprite.scale.set(1.4, 0.35, 1);
    nameSpriteRef.current = sprite;
    return () => {
      tex.dispose();
      mat.dispose();
      nameSpriteRef.current = null;
    };
  }, [peer.nickname, color]);

  useFrame((_state, dt) => {
    const g = groupRef.current;
    if (!g) return;
    const pose = peer.pose;
    if (!pose || !pose.visible) {
      // Hide the whole group — edit-mode lurkers or freshly joined
      // players whose first pose hasn't arrived. Still mounted so
      // we don't churn React on transient visibility flips.
      g.visible = false;
      return;
    }
    g.visible = true;
    targetPos.set(pose.position[0], pose.position[1], pose.position[2]);

    if (!initRef.current) {
      g.position.copy(targetPos);
      currentYawRef.current = pose.yaw;
      g.rotation.y = pose.yaw;
      initRef.current = true;
    } else {
      // Frame-rate-independent exponential decay lerp — `dt * LERP`
      // is the fraction of the gap we close this frame.
      const tPos = 1 - Math.exp(-dt * LERP_POS);
      g.position.lerp(targetPos, tPos);
      const tYaw = 1 - Math.exp(-dt * LERP_YAW);
      currentYawRef.current = lerpAngle(currentYawRef.current, pose.yaw, tYaw);
      g.rotation.y = currentYawRef.current;
    }

    // Crouch squash — subtle, so remote players in Play still
    // register as "the small one is crouched".
    const targetScaleY = pose.crouching ? CROUCH_FACTOR : 1;
    const ys = g.scale.y;
    const tScale = 1 - Math.exp(-dt * 10);
    g.scale.y = ys + (targetScaleY - ys) * tScale;
  });

  return (
    <group ref={groupRef} userData={{ noCollide: true }}>
      {/* Body capsule. Centred at y = PLAYER_HEIGHT/2 so group.position
          = feet. matches PlayerController's convention. */}
      <mesh
        position={[0, PLAYER_HEIGHT / 2, 0]}
        castShadow={false}
        receiveShadow={false}
        userData={{ noCollide: true }}
        raycast={noopRaycast}
      >
        <capsuleGeometry args={[PLAYER_RADIUS, PLAYER_HEIGHT - 2 * PLAYER_RADIUS, 6, 12]} />
        <meshStandardMaterial color={color} roughness={0.75} metalness={0.1} />
      </mesh>
      {/* A tiny "nose" cone so you can instantly tell which way the
          remote player is facing, without having to wait for a run
          animation. Points along local +Z, matching the character
          rig's forward axis and PlayerController's yaw convention. */}
      <mesh
        position={[0, PLAYER_HEIGHT * 0.65, PLAYER_RADIUS * 0.9]}
        rotation={[Math.PI / 2, 0, 0]}
        userData={{ noCollide: true }}
        raycast={noopRaycast}
      >
        <coneGeometry args={[0.07, 0.18, 10]} />
        <meshStandardMaterial color="#ffffff" roughness={0.6} metalness={0.1} />
      </mesh>
      {/* Name tag hovering above the head. Floats at a fixed world-
          space offset; depthTest is off so walls don't hide it — the
          label is always the most important readability cue. */}
      {nameSpriteRef.current && (
        <primitive
          object={nameSpriteRef.current}
          position={[0, PLAYER_HEIGHT + 0.25, 0]}
        />
      )}
    </group>
  );
}

function noopRaycast(): void {
  // Keep the raycaster away from remote player geometry so the
  // local player's wall / ground / aim probes can't collide with
  // them.
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Stable-ish HSL colour per id via a cheap 32-bit hash. Keeps the
 *  same player rendered in the same colour across a session. */
function colorForId(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function makeNameTagTexture(name: string, borderColor: string): THREE.Texture {
  const w = 512;
  const h = 128;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (ctx) {
    // Pill-shaped background.
    const radius = h / 2;
    ctx.fillStyle = 'rgba(12, 14, 20, 0.85)';
    ctx.beginPath();
    ctx.moveTo(radius, 0);
    ctx.lineTo(w - radius, 0);
    ctx.arc(w - radius, h / 2, radius, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(radius, h);
    ctx.arc(radius, h / 2, radius, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.closePath();
    ctx.fill();

    // Colour stripe along the bottom so a glance at the label carries
    // the same per-player colour the capsule uses.
    ctx.fillStyle = borderColor;
    ctx.fillRect(radius - 4, h - 10, w - 2 * (radius - 4), 6);

    // Text.
    ctx.fillStyle = '#f0f3f8';
    ctx.font = 'bold 58px "Segoe UI", Tahoma, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, w / 2, h / 2 - 4, w - 40);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Shortest-arc lerp between two yaw angles, so wrapping past ±π
 *  doesn't make a remote avatar spin the long way round. */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * t;
}
