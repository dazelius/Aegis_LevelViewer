import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';

import {
  listFeedbacks,
  pollFeedbacks,
  subscribeFeedbacks,
  type Feedback,
} from './feedbackStore';
import { setHoveredFeedbackId } from './feedbackHover';
import {
  clearBubbleProjections,
  isShowAllActive,
  pruneBubbleProjections,
  setBubbleProjection,
  subscribeShowAll,
} from './feedbackBubbles';

/**
 * Renders a small pin sprite at each feedback anchor for the current
 * scene. Mounted at all times (both Play and edit modes) so:
 *   - In Play mode, the user sees yesterday's pins while walking the
 *     level — the "come back tomorrow and see the feedback" loop.
 *   - In edit mode, pins double as navigation targets for the future
 *     "click pin → jump camera to this feedback's pose" feature.
 *
 * Implementation: one `THREE.Sprite` per feedback, using a tiny
 * canvas-baked pin glyph as the texture. Sprites are screen-space
 * aligned (always readable regardless of the camera angle) and
 * support depth sorting out of the box. Marked `noCollide` so
 * PlayerController's wall / ground / aim raycasts skip them.
 *
 * The sprite texture is lazily built the first time the component
 * mounts — one texture is shared across every pin. Updating it only
 * on prop change is fine because we don't re-style pins per feedback
 * yet (future: color-code by author, resolved/unresolved status).
 */
export function FeedbackPins({ scenePath }: { scenePath: string }) {
  const [feedbacks, setFeedbacks] = useState<Feedback[]>(() => listFeedbacks(scenePath));

  useEffect(() => {
    setFeedbacks(listFeedbacks(scenePath));
    const unsub = subscribeFeedbacks(() => {
      setFeedbacks(listFeedbacks(scenePath));
    });
    // Kick off a scene-scoped polling loop so other viewers'
    // newly-posted pins appear without requiring a hard refresh.
    // 15 s cadence is a tradeoff between "feels live" and "doesn't
    // hammer the server when many clients are open" — can be tuned
    // later if we add server-sent events or websockets.
    const stopPoll = pollFeedbacks(scenePath, 15000);
    return () => {
      unsub();
      stopPoll();
    };
  }, [scenePath]);

  // Two textures: the warm "open / needs attention" glyph and the
  // cool "resolved / reviewed" checkmark. Baked once and shared
  // across every pin of the matching status so we don't upload a
  // new texture per feedback. The per-pin sprite below swaps which
  // one it uses based on `feedback.status`, and React's key-stable
  // `<FeedbackPin>` reconciles the material change in place when a
  // pin transitions from open → resolved while the scene is live.
  const openTexture = useMemo(() => makePinTexture('open'), []);
  const resolvedTexture = useMemo(() => makePinTexture('resolved'), []);

  useEffect(() => {
    return () => {
      openTexture.dispose();
      resolvedTexture.dispose();
    };
  }, [openTexture, resolvedTexture]);

  if (feedbacks.length === 0) return null;

  return (
    <group userData={{ noCollide: true }}>
      {feedbacks.map((fb) => (
        <FeedbackPin
          key={fb.id}
          feedback={fb}
          texture={fb.status === 'resolved' ? resolvedTexture : openTexture}
        />
      ))}
      <FeedbackPinHoverProbe feedbacks={feedbacks} />
      <FeedbackPinBubbleProbe feedbacks={feedbacks} />
    </group>
  );
}

/**
 * Per-frame projector that populates the shared bubble-projections
 * map while the user is holding V. Lives INSIDE the R3F Canvas so
 * it can read the live camera without going through a ref chain —
 * the DOM overlay outside the Canvas then reads the map via its
 * own requestAnimationFrame loop and slots each bubble into place.
 *
 * Cost gating: when V isn't held (`isShowAllActive()` false) we
 * skip the projection work entirely. Every frame we check the flag
 * once via a module-level boolean read, which is essentially free
 * compared to the per-pin matrix mul we'd otherwise do. The flag
 * changes rarely (only on V up/down) so React subscription is
 * overkill — a direct read inside useFrame is simpler and avoids
 * an extra rerender dance.
 */
