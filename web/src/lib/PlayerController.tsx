import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';

import type { PlayerPose } from './playerPose';
import { CharacterAvatar, type AnimState } from './CharacterAvatar';
import { playModeState } from './playModeState';

/**
 * Third-person shoulder-view player controller with basic physics.
 *
 * Owns the player's world transform, aim state, and vertical velocity
 * every frame. Reads keyboard for locomotion + jump, and raycasts the
 * live R3F scene for ground detection and wall collision. The core
 * loop is:
 *
 *   1. Read WASD → camera-relative XZ intent.
 *   2. Apply gravity to vy. Space → jump impulse if grounded.
 *   3. Axis-separated XZ move: raycast along X (then Z), shrink the
 *      intended delta to (hit.distance − playerRadius) on contact so
 *      we "slide" along walls instead of stopping dead on a diagonal.
 *   4. Vertical move: raycast straight down from waist-height, snap
 *      to groundY if we would otherwise pass through it. Otherwise
 *      free-fall by vy·dt.
 *   5. Rotate body to match camera yaw, recompute aim (center
 *      screen-ray → geometry hit), update reticle positions.
 *
 * Design notes:
 *
 * - Scene membership = collider membership. The user's instruction
 *   was "지금 메시가 그려진 부분들은 다 콜라이더로 설정해줘" —
 *   i.e. level geometry blocks, helpers/UI don't. We enforce that by
 *   raycasting the whole R3F `scene` and filtering any hit whose
 *   object (or ancestor) has `userData.noCollide = true`. The player
 *   group, aim reticle, and drei's `<Grid>` + `<axesHelper>` in
 *   LevelViewer are all tagged that way.
 *
 * - Axis-separated collision gives "slide along walls" for free with
 *   two raycasts per frame. Real capsule vs. mesh collision would be
 *   strictly better but is 5× the code and not required for M1's
 *   "walk the level" goal.
 *
 * - No `floorY` prop: gravity + per-frame ground raycast supersedes
 *   the flat-plane assumption from the first cut. The player spawns
 *   at whatever `initialPose.position` says and falls onto the
 *   nearest downward surface.
 */
export interface PlayerControllerHandle {
  /** Current pose. Safe to call from outside the R3F render loop. */
  getPose(): PlayerPose;
  /** Live mutable reference to the player group. ShoulderCamera
   *  follows this each frame without copying state. */
  group: THREE.Group | null;
}

export interface PlayerControllerProps {
  /** Position / yaw / aim to initialise the player with. The controller
   *  snaps to these on mount and whenever the prop identity changes
   *  (e.g. user clicks "jump to pose" on a feed post in M4). */
  initialPose: PlayerPose;
  /** Walking speed in world units per second. Default 4.5 — spec'd
   *  by the user from the Aegis weapon speed table
   *  (스위프트 AR, Hip = 4.50 m/s). */
  moveSpeed?: number;
  /** Multiplier when Shift is held. */
  sprintMultiplier?: number;
  /** Aegis table entry for "Hip+Fire" — while the trigger is held,
   *  the player slows to this fraction of `moveSpeed`. Default 0.6
   *  (= 2.7 m/s @ 4.5 m/s base) per the table. */
  firingMoveMultiplier?: number;
  /** Multiplier while `playModeState.crouching` is true. Default
   *  0.4 (= 1.8 m/s @ 4.5 m/s base) — reads as a deliberate tactical
   *  crouch-walk, slower than Hip+Fire but not glacial. Stacks
   *  multiplicatively with `firingMoveMultiplier` when the player
   *  also fires while crouched. */
  crouchMoveMultiplier?: number;
  /** Gravity in m/s² applied to vertical velocity. Earth-real 9.81
   *  feels floaty in a shooter; 22 gives a snappy apex without being
   *  cartoony. */
  gravity?: number;
  /** Initial vertical velocity when Space is pressed while grounded.
   *  6.5 m/s + 22 m/s² gravity → ~1 m peak jump, enough to hop onto a
   *  crate but not to clear a 2-storey wall. */
  jumpSpeed?: number;
  /** Capsule "radius" used as a skin offset for wall raycasts so the
   *  player stops ~0.35 m short of a wall rather than embedding its
   *  geometric centre in it. */
  playerRadius?: number;
}

