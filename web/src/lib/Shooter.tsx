import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';

import { playModeState } from './playModeState';

/**
 * Hitscan machine-gun firing layer for Play mode.
 *
 * Two-source ray design: the TRACER is drawn from the weapon muzzle
 * (when the skeletal avatar's hand bone is mounted) to the impact,
 * but the hit-TEST ray still runs down the screen centre from the
 * camera. This matches how real TPS shooters feel — the reticle is
 * always accurate, but the visible beam comes out of the character's
 * gun, not the player's eyeball.
 *
 * What this component drives every frame:
 *   * Spawns shots while LMB is held (capped at `fireRate` rps).
 *   * Writes `playModeState.firing / fireTime / fireTick` so other
 *     components can react (PlayerController slows movement;
 *     CharacterAvatar triggers procedural recoil on the arm bone;
 *     ShoulderCamera adds a pitch impulse → camera kick).
 *   * Renders per-shot tracers, impact sparks, and a muzzle flash
 *     anchored to the muzzle Object3D (additive sprites, pooled).
 *   * Kicks the camera pitch slightly upward per shot (muzzle climb).
 */
export interface ShooterProps {
  /** Off by default; wire from LevelViewer's `playMode`. */
  enabled: boolean;
  /** Canvas DOM element the pointer-lock is bound to. Needed because
   *  we want pointerdown only when the canvas is the active interaction
   *  target — not HUD buttons or the Play FAB. */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Rounds per second. 10 rps ≈ classic shooter LMG feel; Aegis's
   *  real full-auto rifle is closer to 11-12 rps in the .asset
   *  definitions. */
  fireRate?: number;
  /** Max distance a tracer / hit will register. */
  maxRange?: number;
  /** Ref to the yaw/pitch refs inside ShoulderCamera so we can inject
   *  camera kick on fire. Typed as unknown to avoid a circular
   *  import — ShoulderCamera passes the handle in via
   *  `ShoulderCameraRecoilRef`. Optional; falls back to no kick when
   *  omitted. */
  cameraRecoilRef?: React.RefObject<CameraRecoilAPI | null>;
}

/** Minimal surface ShoulderCamera exposes to the shooter so we can
 *  add a pitch impulse without the shooter needing to know yaw or
 *  the preset table. */
export interface CameraRecoilAPI {
  /** Add `pitchRad` to the camera pitch immediately (within its
   *  clamp). Positive = muzzle climb = camera tilts UP. Also add a
   *  horizontal `yawRad` for occasional lateral jolt. */
  applyKick(pitchRad: number, yawRad: number): void;
}

/** One active tracer / impact effect. */
interface Shot {
  age: number;                 // −1 = free slot
  start: THREE.Vector3;        // tracer origin (muzzle or eye)
  end: THREE.Vector3;          // tracer end (hit point or far fallback)
  hit: boolean;                // true if ray hit geometry (=draw impact)
}

const POOL_SIZE = 48;
const TRACER_LIFETIME = 0.06;
const IMPACT_LIFETIME = 0.22;
const FLASH_LIFETIME = 0.05;   // very short — machine-gun rapid-fire

