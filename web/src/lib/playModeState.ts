import * as THREE from 'three';

/**
 * Module-scope singleton for cross-component Play-mode signals.
 *
 * Play mode has five components that all need to share a handful of
 * transient per-frame numbers:
 *
 *   PlayerController   — owns player transform, needs to slow movement
 *                        while firing.
 *   CharacterAvatar    — owns the skeleton, publishes the right-hand
 *                        / muzzle bone pose, consumes fire ticks to
 *                        drive procedural recoil.
 *   ShoulderCamera     — owns view, consumes recoil impulses.
 *   Shooter            — reads muzzle world-space pose for tracer
 *                        origin, writes firing / tick / recoil.
 *
 * We could plumb these through React context or prop drilling, but:
 *
 *   - Only one Play session runs at a time (single local player).
 *   - Updates happen every frame inside `useFrame`; going through
 *     React state is wasted overhead.
 *   - The producers/consumers live in the SAME render subtree — there
 *     is no risk of stale references after a subtree unmount.
 *
 * Result: one shared record reset each time Play begins.
 *
 * Convention: every field is a *latest-write-wins* ref updated each
 * frame. Consumers SHOULD check the age of values (`fireTime` vs
 * `clock.elapsedTime`) before reacting, so a stale state from a
 * previous Play session doesn't re-trigger effects on re-entry.
 */
export interface PlayModeState {
  /** World-space "muzzle" anchor — usually an empty Object3D parented
   *  to the character's right-hand bone, positioned at the gun's tip.
   *  `null` until the skinned mesh has loaded and the hand bone has
   *  been located. Tracer origin falls back to camera + offset when
   *  null so the shooter still works on the fallback capsule. */
  muzzle: THREE.Object3D | null;

  /** True while the user is holding the fire button AND pointer lock
   *  is active. PlayerController reads this to modulate move speed
   *  (Hip 4.5 → Hip+Fire 2.7 m/s, ≈60%) per the Aegis weapon-state
   *  speed table. CharacterAvatar reads it to cue the "fire pose"
   *  drift on top of normal locomotion. */
  firing: boolean;

  /** Clock time (THREE clock elapsedTime) of the most recent shot.
   *  CharacterAvatar + ShoulderCamera use this to decay recoil over
   *  time — a shot that just happened kicks at full strength, one
   *  from 0.2 s ago has already sprung back. Initialised to -1 so
   *  "never fired" is distinguishable from "fired at t=0". */
  fireTime: number;

  /** Fire tick counter — monotonically increments each shot. Lets
   *  consumers detect "a new shot happened THIS frame" without time
   *  comparisons (e.g. `lastSeenTick.current !== state.fireTick`).
   *  Useful for one-shot effects like muzzle flash spawn. */
  fireTick: number;

  /** True while the player is in crouch stance. Drives:
    *    - PlayerController: slower move speed, no sprint, no jump.
    *    - CharacterAvatar: crouch-variant animation selection.
    *    - ShoulderCamera: swap Stand_* preset for Crouch_* preset.
    *  Toggled by the C key; written by LevelViewer (the same layer
    *  that owns other play-mode global toggles like pointer lock). */
  crouching: boolean;

  /** World-space point under the crosshair, updated each frame by
   *  `PlayerController` from the screen-centre raycast. Consumers
   *  (feedback composer) use this to anchor a feedback pin at
   *  exactly whatever the user is looking at when they hit Enter —
   *  so marking "this wall texture is stretched" drops the pin ON
   *  the wall, not floating in front of the camera.
   *
   *  Always populated (never null) because the aim raycast has a
   *  fallback to "camera + far direction" when nothing is hit. Use
   *  `aimValid` to distinguish a real surface hit from the
   *  sky-fallback. */
  aimPoint: THREE.Vector3;

  /** True iff the latest aim raycast actually hit collidable scene
   *  geometry (vs. falling through to the far-plane fallback). We
   *  refuse to create feedback anchored on the fallback point —
   *  it's effectively "in the sky" and would drift if the camera
   *  moves. */
  aimValid: boolean;
}

function defaults(): PlayModeState {
  return {
    muzzle: null,
    firing: false,
    fireTime: -1,
    fireTick: 0,
    crouching: false,
    aimPoint: new THREE.Vector3(),
    aimValid: false,
  };
}

/** Single live instance. Mutated in place by useFrame callbacks — we
 *  rely on React's strict-mode single-mount-per-play-session to keep
 *  only one producer per field active at a time. */
export const playModeState: PlayModeState = defaults();

/** Reset on Play-mode enter so stale values from a previous session
 *  (different scene, reloaded page) don't leak through. Call from
 *  the `enterPlay` handler in LevelViewer. */
export function resetPlayModeState(): void {
  playModeState.muzzle = null;
  playModeState.firing = false;
  playModeState.fireTime = -1;
  playModeState.fireTick = 0;
  playModeState.crouching = false;
  playModeState.aimPoint.set(0, 0, 0);
  playModeState.aimValid = false;
}