export const PlayerController = forwardRef<PlayerControllerHandle, PlayerControllerProps>(
  function PlayerController(
    {
      initialPose,
      moveSpeed = 4.5,
      sprintMultiplier = 1.8,
      firingMoveMultiplier = 0.6,
      crouchMoveMultiplier = 0.4,
      gravity = 22,
      jumpSpeed = 6.5,
      playerRadius = 0.35,
    },
    handleRef,
  ) {
    const groupRef = useRef<THREE.Group>(null);
    const yawRef = useRef<number>(initialPose.yaw);
    const aimRef = useRef<THREE.Vector3>(
      new THREE.Vector3(
        initialPose.aimPoint[0],
        initialPose.aimPoint[1],
        initialPose.aimPoint[2],
      ),
    );
    const vyRef = useRef(0);
    const onGroundRef = useRef(false);
    // Driven each frame from (grounded × velocity) → CharacterAvatar
    // reads this via ref and crossfades between clips. A ref instead
    // of state because animation transitions are a sub-frame concern
    // we don't want triggering React reconciliation.
    const animStateRef = useRef<AnimState>('idle');
    // "Just left the ground this frame" flag so we can transition
    // idle→jumpStart (one-shot) then jumpStart→jumpLoop after its
    // nominal duration. Held in a ref so we can inspect it without
    // re-rendering.
    const jumpPhaseRef = useRef<{ phase: 'grounded' | 'start' | 'loop' | 'end'; since: number }>({
      phase: 'grounded',
      since: 0,
    });
    const heldKeys = useHeldKeys();
    const { camera, scene } = useThree();

    // Shared raycaster — re-used across all per-frame collision queries
    // to avoid per-frame allocation.
    const raycaster = useMemo(() => new THREE.Raycaster(), []);

    // Aim reticle rendered via a raw THREE.Line. Mounted once, position
    // buffer mutated per frame — avoids JSX churn from drei's <Line>.
    const reticle = useMemo(() => {
      const geom = new THREE.BufferGeometry();
      const positions = new Float32Array(6);
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0xff4466,
        transparent: true,
        opacity: 0.85,
        depthTest: false, // always visible through walls
      });
      mat.depthWrite = false;
      const line = new THREE.Line(geom, mat);
      line.renderOrder = 9999;
      line.frustumCulled = false;
      // Mark as non-collidable so our own raycasts skip the line.
      line.userData.noCollide = true;
      return { geom, positions, line };
    }, []);

    useEffect(() => {
      return () => {
        reticle.geom.dispose();
        (reticle.line.material as THREE.Material).dispose();
      };
    }, [reticle]);

    useImperativeHandle(
      handleRef,
      () => ({
        group: groupRef.current,
        getPose(): PlayerPose {
          const g = groupRef.current;
          const p = g ? g.position : new THREE.Vector3(...initialPose.position);
          const a = aimRef.current;
          return {
            position: [p.x, p.y, p.z],
            yaw: yawRef.current,
            aimPoint: [a.x, a.y, a.z],
            cameraYaw: initialPose.cameraYaw,
            cameraPitch: initialPose.cameraPitch,
            cameraDistance: initialPose.cameraDistance,
          };
        },
      }),
      [initialPose],
    );

    // Snap to initialPose on mount / when it changes.
    useEffect(() => {
      const g = groupRef.current;
      if (!g) return;
      g.position.set(
        initialPose.position[0],
        initialPose.position[1],
        initialPose.position[2],
      );
      g.rotation.y = initialPose.yaw;
      yawRef.current = initialPose.yaw;
      aimRef.current.set(
        initialPose.aimPoint[0],
        initialPose.aimPoint[1],
        initialPose.aimPoint[2],
      );
      // Tag the group so our own raycasts (ground, aim, walls) never
      // collide with the player's own capsule.
      g.userData.noCollide = true;
      vyRef.current = 0;
      onGroundRef.current = false;
    }, [initialPose]);

    useFrame((_state, deltaRaw) => {
      const g = groupRef.current;
      if (!g) return;
      const dt = Math.min(deltaRaw, 0.1);

      // Camera-relative flat XZ basis.
      _camForward.setFromMatrixColumn(camera.matrixWorld, 2).negate();
      _camForward.y = 0;
      if (_camForward.lengthSq() < 1e-6) _camForward.set(0, 0, -1);
      else _camForward.normalize();
      // Right = forward × +Y (RH): (−f.z, 0, f.x). The first cut had
      // the opposite sign, which swapped A and D.
      _camRight.set(-_camForward.z, 0, _camForward.x);

      // --- WASD intent -------------------------------------------------
      const keys = heldKeys.current;
      let fwd = 0;
      let right = 0;
      if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) right += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) right -= 1;

      let dx = 0;
      let dz = 0;
      if (fwd !== 0 || right !== 0) {
        const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
        const crouching = playModeState.crouching;
        // Speed priority (highest → lowest):
        //   1. Crouch — overrides sprint entirely; you can't sprint
        //      from a crouch, matching Aegis weapon rules.
        //   2. Firing (Hip+Fire) on top of stance — stacks
        //      multiplicatively so crouch+fire is even slower than
        //      crouch alone. Reads as "aiming carefully while
        //      crouched".
        //   3. Sprint, only when standing and not firing.
        //   4. Base walk.
        let speed: number;
        if (crouching) {
          speed = moveSpeed * crouchMoveMultiplier;
          if (playModeState.firing) speed *= firingMoveMultiplier;
        } else if (playModeState.firing) {
          speed = moveSpeed * firingMoveMultiplier;
        } else if (sprint) {
          speed = moveSpeed * sprintMultiplier;
        } else {
          speed = moveSpeed;
        }
        const inv = 1 / Math.hypot(fwd, right);
        fwd *= inv;
        right *= inv;
        dx = (_camForward.x * fwd + _camRight.x * right) * speed * dt;
        dz = (_camForward.z * fwd + _camRight.z * right) * speed * dt;
      }

      // --- Jump --------------------------------------------------------
      // Holding Space on the ground re-jumps each landing (bunny-hop
      // friendly, standard shooter feel). Suppressed while crouched:
      // in most shooters pressing jump from crouch either does nothing
      // (what we do here) or stands-and-jumps in a single frame; the
      // latter can't happen without an uncrouch animation, so we pick
      // the safer no-op.
      if (
        !playModeState.crouching &&
        onGroundRef.current &&
        keys.has('Space')
      ) {
        vyRef.current = jumpSpeed;
        onGroundRef.current = false;
      }

      // --- Gravity -----------------------------------------------------
      vyRef.current -= gravity * dt;

      // --- Horizontal collision (axis-separated slide) -----------------
      // Origin at waist height so low walls register but kick-plates
      // / thresholds do not.
      _origin.set(g.position.x, g.position.y + 0.9, g.position.z);
      dx = stepAlongAxis(scene, raycaster, _origin, _axisX, dx, playerRadius);
      // Use updated X for the Z test so we don't clip the corner on
      // a diagonal move.
      _origin.x = g.position.x + dx;
      dz = stepAlongAxis(scene, raycaster, _origin, _axisZ, dz, playerRadius);

      g.position.x += dx;
      g.position.z += dz;

      // --- Vertical: ground detect + landing ---------------------------
      const groundY = groundYBelow(scene, raycaster, g.position);
      const targetY = g.position.y + vyRef.current * dt;
      if (groundY !== null && targetY <= groundY + GROUND_EPSILON) {
        // Snap to ground, zero vertical speed. GROUND_EPSILON stops
        // micro-bouncing from numerical jitter on flat surfaces.
        g.position.y = groundY;
        vyRef.current = 0;
        onGroundRef.current = true;
      } else {
        g.position.y = targetY;
        // Only "airborne" if we're clearly above the last known
        // ground — prevents onGround flickering on stair edges.
        onGroundRef.current = groundY !== null && Math.abs(g.position.y - groundY) < GROUND_EPSILON;
      }

      // --- Animation-layer airborne classification --------------------
      // The physics `onGroundRef` above flicks to `false` as soon as the
      // player is ≥ GROUND_EPSILON (2 cm) off the ground — that's the
      // right threshold for gravity snapping, but it's way too
      // sensitive for animation: stepping off a curb lip or crossing
      // a mesh seam would punt the character straight into jumpLoop
      // for a single frame (reported as "1cm 떨어져도 낙하 포즈"). We
      // use a separate, looser classification for the anim state:
      // consider the character airborne only if
      //   * the ground is FAR below (> AIRBORNE_HEIGHT_THRESHOLD), OR
      //   * vertical velocity is clearly non-grounded (jumping up, or
      //     falling fast enough that a "hop" is implausible).
      // Also force-airborne when the user actively pressed Space this
      // frame so the jumpStart fires even before we gain altitude.
      const heightAboveGround = groundY !== null ? g.position.y - groundY : Infinity;
      const visuallyAirborne =
        heightAboveGround > AIRBORNE_HEIGHT_THRESHOLD ||
        vyRef.current > AIRBORNE_VY_UP ||
        vyRef.current < AIRBORNE_VY_DOWN;

      // --- Body yaw follows camera yaw ---------------------------------
      const yaw = Math.atan2(_camForward.x, _camForward.z);
      yawRef.current = yaw;
      g.rotation.y = yaw;

      // --- Aim: center screen ray vs actual geometry -------------------
      // The crosshair is always the middle of the viewport (pointer
      // is locked). We raycast through NDC (0,0), pick the first
      // non-noCollide hit; if the ray leaves the level we fall back
      // to a far point along the ray so the reticle still draws.
      _ndcCenter.set(0, 0);
      raycaster.setFromCamera(_ndcCenter, camera);
      raycaster.near = 0;
      raycaster.far = AIM_MAX_DISTANCE;
      _hits.length = 0;
      raycaster.intersectObject(scene, true, _hits);
      const aimHit = firstHitNotNoCollide(_hits);
      if (aimHit) {
        aimRef.current.copy(aimHit.point);
        playModeState.aimPoint.copy(aimHit.point);
        playModeState.aimValid = true;
      } else {
        aimRef.current
          .copy(raycaster.ray.origin)
          .addScaledVector(raycaster.ray.direction, AIM_MAX_DISTANCE);
        playModeState.aimPoint.copy(aimRef.current);
        // Fallback to the sky — still publish the point so the HUD
        // crosshair draws somewhere, but flag it invalid so the
        // feedback composer refuses to drop a pin there.
        playModeState.aimValid = false;
      }
      _hits.length = 0;

      // --- Animation state machine -----------------------------------
      // Priority:
      //   airborne  → jumpStart (first ~0.25 s) → jumpLoop
      //   grounded + moving → directional run (runF / runB / runL / runR)
      //   grounded + idle   → idle
      //   grounded + just-landed → jumpEnd (for JUMP_END_DURATION)
      //
      // Direction for run is resolved in CAMERA-LOCAL terms: W always
      // plays runF regardless of world yaw, because the character
      // turns with the camera. We pick the dominant axis of the
      // (fwd, right) intent vector so a pure-diagonal move falls to
      // one of the cardinal clips rather than snapping between two
      // every frame.
      const grounded = !visuallyAirborne;
      const phase = jumpPhaseRef.current;
      const now = _state.clock.elapsedTime;
      let next: AnimState = 'idle';
      if (!grounded) {
        if (phase.phase !== 'start' && phase.phase !== 'loop') {
          phase.phase = 'start';
          phase.since = now;
        } else if (phase.phase === 'start' && now - phase.since > JUMP_START_DURATION) {
          phase.phase = 'loop';
          phase.since = now;
        }
        next = phase.phase === 'start' ? 'jumpStart' : 'jumpLoop';
      } else {
        if (phase.phase === 'start' || phase.phase === 'loop') {
          phase.phase = 'end';
          phase.since = now;
        } else if (phase.phase === 'end' && now - phase.since > JUMP_END_DURATION) {
          phase.phase = 'grounded';
          phase.since = now;
        }
        if (phase.phase === 'end') {
          next = 'jumpEnd';
        } else if (fwd !== 0 || right !== 0) {
          next =
            Math.abs(fwd) >= Math.abs(right)
              ? fwd > 0
                ? 'runF'
                : 'runB'
              : right > 0
                ? 'runR'
                : 'runL';
        } else {
          next = 'idle';
        }
      }
      animStateRef.current = next;

      // --- Reticle line: chest-high at player, tip at aim point -------
      const arr = reticle.positions;
      arr[0] = g.position.x;
      arr[1] = g.position.y + 1.0;
      arr[2] = g.position.z;
      arr[3] = aimRef.current.x;
      arr[4] = aimRef.current.y;
      arr[5] = aimRef.current.z;
      const attr = reticle.geom.getAttribute('position') as THREE.BufferAttribute;
      attr.needsUpdate = true;
    });

    return (
      <>
        <group ref={groupRef} userData={{ noCollide: true }}>
          <CharacterAvatar stateRef={animStateRef} />
        </group>
        <primitive object={reticle.line} />
      </>
    );
  },
);