function FeedbackPinBubbleProbe({ feedbacks }: { feedbacks: Feedback[] }) {
  const camera = useThree((s) => s.camera);
  const v = useRef(new THREE.Vector3()).current;

  useFrame(() => {
    if (!isShowAllActive()) return;
    if (feedbacks.length === 0) return;
    const keep = new Set<string>();
    for (const fb of feedbacks) {
      keep.add(fb.id);
      v.set(fb.anchor[0], fb.anchor[1] + PIN_LIFT, fb.anchor[2]);
      v.project(camera);
      // Same behind-camera handling the hover probe uses. We still
      // WRITE a projection for offscreen points, but mark it
      // invisible so the overlay can hide that bubble instead of
      // trying to snap it to the screen edge.
      const visible = v.z >= 0 && v.z <= 1;
      setBubbleProjection(fb.id, {
        x: v.x,
        y: v.y,
        z: v.z,
        visible,
      });
    }
    // Garbage-collect projections for ids that no longer exist in
    // this scene (e.g. the user deleted a pin). Keeps the map from
    // accumulating stale entries over a long session.
    pruneBubbleProjections(keep);
  });

  useEffect(() => {
    return () => {
      clearBubbleProjections();
    };
  }, []);

  // Force a re-subscribe read when V toggles, purely so React knows
  // to keep this component mounted — the actual work is in useFrame.
  // Subscribing here is the cleanest way to make the probe "opt in"
  // to lifecycle updates coming from the shared store.
  useEffect(() => {
    return subscribeShowAll(() => {
      // no-op; the useFrame hook already reads the live flag.
    });
  }, []);

  return null;
}

/**
 * Per-frame hover detector for feedback pins. Projects every pin's
 * world-space anchor into normalised device coordinates (NDC) and
 * picks the one nearest the screen centre — the crosshair. We use
 * screen-space distance (not a raycast) because pins are deliberately
 * non-colliding sprites; `PlayerController` would already refuse to
 * treat them as aim targets.
 *
 * Selection rules:
 *   - Must be in front of the camera (NDC z ∈ (0, 1)); pins behind
 *     the camera project to z > 1 and still report a valid NDC x/y
 *     on the near plane, which would falsely "hover" a pin the
 *     player can't actually see.
 *   - NDC (x, y) distance from the crosshair within `HOVER_RADIUS`.
 *     HOVER_RADIUS is in NDC units (half-screen = 1.0), so 0.07 is
 *     ~7 % of the half-viewport — roughly the angular size of the
 *     pin sprite at typical framing. Tight enough that walking past
 *     one doesn't spam hover; loose enough that fine aim isn't
 *     required.
 *   - On tie, the CLOSEST pin (smallest NDC distance) wins. We do
 *     NOT factor in world distance — a far pin the user is aiming
 *     directly at should beat a near pin 30° off-axis, matching how
 *     reticle-based selection reads in any shooter.
 *
 * Side-effect only: writes to the module-level `feedbackHover`
 * store. The tooltip renderer lives in the DOM overlay and
 * subscribes to that store, so nothing inside the Canvas needs to
 * re-render on hover changes.
 */
function FeedbackPinHoverProbe({ feedbacks }: { feedbacks: Feedback[] }) {
  const camera = useThree((s) => s.camera);
  // Scratch vector reused every frame. Allocating inside useFrame
  // thrashes GC over a long session — one object per probe is fine.
  const v = useRef(new THREE.Vector3()).current;

  useFrame(() => {
    if (feedbacks.length === 0) {
      setHoveredFeedbackId(null);
      return;
    }
    let bestId: string | null = null;
    let bestDist = HOVER_RADIUS;
    for (const fb of feedbacks) {
      v.set(
        fb.anchor[0],
        fb.anchor[1] + PIN_LIFT,
        fb.anchor[2],
      );
      v.project(camera);
      // Behind the camera: project() gives z > 1 for anything past the
      // far plane AND for anything behind the near plane (Three's
      // WebGL projection maps −w/w for behind-camera to values outside
      // [-1, 1]). Reject z outside [0, 1] to be safe.
      if (v.z < 0 || v.z > 1) continue;
      const dx = v.x;
      const dy = v.y;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        bestId = fb.id;
      }
    }
    setHoveredFeedbackId(bestId);
  });

  // Clear hover when this probe unmounts (scene change) so a
  // stale tooltip from the previous scene doesn't linger.
  useEffect(() => {
    return () => setHoveredFeedbackId(null);
  }, []);

  return null;
}