export function Shooter({
  enabled,
  canvasRef,
  fireRate = 10,
  maxRange = 500,
  cameraRecoilRef,
}: ShooterProps) {
  const { camera, scene, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  // Re-read fire rate on prop change without recreating the whole
  // effect chain below.
  const fireIntervalRef = useRef(1 / fireRate);
  useEffect(() => {
    fireIntervalRef.current = 1 / fireRate;
  }, [fireRate]);

  // Firing state. `firing` tracks whether LMB is held.
  const firing = useRef(false);
  const cooldown = useRef(0);
  const flashAgeRef = useRef(-1); // −1 = muzzle flash hidden

  // --- Pool + GPU buffers ---
  const visuals = useMemo(() => makeVisuals(), []);
  const { tracerLine, impactPoints, flashSprite, shots } = visuals;

  useEffect(
    () => () => {
      tracerLine.geometry.dispose();
      (tracerLine.material as THREE.Material).dispose();
      impactPoints.geometry.dispose();
      (impactPoints.material as THREE.Material).dispose();
      (flashSprite.material as THREE.SpriteMaterial).map?.dispose();
      (flashSprite.material as THREE.Material).dispose();
    },
    [tracerLine, impactPoints, flashSprite],
  );

  // --- Pointer hookup ---
  useEffect(() => {
    if (!enabled) {
      firing.current = false;
      playModeState.firing = false;
      return;
    }
    const canvas = canvasRef.current ?? gl.domElement;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (document.pointerLockElement !== canvas) return;
      firing.current = true;
      cooldown.current = 0;
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      firing.current = false;
    };
    const onBlur = () => {
      firing.current = false;
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled, canvasRef, gl]);

  // --- Per-frame ---
  useFrame((_state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    const now = _state.clock.elapsedTime;

    // (0) Publish firing state. PlayerController reads this to switch
    // from Hip 4.5 m/s to Hip+Fire 2.7 m/s (Aegis AR "스위프트" row).
    const wantFiring =
      enabled &&
      firing.current &&
      document.pointerLockElement === (canvasRef.current ?? gl.domElement);
    playModeState.firing = wantFiring;

    // (1) Spawn new shots.
    if (wantFiring) {
      cooldown.current -= dt;
      let budget = 4;
      while (cooldown.current <= 0 && budget-- > 0) {
        fireOneShot(shots, camera, scene, raycaster, maxRange, now);
        flashAgeRef.current = 0;
        // Camera recoil: a bit of muzzle climb on every trigger
        // pull. Values tuned so 10 rps of sustained fire drifts the
        // aim upward by a noticeable amount over ~0.5 s without
        // feeling like a flashbang.
        const api = cameraRecoilRef?.current;
        if (api) {
          const pitchImpulse = 0.9 * DEG_PER_SHOT_PITCH * Math.PI / 180;
          const yawImpulse   = (Math.random() - 0.5) * DEG_PER_SHOT_YAW_JITTER * Math.PI / 180;
          api.applyKick(pitchImpulse, yawImpulse);
        }
        cooldown.current += fireIntervalRef.current;
      }
    }

    // (2) Age + pack buffers.
    const tracerPos = tracerLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    const tracerCol = tracerLine.geometry.getAttribute('color') as THREE.BufferAttribute;
    const impactPos = impactPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
    const impactCol = impactPoints.geometry.getAttribute('color') as THREE.BufferAttribute;
    const tracerArr = tracerPos.array as Float32Array;
    const tracerColArr = tracerCol.array as Float32Array;
    const impactArr = impactPos.array as Float32Array;
    const impactColArr = impactCol.array as Float32Array;

    for (let i = 0; i < POOL_SIZE; i++) {
      const s = shots[i];
      const ti = i * 6;
      const ii = i * 3;
      if (s.age < 0) {
        tracerArr[ti] = tracerArr[ti + 3] = 0;
        tracerArr[ti + 1] = tracerArr[ti + 4] = 0;
        tracerArr[ti + 2] = tracerArr[ti + 5] = 0;
        tracerColArr[ti] = tracerColArr[ti + 3] = 0;
        tracerColArr[ti + 1] = tracerColArr[ti + 4] = 0;
        tracerColArr[ti + 2] = tracerColArr[ti + 5] = 0;
        impactArr[ii] = impactArr[ii + 1] = impactArr[ii + 2] = 0;
        impactColArr[ii] = impactColArr[ii + 1] = impactColArr[ii + 2] = 0;
        continue;
      }
      s.age += dt;
      // Tracer: snappy fade, bright yellow-white at birth so the
      // beam actually reads as a bullet trace and not a laser line.
      const tLife = Math.max(0, 1 - s.age / TRACER_LIFETIME);
      tracerArr[ti]     = s.start.x;
      tracerArr[ti + 1] = s.start.y;
      tracerArr[ti + 2] = s.start.z;
      tracerArr[ti + 3] = s.end.x;
      tracerArr[ti + 4] = s.end.y;
      tracerArr[ti + 5] = s.end.z;
      // Bright tail near the muzzle, fading to yellow toward the
      // impact: per-vertex colour handles this for free.
      const headR = 1.0 * tLife, headG = 0.95 * tLife, headB = 0.55 * tLife;
      const tailR = 1.0 * tLife, tailG = 0.80 * tLife, tailB = 0.30 * tLife;
      tracerColArr[ti]     = headR; tracerColArr[ti + 1] = headG; tracerColArr[ti + 2] = headB;
      tracerColArr[ti + 3] = tailR; tracerColArr[ti + 4] = tailG; tracerColArr[ti + 5] = tailB;

      const iLife = s.hit ? Math.max(0, 1 - s.age / IMPACT_LIFETIME) : 0;
      if (iLife > 0) {
        impactArr[ii]     = s.end.x;
        impactArr[ii + 1] = s.end.y;
        impactArr[ii + 2] = s.end.z;
        // Warm orange → dim red as it fades (additive blending adds
        // the colour to whatever is behind, so this reads as a short
        // "spark" rather than a solid dot).
        impactColArr[ii]     = 1.0 * iLife;
        impactColArr[ii + 1] = 0.60 * iLife;
        impactColArr[ii + 2] = 0.15 * iLife;
      } else {
        impactArr[ii] = impactArr[ii + 1] = impactArr[ii + 2] = 0;
        impactColArr[ii] = impactColArr[ii + 1] = impactColArr[ii + 2] = 0;
      }

      const maxLife = s.hit ? IMPACT_LIFETIME : TRACER_LIFETIME;
      if (s.age >= maxLife) s.age = -1;
    }

    tracerPos.needsUpdate = true;
    tracerCol.needsUpdate = true;
    impactPos.needsUpdate = true;
    impactCol.needsUpdate = true;

    // (3) Muzzle flash — one sprite parented to the world, we move it
    // to the muzzle every frame so it tracks arm animation / recoil.
    // Hidden (scale=0) when no recent shot. Size-pulsed so it POPs on
    // spawn and shrinks away within FLASH_LIFETIME.
    const muzzle = playModeState.muzzle;
    const flashAge = flashAgeRef.current;
    if (muzzle && flashAge >= 0 && flashAge < FLASH_LIFETIME) {
      // World-space anchor: go through the bone graph so the flash
      // follows the hand even mid-recoil.
      muzzle.getWorldPosition(_tmp);
      flashSprite.position.copy(_tmp);
      const life = 1 - flashAge / FLASH_LIFETIME;
      const base = 0.45;
      const scale = base * (0.8 + 0.4 * life);
      flashSprite.scale.setScalar(scale);
      (flashSprite.material as THREE.SpriteMaterial).opacity = life;
      flashSprite.visible = true;
      flashAgeRef.current += dt;
    } else {
      flashSprite.visible = false;
      if (flashAge >= FLASH_LIFETIME) flashAgeRef.current = -1;
    }
  });

  if (!enabled) return null;
  return (
    <>
      <primitive object={tracerLine} />
      <primitive object={impactPoints} />
      <primitive object={flashSprite} />
    </>
  );
}

// --- Shot spawning ----------------------------------------------------

/**
 * One machine-gun round:
 *   - Raycast from CAMERA centre (reticle = truth) to find the hit
 *     point, so the aim feels 1:1 with where the crosshair is.
 *   - Use the muzzle WORLD position as the tracer ORIGIN if the
 *     skinned mesh published one; otherwise fall back to a
 *     down-offset from the camera eye.
 *   - Advance the shared `playModeState` so the avatar / camera can
 *     react.
 */
function fireOneShot(
  shots: Shot[],
  camera: THREE.Camera,
  scene: THREE.Object3D,
  raycaster: THREE.Raycaster,
  maxRange: number,
  now: number,
): void {
  // Camera-centre ray = the aim ray. Reticle → impact is exact.
  _ndcCenter.set(0, 0);
  raycaster.setFromCamera(_ndcCenter, camera);
  raycaster.near = 0;
  raycaster.far = maxRange;
  _hits.length = 0;
  raycaster.intersectObject(scene, true, _hits);

  let hitPoint: THREE.Vector3 | null = null;
  for (let i = 0; i < _hits.length; i++) {
    if (!hasNoCollideAncestor(_hits[i].object)) {
      hitPoint = _hits[i].point;
      break;
    }
  }
  _hits.length = 0;

  // Tracer origin: bone-anchored muzzle if we have one, else a hint
  // below the camera eye. Either way we snap the END to wherever the
  // camera-centre ray actually struck, so tracer and hit agree.
  const muzzle = playModeState.muzzle;
  if (muzzle) {
    muzzle.getWorldPosition(_muzzleWorld);
  } else {
    _muzzleWorld.copy(raycaster.ray.origin).add(_fallbackMuzzleOffset);
  }

  // Pick free (or oldest) slot.
  let slot = -1;
  let oldest = -1;
  let oldestAge = -Infinity;
  for (let i = 0; i < shots.length; i++) {
    if (shots[i].age < 0) {
      slot = i;
      break;
    }
    if (shots[i].age > oldestAge) {
      oldestAge = shots[i].age;
      oldest = i;
    }
  }
  if (slot < 0) slot = oldest;
  const s = shots[slot];
  s.age = 0;
  s.start.copy(_muzzleWorld);
  if (hitPoint) {
    s.end.copy(hitPoint);
    s.hit = true;
  } else {
    s.end.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, maxRange);
    s.hit = false;
  }

  // Advertise fire to other Play-mode components.
  playModeState.fireTime = now;
  playModeState.fireTick = (playModeState.fireTick + 1) | 0;
}