// --- Collision helpers ------------------------------------------------

/**
 * Try to move the player `delta` world units along `axis` starting
 * from `origin` (waist-height sample point). Returns the distance
 * actually travelled, shortened by `skin` if a wall is in the way so
 * the player stops just short of embedding. Caller applies that
 * signed distance to `group.position[axis]`.
 *
 * Works in either ±axis — the raycast direction is derived from
 * `Math.sign(delta)`. A zero (or near-zero) delta short-circuits to
 * skip the raycast entirely.
 */
function stepAlongAxis(
  scene: THREE.Object3D,
  raycaster: THREE.Raycaster,
  origin: THREE.Vector3,
  axisUnit: THREE.Vector3,
  delta: number,
  skin: number,
): number {
  if (Math.abs(delta) < 1e-5) return delta;
  const sign = Math.sign(delta);
  const mag = Math.abs(delta);

  _dir.copy(axisUnit).multiplyScalar(sign);
  raycaster.set(origin, _dir);
  raycaster.near = 0;
  raycaster.far = mag + skin;
  _hits.length = 0;
  raycaster.intersectObject(scene, true, _hits);
  const wall = firstHitNotNoCollide(_hits);
  _hits.length = 0;
  if (!wall) return delta;
  // Stop `skin` units short of the wall. Clamped ≥0 so we don't
  // teleport backwards if we were already intersecting (e.g. when
  // pushed into geometry by a moving platform we don't have yet).
  const travel = Math.max(0, wall.distance - skin);
  return travel * sign;
}