function FeedbackPin({
  feedback,
  texture,
}: {
  feedback: Feedback;
  texture: THREE.Texture;
}) {
  // Lift the pin a bit above the raw anchor so it sits "on the
  // surface" rather than buried inside it — hit points from mesh
  // raycasts land ON the triangle, and drawing at that exact z-value
  // z-fights with the surface. 0.15 m is small enough that a pin on
  // a wall still reads as "that wall" but clear of z-fighting noise.
  const [x, y, z] = feedback.anchor;

  const material = useMemo(() => {
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      // X-ray visibility: depthTest OFF so the pin is never occluded
      // by level geometry. The whole point of an Aegisgram pin is
      // "someone dropped feedback here — go find it"; a pin hidden
      // behind a wall fails that goal. `renderOrder` below also
      // lifts it above normal scene meshes in the draw list so it
      // composites on top regardless of z value.
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: true,
      toneMapped: false,
    });
    return mat;
  }, [texture]);

  useEffect(() => {
    return () => material.dispose();
  }, [material]);

  // Disable raycast on the sprite so player controller's probes
  // don't treat pins as walls / floor / aim targets. Three.js's
  // default Sprite.raycast also needs the camera set on the
  // raycaster, which our PlayerController does NOT do (and can't,
  // cheaply, without extra plumbing) — the no-op is both correct
  // and a performance win.
  const sprite = useMemo(() => {
    const s = new THREE.Sprite(material);
    s.raycast = () => {};
    s.userData.noCollide = true;
    s.userData.feedbackId = feedback.id;
    // Scale roughly matches "readable tennis-ball at 10 m" — big
    // enough to spot across a room, small enough that several pins
    // in a corridor don't merge into a wall of icons.
    s.scale.set(PIN_SIZE, PIN_SIZE, 1);
    // High renderOrder so the sprite rasterises after opaque scene
    // geometry — combined with depthTest:false above, this keeps the
    // pin on top of walls / columns even when they'd naturally
    // occlude it. 9999 matches the crosshair reticle convention in
    // PlayerController for "always-on-top HUD elements".
    s.renderOrder = 9999;
    return s;
  }, [material, feedback.id]);

  return (
    <primitive object={sprite} position={[x, y + PIN_LIFT, z]} />
  );
}

const PIN_SIZE = 0.6; // metres tall in world space
const PIN_LIFT = 0.15; // lift above the raw hit to avoid z-fighting
/** NDC distance from screen centre within which a pin counts as
 *  "under the crosshair" for hover preview. Half-screen = 1.0, so
 *  0.07 ≈ 7 % of the half-viewport — close to the visual half-
 *  width of a PIN_SIZE sprite at typical third-person framing. */
const HOVER_RADIUS = 0.07;

/**
 * Bake a "pin" glyph into an off-screen canvas so we don't need to
 * ship an image asset. Drawn once per status and shared across all
 * pin sprites of that status. The shape is a teardrop with a
 * highlighted ring and a centred glyph (inner dot for 'open', a
 * checkmark for 'resolved'); the colour palette also shifts warm
 * → cool so the two states are legible from a distance without
 * relying on the glyph alone.
 */
function makePinTexture(status: 'open' | 'resolved'): THREE.Texture {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  // Palette per status.
  //   - open: warm amber — draws the eye the way it always has.
  //   - resolved: cool mint green — reads as "done" at a glance
  //     and visually dims into the background compared to open
  //     pins, which is exactly what we want when the user is
  //     scanning for unreviewed items.
  const palette = status === 'resolved'
    ? {
        haloA: 'rgba(120, 230, 160, 0.7)',
        haloB: 'rgba(90, 200, 140, 0.15)',
        haloC: 'rgba(90, 200, 140, 0)',
        fill: '#8fe8b8',
        stroke: '#1a4a2e',
      }
    : {
        haloA: 'rgba(255, 200, 80, 0.7)',
        haloB: 'rgba(255, 160, 60, 0.15)',
        haloC: 'rgba(255, 160, 60, 0)',
        fill: '#ffcf6a',
        stroke: '#6b4a00',
      };
  if (ctx) {
    const halo = ctx.createRadialGradient(size / 2, size * 0.42, 4, size / 2, size * 0.42, size * 0.48);
    halo.addColorStop(0, palette.haloA);
    halo.addColorStop(0.5, palette.haloB);
    halo.addColorStop(1, palette.haloC);
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, size, size);

    // teardrop body
    ctx.beginPath();
    const cx = size / 2;
    const cy = size * 0.42;
    const r = size * 0.28;
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.moveTo(cx - r * 0.78, cy + r * 0.62);
    ctx.lineTo(cx, size * 0.88);
    ctx.lineTo(cx + r * 0.78, cy + r * 0.62);
    ctx.closePath();
    ctx.fillStyle = palette.fill;
    ctx.strokeStyle = palette.stroke;
    ctx.lineWidth = 3;
    ctx.fill();
    ctx.stroke();

    // Status glyph: a centred dot for 'open', a check stroke for
    // 'resolved'. Drawn in the stroke colour so it reads against
    // the teardrop fill regardless of palette.
    ctx.strokeStyle = palette.stroke;
    ctx.fillStyle = palette.stroke;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (status === 'resolved') {
      ctx.lineWidth = Math.max(4, r * 0.28);
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.48, cy + r * 0.05);
      ctx.lineTo(cx - r * 0.08, cy + r * 0.42);
      ctx.lineTo(cx + r * 0.55, cy - r * 0.35);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
