import { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';

import type { PlayerControllerHandle } from './PlayerController';
// Interface-only import — kept as `import type` so the compiled JS
// has no actual link back to Shooter (which imports nothing from
// ShoulderCamera anyway, so there's no true circular dep).
import type { CameraRecoilAPI } from './Shooter';

/**
 * Aegis-style third-person over-the-shoulder camera.
 *
 * A faithful port of Unity Cinemachine 3.x's
 * `CinemachineThirdPersonFollow` geometry, parametrised by the same
 * four quantities Aegis' `CameraSettings` ScriptableObjects use:
 * `cameraOffset`, `shoulderOffset`, `verticalArmLength`,
 * `cameraDistance`, plus `cameraFOV` for the lens and
 * `rotationSensibility` for mouse speed.
 *
 * Why re-derive instead of consuming Unity's cam-state directly?
 * Cinemachine is an editor-time rig tree; there's no runtime data
 * to serialise. But the final transform is purely a function of
 * those four offsets + a (yaw, pitch) orientation, so we just
 * recompute every frame from the same primitives.
 *
 * Geometry (all in world space, Y-up, right-handed):
 *
 *     anchor   = player + yawOnly(cameraOffset)
 *     shoulder = anchor + yawOnly(shoulderOffset)
 *     pivot    = shoulder + worldUp * verticalArmLength
 *     camera   = pivot  − cameraForward * cameraDistance
 *
 * where `cameraForward` is the full (yaw+pitch) orientation. That
 * final step is the whole reason the camera "orbits" when you look
 * up/down: changing pitch rotates the back-off vector around the
 * pivot, which is fixed above the shoulder.
 *
 * Yaw-only on the shoulder offset is important: if we applied full
 * orientation there, looking up would swing the shoulder sideways
 * AND up, giving a sickly "boom-crane" arc. Cinemachine's original
 * authors made the same choice — shoulder tracks yaw, camera
 * tracks yaw+pitch.
 *
 * Mouse conventions match the first cut (fixed by "마우스가 반대야"):
 *   - cursor right → camera turns right ⇒ yaw decreases (Three RH Y-up)
 *   - cursor down  → camera looks down  ⇒ pitch decreases
 *
 * Pitch clamp: Aegis' Stand_Default is ±60° which also matches a
 * typical FPS camera without rolling over. Exposed as a prop so
 * `Crouch_Ads` etc. can tighten it later.
 */

/** One row of the Cinemachine `CinemachineThirdPersonFollow` preset
 *  table. Units match Unity (metres, degrees). The four geometric
 *  quantities come straight from `CameraSettings_*.asset`; sens is
 *  a multiplier on our pixel-to-radians sensitivity base. */
export interface CameraPreset {
  /** How long a cross-fade to this preset should take when we
   *  eventually blend between presets (aim in/out). Unused in M1
   *  but kept here so presets match the .asset 1:1. */
  duration: number;
  /** Horizontal FOV in degrees. We interpret the Aegis `cameraFOV`
   *  as HFOV per user request ("HFOV 80으로 해줘"). The camera
   *  component converts to the vertical FOV Three.js needs based on
   *  the live viewport aspect ratio, so the horizontal framing stays
   *  constant across window resizes / monitor swaps. */
  cameraFOV: number;
  /** `cameraOffset.y`: raise the anchor this many metres above the
   *  player's root. Aegis leaves x/z at 0 in every preset, so we
   *  model just the Y component. Stand_Default = 1.0 ≈ chest height. */
  cameraOffsetY: number;
  /** `shoulderOffset.x`: lateral offset of the pivot in the player's
   *  yaw frame. Positive = right shoulder (player visible on the
   *  LEFT half of the screen, right half is aim space). */
  shoulderOffsetX: number;
  /** `verticalArmLength`: vertical distance from the shoulder to
   *  the pivot around which the camera orbits when pitching. */
  verticalArmLength: number;
  /** `cameraDistance`: metres the camera sits behind the pivot
   *  along the view forward. 0 = first-person (used by Stand_Ads). */
  cameraDistance: number;
  /** `rotationSensibility`: mouse-speed multiplier vs. the preset-
   *  neutral baseline. Aim presets go to 0.4–0.556 so fine
   *  targeting doesn't jitter. */
  sensitivity: number;
  /** Unused in M1 (no weapon kick) but recorded for completeness. */
  recoilMultiplier: number;
  /** Pitch clamp (degrees). Identical across presets (±60°) at the
   *  time of writing, but exposed so future Crouch/prone presets
   *  can tighten it without touching the component. */
  pitchMinDeg: number;
  pitchMaxDeg: number;
}

/**
 * The 11 Stand/Crouch base presets from Aegis' runtime, transcribed
 * from `Assets/GameContents/PlayConfigData/Camera/CameraSettings_*.asset`.
 * Skill/Death overrides aren't included — those get layered in at
 * runtime when (if) we wire a real state machine.
 *
 * Keep the same keys as the Unity asset names so cross-referencing
 * is trivial.
 */
export const CAMERA_PRESETS = {
  Stand_Default:       preset(0.175, 80,   1.00, 0.45, 0.50, 2.30, 1.000, 1.0),
  Stand_HipFire:       preset(0.20,  80,   1.00, 0.45, 0.50, 1.45, 1.000, 1.0),
  Stand_Aim:           preset(0.13,  44.5, 1.06, 0.38, 0.365,1.20, 0.556, 0.6),
  Stand_Ads:           preset(0.18,  32,   1.09, 0.155,0.30, 0.00, 0.400, 0.6),
  Stand_Aim_Throw:     preset(0.13,  44.5, 1.075,0.38, 0.365,1.20, 0.556, 0.6),
  Stand_Ads_Throw:     preset(0.18,  32,   1.09, 0.155,0.30, 0.00, 0.400, 0.6),
  Stand_HipFire_Throw: preset(0.20,  80,   1.00, 0.45, 0.50, 1.45, 1.000, 1.0),
  Crouch_Default:      preset(0.25,  80,   0.70, 0.48, 0.50, 2.30, 1.000, 1.0),
  Crouch_HipFire:      preset(0.20,  80,   0.70, 0.48, 0.50, 1.45, 1.000, 1.0),
  Crouch_Aim:          preset(0.13,  44.5, 0.75, 0.38, 0.36, 1.20, 0.556, 0.6),
  Crouch_Ads:          preset(0.18,  32,   0.80, 0.15, 0.17, 0.10, 0.400, 0.6),
} as const;

export type CameraPresetKey = keyof typeof CAMERA_PRESETS;

export interface ShoulderCameraProps {
  playerHandle: React.RefObject<PlayerControllerHandle>;
  /** Which preset to apply. Stand_Default is the Aegis idle baseline.
   *  Passed straight from the controller; swap at runtime to get
   *  aim/ads zoom behaviour for free. */
  preset?: CameraPresetKey;
  /** True when the player is crouched. We auto-swap the provided
   *  `Stand_*` preset for its matching `Crouch_*` entry — same
   *  authoring surface as Aegis (CameraSettings presets come in
   *  stance-paired rows), and the caller doesn't have to know
   *  about the mapping. Passing `preset="Crouch_*"` directly is
   *  also valid; we detect that and leave it untouched. */
  crouching?: boolean;
  /** Override the preset's camera distance on mount (scene-scale
   *  fit). Undefined = use the preset value. Zoom wheel always
   *  works relative to this value within [minD, maxD]. */
  initialDistance?: number;
  /** Radians. Default 10° down so the floor ahead is visible in a
   *  TPS shooter pose without squashing vertical structure. */
  initialPitch?: number;
  initialYaw?: number;
  /** Scene-scale clamps for mouse wheel. Derived from preset if
   *  omitted. */
  minDistance?: number;
  maxDistance?: number;
  /** Radians per pixel at `sensitivity = 1`. Default calibrates a
   *  ~1500 px horizontal sweep to a 180° turn, matching the tactile
   *  feel of Aegis at `rotationSensibility = 1`. */
  mouseSensitivityBase?: number;
  /** Populated by the camera with a handle that lets external
   *  components (the shooter) inject pitch/yaw impulses. We use
   *  external-ref-population instead of `forwardRef` because the
   *  camera only ever exposes ONE thing (the recoil API) and mixing
   *  a real ref target (an element) would complicate the call site. */
  recoilHandleRef?: React.MutableRefObject<CameraRecoilAPI | null>;

  // --- Obstacle avoidance (Cinemachine parity) -------------------
  /** Enable pull-in-when-obstructed behaviour. When a wall gets
   *  between the pivot and the desired camera position, the camera
   *  slides forward along the view ray until it's clear. Exposed so
   *  non-play cameras (e.g. preview) can opt out. */
  avoidObstacles?: boolean;
  /** Sphere-cast radius used during the obstacle probe. The camera
   *  pulls in by this extra skin beyond the hit so the near-plane
   *  doesn't visibly clip the wall. 0.2 m matches Cinemachine's
   *  default "Camera Radius". */
  cameraCollisionRadius?: number;
  /** Time constant (seconds) for pulling IN when a new obstruction
   *  is detected. Smaller = more responsive (camera snaps in fast
   *  so the user never sees through a wall). Cinemachine's default
   *  `DampingIntoCollision` ≈ 0; we use a small non-zero value so
   *  one-frame blips (e.g. a stray prop edge) don't cause a jitter
   *  sprite. */
  dampIntoCollision?: number;
  /** Time constant (seconds) for RECOVERING back to the ideal
   *  distance when the obstruction clears. Bigger = slower recover,
   *  which hides transient pop-outs when the player rounds a
   *  corner. Cinemachine's default `DampingFromCollision` ≈ 2;
   *  0.5 s feels snappy enough for shooter pace without popping. */
  dampFromCollision?: number;
}

export function ShoulderCamera({
  playerHandle,
  preset = 'Stand_Default',
  crouching = false,
  initialDistance,
  initialPitch = (10 * Math.PI) / 180,
  initialYaw = 0,
  minDistance,
  maxDistance,
  mouseSensitivityBase = Math.PI / 1500,
  recoilHandleRef,
  avoidObstacles = true,
  cameraCollisionRadius = 0.2,
  dampIntoCollision = 0.04,
  dampFromCollision = 0.5,
}: ShoulderCameraProps) {
  const { camera, gl, scene, size } = useThree();
  // Stance-pair the incoming preset. `Stand_Default` ↔ `Crouch_Default`
  // are authored to complement each other in the Aegis asset files
  // (same sensitivity, same shoulder offset, different camera height
  // + FOV). If a Stand_* preset is passed and crouching is live, we
  // swap to the matching Crouch_* row. A Crouch_* passed explicitly
  // is respected verbatim (allows future "forced-crouch" scripted
  // cameras).
  const effectivePreset: CameraPresetKey =
    crouching && preset.startsWith('Stand_')
      ? (preset.replace(/^Stand_/, 'Crouch_') as CameraPresetKey) in CAMERA_PRESETS
        ? (preset.replace(/^Stand_/, 'Crouch_') as CameraPresetKey)
        : preset
      : preset;
  const cfg = CAMERA_PRESETS[effectivePreset];

  // Smoothed effective camera distance — separate from `distanceRef`
  // (which is the USER'S desired zoom). When an obstacle is in the
  // way this gets pulled toward a smaller value; when the way
  // clears it drifts back up to the zoom setting. Null until first
  // frame so we can seed it with the initial distance at t=0
  // instead of starting from 0 and popping out on mount.
  const smoothedDistanceRef = useRef<number | null>(null);

  // Shared raycaster for obstacle probes. Per-frame reuse, zero
  // per-frame allocation. Note we don't set `camera` — the probe
  // runs against geometry only (not sprites) because all sprites /
  // effect lines in the play scene are `noopRaycast` now.
  const collisionRaycaster = useMemo(() => new THREE.Raycaster(), []);

  // Live yaw/pitch/distance as refs so pointer/wheel callbacks can
  // mutate without going through React. Distance is kept independent
  // from the preset so the wheel zoom doesn't reset on every render.
  const yawRef = useRef(initialYaw);
  const pitchRef = useRef(initialPitch);
  const distanceRef = useRef(initialDistance ?? cfg.cameraDistance);

  // Scene-scale zoom clamps. Aegis' Stand_Default distance is 2.3;
  // we allow the user to pull out to ~2.5x for inspection vibes
  // and crunch in to ~65% for tight corridor framing.
  const minD = minDistance ?? Math.max(0.6, cfg.cameraDistance * 0.4);
  const maxD = maxDistance ?? Math.max(cfg.cameraDistance * 2.5, 6);

  // Resolve the live sensitivity lazily — wrap in a ref so a preset
  // swap reads the new multiplier next frame without re-running
  // the pointermove effect.
  const sensRef = useRef(mouseSensitivityBase * cfg.sensitivity);
  useEffect(() => {
    sensRef.current = mouseSensitivityBase * cfg.sensitivity;
  }, [mouseSensitivityBase, cfg.sensitivity]);

  // Reseed when meaningful props change.
  useEffect(() => {
    yawRef.current = initialYaw;
    pitchRef.current = initialPitch;
    distanceRef.current = THREE.MathUtils.clamp(
      initialDistance ?? cfg.cameraDistance,
      minD,
      maxD,
    );
  }, [initialYaw, initialPitch, initialDistance, cfg.cameraDistance, minD, maxD]);

  // Apply preset-driven camera intrinsics.
  //
  // Three.js stores `fov` as VERTICAL fov (degrees), but the Aegis
  // presets are authored as HORIZONTAL fov so the horizontal
  // framing stays constant on wide monitors. Convert via the
  // current aspect ratio and re-run on resize (react-three's
  // `size` entry updates on viewport change).
  //
  //   hfov_rad = 2 * atan( tan(vfov_rad/2) * aspect )
  // ⇒ vfov_rad = 2 * atan( tan(hfov_rad/2) / aspect )
  //
  // At 16:9 (aspect 1.778), HFOV 80° → VFOV ≈ 50.4°. At 4:3 it's
  // ≈ 64°. At ultrawide 21:9 it's ≈ 39°. Each variant produces the
  // same left-to-right framing.
  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const aspect = Math.max(0.01, size.width / Math.max(1, size.height));
    const hfovRad = (cfg.cameraFOV * Math.PI) / 180;
    const vfovRad = 2 * Math.atan(Math.tan(hfovRad / 2) / aspect);
    camera.fov = (vfovRad * 180) / Math.PI;
    camera.updateProjectionMatrix();
  }, [camera, cfg.cameraFOV, size.width, size.height]);

  // Pitch clamp derived from preset.
  const { pitchMin, pitchMax } = useMemo(
    () => ({
      pitchMin: (cfg.pitchMinDeg * Math.PI) / 180,
      pitchMax: (cfg.pitchMaxDeg * Math.PI) / 180,
    }),
    [cfg.pitchMinDeg, cfg.pitchMaxDeg],
  );

  // Expose a recoil handle for external systems (Shooter) to inject
  // camera kick. We split the kick into two parts:
  //
  //   persistent (pitch/yaw): added directly to pitchRef/yawRef, so
  //     the muzzle genuinely climbs and the user must pull the mouse
  //     down to hold on target. This is the CS/Valorant recoil
  //     model — feedback via ground truth, not a gimmick overlay.
  //   shake  (pitchShake/yawShake): a decaying offset added to the
  //     camera orientation JUST FOR DISPLAY. Not clamped, not saved,
  //     so it produces the "snap-back" punchy feel without breaking
  //     aim continuity. Time constant ~45 ms — fast enough to settle
  //     between rounds at 10 rps.
  const shakePitchRef = useRef(0);
  const shakeYawRef = useRef(0);

  // Populate the imperative handle via the same path on every render
  // so the shooter never sees a null when pointer lock is already
  // engaged. useImperativeHandle with a local ref would also work
  // but requires the parent to forwardRef; a plain mutable-ref prop
  // is simpler and keeps the export surface narrow.
  const api = useMemo<CameraRecoilAPI>(
    () => ({
      applyKick: (pitchRad: number, yawRad: number) => {
        // Persistent part: muzzle climbs, user must counter-aim.
        // We intentionally do NOT clamp here; pitchRef is clamped
        // next frame by the normal mouse-move path. That means the
        // FIRST over-clamp shot still reads as "hit the ceiling"
        // rather than silently disappearing.
        pitchRef.current = THREE.MathUtils.clamp(
          pitchRef.current + pitchRad,
          pitchMin,
          pitchMax,
        );
        yawRef.current += yawRad * 0.35; // subtler lateral drift
        // Shake part: 2× the persistent kick, decays back to 0.
        shakePitchRef.current += pitchRad * 2.0;
        shakeYawRef.current += yawRad * 2.0;
      },
    }),
    [pitchMin, pitchMax],
  );
  useImperativeHandle(recoilHandleRef, () => api, [api, recoilHandleRef]);
  // useImperativeHandle doesn't populate a plain MutableRefObject if
  // the user passed one through `recoilHandleRef` directly; write
  // the value ourselves so either ref style works.
  useEffect(() => {
    if (recoilHandleRef) recoilHandleRef.current = api;
    return () => {
      if (recoilHandleRef) recoilHandleRef.current = null;
    };
  }, [api, recoilHandleRef]);

  // Mouse → yaw/pitch while pointer lock is active.
  useEffect(() => {
    const dom = gl.domElement;
    const onPointerMove = (e: PointerEvent) => {
      if (document.pointerLockElement !== dom) return;
      const s = sensRef.current;
      // Horizontal: cursor-right must turn the camera RIGHT. In
      // Three's RH Y-up frame that's a DECREASE in yaw.
      yawRef.current -= e.movementX * s;
      // Vertical: cursor-down must LOOK DOWN (non-inverted / FPS).
      // Positive pitch in our YXZ Euler looks up, so we subtract.
      pitchRef.current = THREE.MathUtils.clamp(
        pitchRef.current - e.movementY * s,
        pitchMin,
        pitchMax,
      );
    };
    dom.addEventListener('pointermove', onPointerMove);
    return () => dom.removeEventListener('pointermove', onPointerMove);
  }, [gl, pitchMin, pitchMax]);

  // Mouse wheel → zoom.
  useEffect(() => {
    const dom = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.0008);
      distanceRef.current = THREE.MathUtils.clamp(
        distanceRef.current * factor,
        minD,
        maxD,
      );
    };
    dom.addEventListener('wheel', onWheel, { passive: false });
    return () => dom.removeEventListener('wheel', onWheel);
  }, [gl, minD, maxD]);

  // --- Per-frame transform ------------------------------------------
  useFrame((_state, dtRaw) => {
    const handle = playerHandle.current;
    const g = handle?.group;
    if (!g) return;

    // Decay the visual shake. Time constant matches the character
    // recoil time constant (~0.12 s) so the camera shake and the
    // arm recoil kick together and settle together — otherwise one
    // component's motion lags the other and the feel is mushy.
    const dt = Math.min(dtRaw, 0.1);
    const decay = Math.exp(-dt / 0.045);
    shakePitchRef.current *= decay;
    shakeYawRef.current *= decay;
    // Under threshold, snap to 0 so we don't burn cycles on float
    // sub-normals forever.
    if (Math.abs(shakePitchRef.current) < 1e-5) shakePitchRef.current = 0;
    if (Math.abs(shakeYawRef.current) < 1e-5) shakeYawRef.current = 0;

    // Rig geometry uses the PURE yaw/pitch (no shake). The shake is
    // applied only to the camera's final orientation below so the
    // anchor / shoulder / pivot stay tied to the character's actual
    // facing — otherwise the rig would translate every shot and the
    // third-person pivot would visibly wobble, which reads as jelly.
    const yawPure = yawRef.current;
    const yaw = yawPure + shakeYawRef.current;
    const pitch = pitchRef.current + shakePitchRef.current;
    const d = distanceRef.current;

    // Full orientation (yaw + pitch + visual shake) drives the
    // camera quaternion and the back-off direction. Euler YXZ means
    // yaw applied first around Y, then pitch around the rotated
    // local X — which is what keeps the horizon level (no roll).
    _euler.set(pitch, yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(_euler);
    _forward.set(0, 0, -1).applyEuler(_euler);

    // Yaw-only: used for the shoulder plant so looking up/down
    // doesn't swing the shoulder position laterally. We use the
    // PURE yaw here (no shake) — see comment above.
    _eulerYaw.set(0, yawPure, 0, 'YXZ');

    // Step 1: anchor (Aegis `cameraOffset`, y-only in every preset).
    _anchor
      .copy(g.position)
      .addScaledVector(_worldUp, cfg.cameraOffsetY);

    // Step 2: shoulder (yaw-only rotated `shoulderOffset.x`).
    _tmp.set(cfg.shoulderOffsetX, 0, 0).applyEuler(_eulerYaw);
    _shoulder.copy(_anchor).add(_tmp);

    // Step 3: pivot = shoulder + worldUp × verticalArmLength. World
    // up (not yaw-rotated) so the pivot stays at a consistent
    // height when the player turns.
    _pivot
      .copy(_shoulder)
      .addScaledVector(_worldUp, cfg.verticalArmLength);

    // Step 4: camera sits `d` metres behind pivot along −forward.
    // `d` comes from the zoom ref, NOT the preset constant, so a
    // preset swap doesn't clobber the user's wheel choice. Then we
    // optionally pull it in to avoid walls.
    //
    // Obstacle avoidance — Cinemachine `AvoidObstacles` port.
    //
    // Cinemachine's version uses a sphere cast from the pivot to
    // the ideal camera position; any blocker shortens the distance
    // by (hitDistance − cameraRadius), and two separate damping
    // constants govern how fast we pull in vs. recover out.
    //
    // We approximate the sphere cast with a single ray along
    // −forward plus a fixed `cameraCollisionRadius` skin that's
    // subtracted from the hit distance. That's cheap and reads
    // almost identically as long as the obstructing geometry is
    // wall-like (flat facing the camera) — which it virtually
    // always is for third-person clipping.
    //
    // Damping is split asymmetrically:
    //   - Into-collision: small τ so we pull in fast and never let
    //     a frame of "through the wall" render.
    //   - From-collision: large τ so the recover doesn't pop out
    //     violently when the player rounds a corner.
    //
    // Exponential smoothing (τ-based) chosen over Unity's
    // SmoothDamp for simplicity — the feel is indistinguishable at
    // the time constants we use.
    let effectiveD = d;
    if (avoidObstacles) {
      const ideal = d;
      // Ray from pivot toward the IDEAL camera spot. We probe a hair
      // further than the ideal so the skin still pulls us in when
      // the wall sits exactly at the ideal point.
      _collisionDir.copy(_forward).multiplyScalar(-1);
      collisionRaycaster.set(_pivot, _collisionDir);
      collisionRaycaster.near = 0;
      collisionRaycaster.far = ideal + cameraCollisionRadius;
      _collisionHits.length = 0;
      collisionRaycaster.intersectObject(scene, true, _collisionHits);
      const hit = firstNonSelfHit(_collisionHits, g);
      _collisionHits.length = 0;

      // Safe distance: pulled inside the wall by the skin, floored
      // at the preset-permitted minimum so 1st-person mode
      // (cameraDistance=0 presets) still works.
      const safe = hit
        ? Math.max(0, hit.distance - cameraCollisionRadius)
        : ideal;

      // Seed the smoother on the very first frame so we don't pop
      // out from 0 to `safe` on mount.
      if (smoothedDistanceRef.current === null) {
        smoothedDistanceRef.current = safe;
      }

      // Asymmetric smoothing — pull-in τ vs. recover-out τ.
      const current = smoothedDistanceRef.current;
      const tau = safe < current ? dampIntoCollision : dampFromCollision;
      // tau = 0 ⇒ hard-snap this frame. Handle it without divide-by-0.
      const alpha = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
      smoothedDistanceRef.current = current + (safe - current) * alpha;
      effectiveD = smoothedDistanceRef.current;
    } else {
      smoothedDistanceRef.current = d;
      effectiveD = d;
    }

    camera.position.copy(_pivot).addScaledVector(_forward, -effectiveD);

    // Final: push the transform to children (PlayerController reads
    // camera world matrix for its WASD basis and for aim raycasts).
    camera.updateMatrixWorld();
  });

  return null;
}