/**
 * Cast straight down from a point slightly above the player's feet
 * and return the Y of the first collidable surface, or `null` if the
 * void starts here. Origin is lifted so we don't start inside a
 * thin floor plane and miss.
 */
function groundYBelow(
  scene: THREE.Object3D,
  raycaster: THREE.Raycaster,
  feet: THREE.Vector3,
): number | null {
  _origin.set(feet.x, feet.y + GROUND_PROBE_LIFT, feet.z);
  raycaster.set(_origin, _down);
  raycaster.near = 0;
  raycaster.far = GROUND_PROBE_DISTANCE;
  _hits.length = 0;
  raycaster.intersectObject(scene, true, _hits);
  const hit = firstHitNotNoCollide(_hits);
  _hits.length = 0;
  return hit ? hit.point.y : null;
}

/** Walk up the parent chain of a raycast hit and return the first
 *  non-null that has `userData.noCollide`. The whole idea of
 *  "draw = collide" only works if we can opt specific sub-trees out,
 *  so we honour inheritance: a `<group userData={{noCollide:true}}>`
 *  wrapper is enough to exempt everything inside it. */
function hasNoCollideAncestor(obj: THREE.Object3D | null): boolean {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (o.userData && o.userData.noCollide) return true;
    o = o.parent;
  }
  return false;
}

