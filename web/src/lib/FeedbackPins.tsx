import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';

import {
  listFeedbacks,
  subscribeFeedbacks,
  type Feedback,
} from './feedbackStore';

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
    return subscribeFeedbacks(() => {
      setFeedbacks(listFeedbacks(scenePath));
    });
  }, [scenePath]);

  const texture = useMemo(() => makePinTexture(), []);

  useEffect(() => {
    return () => {
      texture.dispose();
    };
  }, [texture]);

  if (feedbacks.length === 0) return null;

  return (
    <group userData={{ noCollide: true }}>
      {feedbacks.map((fb) => (
        <FeedbackPin key={fb.id} feedback={fb} texture={texture} />
      ))}
    </group>
  );
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
      depthTest: true,
      // depthWrite off so overlapping pins don't occlude each other
      // in weird ways — back pins still draw through front pins, but
      // the sprite z-sorting handles readability.
      depthWrite: false,
      // Keep pins visible even when a wall sits between the camera
      // and the anchor. Otherwise a pin on the far side of a pillar
      // would vanish and the user wouldn't know feedback was there.
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
    s.renderOrder = 5; // draw on top of regular scene meshes
    return s;
  }, [material, feedback.id]);

  return (
    <primitive object={sprite} position={[x, y + PIN_LIFT, z]} />
  );
}

const PIN_SIZE = 0.6; // metres tall in world space
const PIN_LIFT = 0.15; // lift above the raw hit to avoid z-fighting

/**
 * Bake a simple "pin" glyph into an off-screen canvas so we don't
 * need to ship an image asset. Drawn once, shared across all pin
 * sprites. The shape is a teardrop with a highlighted ring, scaled
 * to fill a 128×128 texture — small enough for fast upload, sharp
 * enough to stay readable when blown up to PIN_SIZE metres at the
 * near plane.
 */
function makePinTexture(): THREE.Texture {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  if (ctx) {
    // soft glow halo
    const halo = ctx.createRadialGradient(size / 2, size * 0.42, 4, size / 2, size * 0.42, size * 0.48);
    halo.addColorStop(0, 'rgba(255, 200, 80, 0.7)');
    halo.addColorStop(0.5, 'rgba(255, 160, 60, 0.15)');
    halo.addColorStop(1, 'rgba(255, 160, 60, 0)');
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
    ctx.fillStyle = '#ffcf6a';
    ctx.strokeStyle = '#6b4a00';
    ctx.lineWidth = 3;
    ctx.fill();
    ctx.stroke();

    // inner dot
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = '#6b4a00';
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