/** Shorthand to keep `CAMERA_PRESETS` readable — fixed pitch clamp
 *  matches every row of the Aegis table (±60°). */
function preset(
  duration: number,
  cameraFOV: number,
  cameraOffsetY: number,
  shoulderOffsetX: number,
  verticalArmLength: number,
  cameraDistance: number,
  sensitivity: number,
  recoilMultiplier: number,
): CameraPreset {
  return {
    duration,
    cameraFOV,
    cameraOffsetY,
    shoulderOffsetX,
    verticalArmLength,
    cameraDistance,
    sensitivity,
    recoilMultiplier,
    pitchMinDeg: -60,
    pitchMaxDeg: 60,
  };
}

/** The obstacle probe raycasts the whole scene — that means it WILL
 *  hit the player's own capsule / avatar group, the aim reticle,
 *  etc. Filter those out the same way PlayerController does: walk
 *  up the parent chain looking for `userData.noCollide`, AND also
 *  explicitly reject hits on the player group subtree. The group
 *  check is the stronger guarantee since effect meshes are already
 *  overridden to `noopRaycast` in Shooter.tsx but custom feed /
 *  pin thumbnails that show up in M4 won't necessarily be. */
function firstNonSelfHit(
  hits: THREE.Intersection[],
  player: THREE.Object3D,
): THREE.Intersection | null {
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (isDescendantOf(h.object, player)) continue;
    if (hasNoCollideAncestor(h.object)) continue;
    return h;
  }
  return null;
}

function isDescendantOf(obj: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (o === ancestor) return true;
    o = o.parent;
  }
  return false;
}

function hasNoCollideAncestor(obj: THREE.Object3D | null): boolean {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (o.userData && o.userData.noCollide) return true;
    o = o.parent;
  }
  return false;
}

// Hot-path scratch — module-level because only one ShoulderCamera
// ever mounts (single local player).
const _euler = new THREE.Euler();
const _eulerYaw = new THREE.Euler();
const _forward = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _collisionDir = new THREE.Vector3();
const _collisionHits: THREE.Intersection[] = [];