function firstHitNotNoCollide(hits: THREE.Intersection[]): THREE.Intersection | null {
  for (let i = 0; i < hits.length; i++) {
    if (!hasNoCollideAncestor(hits[i].object)) return hits[i];
  }
  return null;
}

// --- Keyboard ---------------------------------------------------------

/** Physical-key aware keyboard state. `.code` so WASD is the physical
 *  cluster regardless of AZERTY / Dvorak / Colemak. Cleared on
 *  window blur so Alt-Tab doesn't leave keys "stuck". */
function useHeldKeys() {
  const ref = useRef<Set<string>>(new Set());
  useEffect(() => {
    const keys = ref.current;
    const down = (e: KeyboardEvent) => {
      keys.add(e.code);
      // Space is the browser's default page-scroll binding; we eat
      // it here so the viewer page doesn't jump when the player
      // jumps.
      if (e.code === 'Space') e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      keys.delete(e.code);
    };
    const blur = () => {
      keys.clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  return ref;
}

// --- Constants & scratch state ----------------------------------------

const GROUND_PROBE_LIFT = 2.0;    // start the ground ray 2 m above feet
const GROUND_PROBE_DISTANCE = 200; // give up after 200 m of void
const GROUND_EPSILON = 0.02;      // landing tolerance, prevents jitter
const AIM_MAX_DISTANCE = 500;     // beyond this, aim ray "misses"
// Animation-state timing. `jump_start` clips in the Aegis project run
// ~0.25 s before the loopable hang pose; we hold the start clip for
// that long (real clip length, *not* blended), then swap to jumpLoop.
// `jump_end` is the landing absorb — ~0.3 s feels natural on the
// shoulder-cam POV before returning control to idle/run.
const JUMP_START_DURATION = 0.25;
const JUMP_END_DURATION = 0.30;
// --- Animation-only airborne thresholds.
//
// `GROUND_EPSILON` (physics) is 2 cm — any higher and the player
// visibly floats above the ground mesh. That's too tight for anim:
// level meshes are noisy and the player constantly blips above by a
// few mm. We broaden the "airborne" classification used by the anim
// state machine with a generous Y height threshold PLUS a velocity
// check so a real jump still registers on frame 1 (before the body
// has actually left the ground).
const AIRBORNE_HEIGHT_THRESHOLD = 0.3; // ≥ 30 cm above ground to pose as jumping
const AIRBORNE_VY_UP = 1.0;            // rising faster than ~1 m/s = mid-jump
const AIRBORNE_VY_DOWN = -4.0;         // falling faster than ~4 m/s = real fall

// Hot-path scratch — kept module-scope so useFrame doesn't allocate
// on every frame. Safe because React renders PlayerController at most
// once per Canvas (single-player).
const _camForward = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);
const _ndcCenter = new THREE.Vector2();
const _hits: THREE.Intersection[] = [];