// --- Visual setup ----------------------------------------------------

/** Build the three primitives the shooter renders every frame.
 *  Factored out so the `useMemo` body stays readable. */
function makeVisuals() {
  const shots: Shot[] = Array.from({ length: POOL_SIZE }, () => ({
    age: -1,
    start: new THREE.Vector3(),
    end: new THREE.Vector3(),
    hit: false,
  }));

  // Tracer (line segments).
  const tracerGeom = new THREE.BufferGeometry();
  const tracerPos = new Float32Array(POOL_SIZE * 2 * 3);
  const tracerCol = new Float32Array(POOL_SIZE * 2 * 3);
  tracerGeom.setAttribute('position', new THREE.BufferAttribute(tracerPos, 3));
  tracerGeom.setAttribute('color', new THREE.BufferAttribute(tracerCol, 3));
  const tracerMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const tracerLine = new THREE.LineSegments(tracerGeom, tracerMat);
  tracerLine.frustumCulled = false;
  tracerLine.renderOrder = 9998;
  tracerLine.userData.noCollide = true;
  // Visual-only — never participate in scene raycasts. The
  // `userData.noCollide` tag filters our hit *results*, but Three's
  // `intersectObject(..., true)` still invokes every descendant's
  // `.raycast()` before filtering; a Sprite's raycast reads
  // `raycaster.camera.matrixWorld` and crashes when the caller
  // (PlayerController's ground probe, etc.) didn't set a camera.
  // Nuking the method is the universal cure for tracers / flash /
  // impact points alike, and saves a few ns per cast in the
  // bargain.
  tracerLine.raycast = noopRaycast;

  // Impact (points).
  const impactGeom = new THREE.BufferGeometry();
  const impactPos = new Float32Array(POOL_SIZE * 3);
  const impactCol = new Float32Array(POOL_SIZE * 3);
  impactGeom.setAttribute('position', new THREE.BufferAttribute(impactPos, 3));
  impactGeom.setAttribute('color', new THREE.BufferAttribute(impactCol, 3));
  const impactMat = new THREE.PointsMaterial({
    size: 0.32,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const impactPoints = new THREE.Points(impactGeom, impactMat);
  impactPoints.frustumCulled = false;
  impactPoints.renderOrder = 9998;
  impactPoints.userData.noCollide = true;
  impactPoints.raycast = noopRaycast;

  // Muzzle flash (sprite). Uses a procedurally-drawn canvas texture
  // so we don't need to ship an image asset — a bright radial gradient
  // that reads as a hot point-light when additively blended.
  const flashTex = makeFlashTexture();
  const flashMat = new THREE.SpriteMaterial({
    map: flashTex,
    color: 0xffdc8a,
    transparent: true,
    opacity: 0,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const flashSprite = new THREE.Sprite(flashMat);
  flashSprite.visible = false;
  flashSprite.renderOrder = 9999;
  flashSprite.userData.noCollide = true;
  // Critical: Sprite.raycast() dereferences `raycaster.camera` and
  // crashes when the raycast came from a system that didn't bother
  // setting one (our ground / wall probes). Disable entirely — the
  // muzzle flash has no business participating in physics.
  flashSprite.raycast = noopRaycast;
  flashSprite.scale.setScalar(0.0001);

  return { shots, tracerLine, impactPoints, flashSprite };
}

function makeFlashTexture(): THREE.Texture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const cx = size / 2;
  const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  grad.addColorStop(0.0, 'rgba(255,255,230,1.0)');
  grad.addColorStop(0.2, 'rgba(255,220,140,0.85)');
  grad.addColorStop(0.5, 'rgba(255,170,60,0.35)');
  grad.addColorStop(1.0, 'rgba(255,120,40,0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Replacement raycast for purely-visual objects. Must share the
 *  Object3D.raycast signature; we keep it assignable to typed
 *  `Object3D['raycast']` so the TS compiler doesn't complain. */
const noopRaycast: THREE.Object3D['raycast'] = () => {
  /* visual only — never a hit candidate */
};

function hasNoCollideAncestor(obj: THREE.Object3D | null): boolean {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (o.userData && o.userData.noCollide) return true;
    o = o.parent;
  }
  return false;
}

// --- Constants & scratch ---------------------------------------------

// Per-shot camera kick. Tuned so a burst of ~5 rounds visibly walks
// the aim off-target, requiring a compensating mouse pull — classic
// LMG feel.
const DEG_PER_SHOT_PITCH = 0.28;
const DEG_PER_SHOT_YAW_JITTER = 0.12;

const _ndcCenter = new THREE.Vector2();
const _hits: THREE.Intersection[] = [];
const _muzzleWorld = new THREE.Vector3();
const _tmp = new THREE.Vector3();
// Used only when the skinned-mesh muzzle hasn't been located yet
// (still-loading or fallback capsule). 30 cm below eye line reads
// as "coming from the torso" without a real gun model.
const _fallbackMuzzleOffset = new THREE.Vector3(0, -0.3, 0);
