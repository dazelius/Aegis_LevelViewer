import { useEffect, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

import {
  loadPlayerCharacter,
  type PlayerAnimKey,
  type PlayerCharacterPack,
} from './playerCharacter';
import { playModeState } from './playModeState';

/**
 * Locomotion states the player avatar can crossfade between.
 * Intentionally coarse for M1 — the full Unity Mecanim controller
 * has dozens more (reload, fire, crouch, aim-offset blends), but we
 * only need enough to signal "stand / move / airborne" in third-person
 * view for the Level Viewer's navigation goal.
 */
export type AnimState =
  | 'idle'
  | 'runF'
  | 'runB'
  | 'runL'
  | 'runR'
  | 'jumpStart'
  | 'jumpLoop'
  | 'jumpEnd';

export interface CharacterAvatarProps {
  /** Live handle to the current locomotion state. A ref (not prop)
   *  so PlayerController can mutate it every frame without triggering
   *  React re-renders on the avatar. We read + diff inside useFrame. */
  stateRef: RefObject<AnimState>;
}

/**
 * Skinned-mesh avatar for Play mode. Mounts the `striker_low` FBX +
 * an `AnimationMixer`, and crossfades between clips whenever the
 * parent controller flips `stateRef.current`. Until the character
 * asset has loaded (cold cache, ~100–400 ms on localhost) we render a
 * placeholder capsule so the player has SOMETHING at the spawn point
 * instead of an empty group.
 *
 * Orientation note: Unity humanoid FBXes are authored facing local
 * +Z, and PlayerController's yaw is `atan2(camForward.x, camForward.z)`
 * which likewise treats +Z as "forward" (so the player yaw and the
 * camera yaw agree). Net result: no additional local rotation is
 * needed — we render the FBX unmodified and it faces the same way
 * the PlayerController thinks "forward" is. The first cut wrapped in
 * a `rotation={[0, π, 0]}` group under the mistaken assumption that
 * Three camera-forward is −Z; that made the avatar walk backwards
 * through the world (reported as "거꾸로 보고 있어").
 */
export function CharacterAvatar({ stateRef }: CharacterAvatarProps) {
  const [pack, setPack] = useState<PlayerCharacterPack | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionsRef = useRef<Partial<Record<PlayerAnimKey, THREE.AnimationAction>>>({});
  // Wider than AnimState so we can record the internal "runFAim"
  // swap — see the useFrame body for why. AnimState is the PUBLIC
  // surface exposed to PlayerController; PlayerAnimKey is what the
  // mixer action table is keyed by.
  const currentRef = useRef<PlayerAnimKey | null>(null);

  // Bones the recoil layer writes to. Captured once on pack-ready so
  // we don't traverse the skeleton every frame. Null until load.
  const recoilBonesRef = useRef<{
    chest: THREE.Bone | null;
    rightArm: THREE.Bone | null;
    rightHand: THREE.Bone | null;
  }>({ chest: null, rightArm: null, rightHand: null });

  // Upper-body bones we can snap to an aim pose when the player fires
  // mid-air. Populated on pack-ready. Kept separate from recoilBones
  // because the aim snap needs MORE bones (forearms, clavicles, neck)
  // than the recoil kick does — recoil only needs the "big 3" rigid
  // links so the kick reads from behind the camera; the aim snap has
  // to bring both hands plus the chest rotation into the rifle hold
  // silhouette, otherwise the left hand still hangs loose from the
  // jump clip while only the right side comes up.
  const upperBodyBonesRef = useRef<THREE.Bone[]>([]);

  // Quaternion snapshot of the rifle aim-idle pose, keyed by bone
  // name. Sampled from `clips.idle`'s first frame at load time so we
  // can bias the upper body toward it while airborne + firing without
  // paying a per-frame track decode. Null until load.
  const aimPoseRef = useRef<Map<string, THREE.Quaternion> | null>(null);

  // Muzzle anchor — published via the shared playModeState so the
  // Shooter knows where tracers should originate.
  //   * Weapon mesh present: muzzleRef sits at the gun's muzzle tip
  //     (either an explicitly-named child node if the FBX has one,
  //     or a forward offset from the weapon's local origin).
  //   * No weapon mesh: muzzleRef sits on the right-hand bone at a
  //     rifle-tip approximation so tracers still read as "out of the
  //     hand" even on the empty character.
  const muzzleRef = useRef<THREE.Object3D | null>(null);
  // The weapon group parented under the right-hand bone. Tracked so
  // we can remove it on unmount (the cached FBX group outlives this
  // component; double-parenting on remount would break the scene
  // graph).
  const weaponRef = useRef<THREE.Group | null>(null);
  // Scale-compensation wrapper between the right-hand bone and the
  // weapon. Explanation: `loadPlayerCharacter` applies the character
  // FBX's `unitScaleFactor / 100` to the pack's root group (e.g. a
  // cm-native rig ends up with root scale 0.01 so it renders at
  // 1.8 m tall in world metres). Bones inherit that scale through
  // matrixWorld, so `rightHand.matrixWorld.scale` is also 0.01. The
  // weapon FBX has its OWN unitScaleFactor applied (so it's already
  // in world-metres as a standalone). If we parent the weapon
  // directly under the bone, the two scales compound (0.01 × 0.01 =
  // 1e-4) and the rifle comes out ~7.5 mm long — invisible. The wrap
  // group below sits between bone and weapon with a scale of
  // `1 / characterRootScale`, cancelling the parent shrink so
  // everything inside (weapon mesh + grip offsets + muzzle offset)
  // works in world-metres exactly as the constants below are
  // authored.
  const weaponAttachRef = useRef<THREE.Object3D | null>(null);

  // Persistent recoil offset applied each frame on top of the mixer
  // output. Three separate Eulers so procedural kick on the arm
  // doesn't fight the chest hip sway and vice versa. Decay toward 0
  // each frame for spring-back.
  const recoilStateRef = useRef({
    chestPitch: 0,
    armPitch: 0,
    armYaw: 0,
    handRoll: 0,
  });
  const lastFireTickRef = useRef(0);

  // Kick off the (cached) character load on mount.
  useEffect(() => {
    let cancelled = false;
    loadPlayerCharacter()
      .then((p) => {
        if (!cancelled) setPack(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
        // eslint-disable-next-line no-console
        console.error('[CharacterAvatar] load failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build the mixer + action table whenever the pack arrives.
  // Re-runs on pack identity change; in practice this fires once per
  // session because loadPlayerCharacter() caches.
  useEffect(() => {
    if (!pack) return;
    const mixer = new THREE.AnimationMixer(pack.group);
    mixerRef.current = mixer;
    const actions: Partial<Record<PlayerAnimKey, THREE.AnimationAction>> = {};
    for (const key of Object.keys(pack.clips) as PlayerAnimKey[]) {
      const clip = pack.clips[key];
      if (!clip) continue;
      const act = mixer.clipAction(clip);
      // One-shot clips (jump_start / jump_end) still loop here so
      // they keep playing if the state machine gets stuck on them —
      // the state machine itself manages transitions, and a looping
      // fallback is less jarring than a frozen T-pose.
      act.setLoop(THREE.LoopRepeat, Infinity);
      act.clampWhenFinished = false;
      actions[key] = act;
    }
    actionsRef.current = actions;

    // --- Bone hookup for procedural recoil & muzzle anchor ---------
    //
    // Aegis / 3ds Max humanoid rigs name the bones either plain
    // ("RightHand", "RightArm", "Spine2") or `Bip01 R Hand`. We try
    // both. Hand bone is the priority — without it we skip muzzle
    // publication entirely. Chest/arm are optional: missing bones
    // just disable the corresponding recoil track.
    const bones = findRecoilBones(pack.group);
    recoilBonesRef.current = bones;
    upperBodyBonesRef.current = collectUpperBodyBones(pack.group);

    // Sample the aim-idle first-frame pose so the "airborne firing"
    // code path can lerp the upper body toward it. Skipped (null) if
    // idle clip didn't load — the fallback is "no aim snap in air",
    // which at least doesn't crash.
    if (pack.clips.idle) {
      aimPoseRef.current = sampleAimPose(pack.clips.idle);
    } else {
      aimPoseRef.current = null;
    }

    if (bones.rightHand) {
      // Build a fresh muzzle anchor every time the avatar remounts
      // (hot-reload) — the old one's detach happens in the cleanup
      // below, but React may re-run this effect before the old
      // cleanup has fired, so we scope creation to "no current
      // muzzle".
      if (!muzzleRef.current) {
        const muzzle = new THREE.Object3D();
        muzzle.name = 'playerMuzzle';
        muzzleRef.current = muzzle;
      }
      const muzzle = muzzleRef.current;

      // --- Weapon attachment path -----------------------------------
      if (pack.weapon && !weaponRef.current) {
        const weapon = pack.weapon;

        // Build (or reuse) the scale-compensation wrapper. Pack root
        // scale is uniform (uf / 100), usually 0.01 for cm-native
        // rigs. Setting the attach's scale to 1/rootScale means the
        // bone → attach link contributes world-scale 1.0, so
        // everything BELOW `attach` renders with the weapon FBX's
        // own (already-metre) scale untouched, and offsets authored
        // below are interpreted in world-metres.
        if (!weaponAttachRef.current) {
          const attach = new THREE.Object3D();
          attach.name = 'weaponAttach';
          attach.userData.noCollide = true;
          weaponAttachRef.current = attach;
        }
        const attach = weaponAttachRef.current;
        const rootScale = pack.group.scale.x || 0.01;
        attach.scale.setScalar(1 / rootScale);
        // Palm correction. The hand bone's local frame varies across
        // rigs (3ds Max Biped vs Maya HIK vs Unity Humanoid re-export)
        // and for the striker rig the rest-pose hand axes are not
        // aligned with "aim down the barrel". Rather than guess a
        // fixed Euler (which kept coming out tilted — user report:
        // "총구가 밑을 향하고 있다"), we SAMPLE the rig: snap the
        // skeleton to the aim-idle clip's first frame (the canonical
        // "holding a rifle level at chest" pose), read the right-hand
        // bone's world quaternion in that pose, and compute the
        // attach's LOCAL quaternion so that:
        //
        //     attach.worldQuat = handWorldQuat * attachLocalQuat
        //                      = characterRootWorldQuat
        //
        // ⇒ `attach.+Z` points along the character's forward axis
        //   whenever the character is in its aim-idle pose.
        //
        // When the active animation is NOT aim-idle (e.g. jump
        // clip), the hand bone's world quaternion differs and the
        // weapon rotates along with it — that's the natural
        // behaviour for a mesh prop held in the hand (if you throw
        // your arm up the rifle goes up). The pose we SNAPSHOT at
        // attach time decides what "neutral" looks like; anything
        // the animation does on top is additive motion on top of
        // that neutral.
        //
        // Why sample from idle rather than the bind pose: Aegis'
        // rest pose leaves the right hand hanging at the thigh with
        // its palm facing the leg — computing from that makes the
        // rifle aim 90° into the leg instead of forward. The
        // aim-idle first frame has the hand already gripping at
        // chest level, which is exactly the orientation we want
        // "holding the weapon" to mean.
        if (actions.idle) {
          actions.idle.reset();
          actions.idle.play();
          mixer.update(0);
          pack.group.updateMatrixWorld(true);
        }
        const handWorldQ = new THREE.Quaternion();
        bones.rightHand.getWorldQuaternion(handWorldQ);
        const charWorldQ = new THREE.Quaternion();
        pack.group.getWorldQuaternion(charWorldQ);
        // attachLocalQ = hand^-1 * char → attach.worldQuat == charWorldQ
        const attachLocalQ = handWorldQ.clone().invert().multiply(charWorldQ);
        attach.quaternion.copy(attachLocalQ);
        attach.position.set(WEAPON_PALM_OFFSET[0], WEAPON_PALM_OFFSET[1], WEAPON_PALM_OFFSET[2]);

        weapon.userData.noCollide = true;
        weapon.traverse((obj) => {
          obj.userData.noCollide = true;
        });

        // Diagnostic dump of every named transform inside the weapon
        // FBX. Helps answer "is there a grip/muzzle helper bone we
        // could anchor to?" — if a future weapon has a named
        // `Muzzle` / `Grip` / `Socket_*` node we can upgrade the
        // auto-orient path to snap to it instead of going through
        // bbox detection. Cheap: runs once per weapon load.
        const weaponNodeNames: string[] = [];
        weapon.traverse((obj) => {
          if (obj.name) weaponNodeNames.push(obj.name);
        });
        // eslint-disable-next-line no-console
        console.info(
          '[CharacterAvatar] weapon FBX nodes:',
          weaponNodeNames.slice(0, 40),
          weaponNodeNames.length > 40 ? `(+${weaponNodeNames.length - 40} more)` : '',
        );

        bones.rightHand.add(attach);
        attach.add(weapon);
        weaponRef.current = weapon;

        // --- Weapon self-orient (bbox-driven) -----------------------
        //
        // Instead of asking the artist (or us) to remember which
        // local axis of the FBX is the barrel, detect it from the
        // weapon's bounding box: the longest axis is the barrel, and
        // the furthest extent from origin along that axis is the
        // muzzle side. We then rotate the weapon so that axis lines
        // up with `attach.local +Z` (the "aim forward" direction we
        // just set up on the attach), and translate so the OPPOSITE
        // end (the grip/butt-stock) sits at the attach origin. The
        // user gets the rifle grip in the palm with the barrel
        // pointing down the aim line regardless of which axis the
        // FBX was authored along.
        //
        // Why we do it here and not at load-time: we need the final
        // hierarchical scale to be settled so the bbox numbers
        // match world-metres. `loadWeaponGroup` runs before we know
        // the character's root scale.
        orientAndGripWeapon(weapon);

        // Diagnostic: print bounding-box extents after attachment so
        // a future weapon/rig swap can verify scaling at a glance
        // (we've been bitten multiple times by silent scale chains;
        // user: "총기 모델 어디갔어"). Computed in world space so
        // the numbers directly say "is the weapon visible from the
        // shoulder camera?".
        weapon.updateMatrixWorld(true);
        const bbox = new THREE.Box3().setFromObject(weapon);
        const sz = new THREE.Vector3();
        bbox.getSize(sz);
        // eslint-disable-next-line no-console
        console.info(
          '[CharacterAvatar] weapon attached:',
          { rootScale: rootScale.toFixed(4), worldSize: [sz.x.toFixed(3), sz.y.toFixed(3), sz.z.toFixed(3)] },
        );

        // Muzzle: prefer an explicitly-named node inside the weapon
        // if the FBX has one (Aegis DCC exports sometimes include a
        // helper null at the muzzle tip). Otherwise use the barrel
        // tip we computed in `orientAndGripWeapon` — stored on
        // weapon.userData.barrelTipZ.
        const muzzleNode = findWeaponMuzzleNode(weapon);
        if (muzzleNode) {
          if (muzzle.parent) muzzle.parent.remove(muzzle);
          muzzleNode.add(muzzle);
          muzzle.position.set(0, 0, 0);
          muzzle.rotation.set(0, 0, 0);
        } else {
          if (muzzle.parent) muzzle.parent.remove(muzzle);
          weapon.add(muzzle);
          const tipZ = (weapon.userData.barrelTipZ as number | undefined) ?? WEAPON_MUZZLE_OFFSET[2];
          muzzle.position.set(0, 0, tipZ);
          muzzle.rotation.set(0, 0, 0);
        }
      } else if (!pack.weapon) {
        // No weapon mesh — the muzzle rides directly on the hand bone
        // with a rifle-tip approximation so tracers still make sense.
        if (!muzzle.parent) {
          muzzle.position.set(0, -0.06, 0.38);
          bones.rightHand.add(muzzle);
        }
      }
    }
    playModeState.muzzle = muzzleRef.current;

    // Seed: play whatever state the controller has already set (the
    // controller's useFrame has likely fired before the async load
    // finished, so `stateRef.current` is already `idle` / `runF` /
    // etc.). Fallback to idle when that specific clip didn't load.
    const seed = (stateRef.current ?? 'idle') as AnimState;
    const seedAct = actions[seed] ?? actions.idle;
    if (seedAct) {
      seedAct.reset().setEffectiveWeight(1).play();
      currentRef.current = actions[seed] ? seed : 'idle';
    }

    return () => {
      mixer.stopAllAction();
      mixerRef.current = null;
      actionsRef.current = {};
      currentRef.current = null;
      // Detach weapon + muzzle so a remount doesn't double-insert
      // under the cached bone graph. Order matters: muzzle first,
      // because it may be parented under the weapon (explicit
      // muzzleNode path) — removing the weapon first would detach
      // the muzzle with it and leave us with a dangling parent
      // reference on muzzleRef.
      const m = muzzleRef.current;
      if (m && m.parent) m.parent.remove(m);
      muzzleRef.current = null;
      const w = weaponRef.current;
      if (w && w.parent) w.parent.remove(w);
      weaponRef.current = null;
      const at = weaponAttachRef.current;
      if (at && at.parent) at.parent.remove(at);
      weaponAttachRef.current = null;
      playModeState.muzzle = null;
      recoilBonesRef.current = { chest: null, rightArm: null, rightHand: null };
      upperBodyBonesRef.current = [];
      aimPoseRef.current = null;
    };
  }, [pack, stateRef]);

  // Per-frame: advance the mixer AND react to state-ref diffs.
  // Crossfade via `crossFadeTo` (equal-time): we weight the outgoing
  // action to 0 and the incoming to 1 over CROSSFADE_DURATION. The
  // default is 0.15 s — short enough to feel snappy in a shooter,
  // long enough to mask the pose pop between idle and run.
  useFrame((_state, dt) => {
    const mixer = mixerRef.current;
    if (!mixer) return;
    const now = _state.clock.elapsedTime;

    // Resolve the ACTUAL clip key to play this frame. The controller
    // only ever sets coarse locomotion states (idle/runF/runB/runL/
    // runR/jump*); the firing flag, which lives on the shared
    // `playModeState` and flips the moment the user presses LMB,
    // picks between "un-aimed sprint" and "aim-run" variants of the
    // same locomotion state on our side.
    //
    // Only runF gets a swap because:
    //   * idle is already the aim-idle clip (weapon forward).
    //   * runB/L/R only have aim variants in the Aegis library, so
    //     there's no non-aim fallback to swap FROM in the first place.
    //   * jump* are airborne; firing mid-air uses the SAME jump clip
    //     for legs (so the character keeps its jump silhouette) and
    //     biases the UPPER body toward the aim pose in Step 1.5
    //     below. Putting that on top of the jump clip avoids the
    //     need for a dedicated rifle_stand_aim_jump_* clip, which
    //     Aegis doesn't ship.
    //
    // Fallback chain: if the aim-run clip failed to load for any
    // reason, we keep runF so the player still animates instead of
    // T-posing. The procedural recoil alone will still read as
    // "this person is shooting" even without the aim pose swap.
    const rawDesired = (stateRef.current ?? 'idle') as AnimState;
    const actions = actionsRef.current;
    // `desired` is a SuperState of AnimState — it adds internal
    // "runFAim" + "crouchIdle" / "crouchWalk*" / "crouchWalkFAim"
    // variants that the controller never emits itself. Typed wider
    // here so the action-table lookup (which IS keyed by
    // PlayerAnimKey and includes those) type-checks.
    //
    // Resolution order:
    //   stance × firing × locomotion → clip
    //
    // Crouch wins over firing: if we're crouched, we NEVER play a
    // standing clip even while firing (there's a dedicated crouch
    // aim clip for that). Jump clips ignore crouch entirely — you
    // can't crouch mid-air.
    let desired: PlayerAnimKey = rawDesired;
    const crouching = playModeState.crouching;
    const firing = playModeState.firing;
    // "aim pose active" means the upper body should hold the shouldered
    // rifle posture — true both when the trigger is held (firing) AND
    // when the user is just aiming down sights without shooting. The
    // runFAim / crouchWalkFAim clips were authored for the firing
    // case, but the pose they produce (weapon shouldered, both hands
    // on the gun, chest facing forward) is exactly what ADS needs, so
    // we reuse them for the aim-without-fire branch too.
    const aimActive = firing || playModeState.aiming;

    if (rawDesired === 'jumpStart' || rawDesired === 'jumpLoop' || rawDesired === 'jumpEnd') {
      // airborne: leave jumping clips alone regardless of stance.
    } else if (crouching) {
      switch (rawDesired) {
        case 'idle':
          desired = actions.crouchIdle ? 'crouchIdle' : rawDesired;
          break;
        case 'runF':
          if (aimActive && actions.crouchWalkFAim) desired = 'crouchWalkFAim';
          else if (actions.crouchWalkF) desired = 'crouchWalkF';
          break;
        case 'runB':
          if (actions.crouchWalkB) desired = 'crouchWalkB';
          break;
        case 'runL':
          if (actions.crouchWalkL) desired = 'crouchWalkL';
          break;
        case 'runR':
          if (actions.crouchWalkR) desired = 'crouchWalkR';
          break;
      }
    } else if (rawDesired === 'runF' && aimActive && actions.runFAim) {
      desired = 'runFAim';
    }
    const current = currentRef.current;
    if (current !== desired) {
      const from = current ? actions[current] : null;
      const to = actions[desired] ?? actions.idle;
      if (to && to !== from) {
        to.reset().setEffectiveWeight(1).play();
        if (from) {
          // Quick swap when flipping between the same-locomotion
          // firing / non-firing variants (stand OR crouch): the gun
          // should come up the instant LMB is depressed. A 150 ms
          // fade on a trigger pull reads as weapon input lag.
          // Stance changes (stand → crouch) keep the normal fade
          // because they should feel weighty.
          const isAimSwap =
            (current === 'runF' && desired === 'runFAim') ||
            (current === 'runFAim' && desired === 'runF') ||
            (current === 'crouchWalkF' && desired === 'crouchWalkFAim') ||
            (current === 'crouchWalkFAim' && desired === 'crouchWalkF');
          const fade = isAimSwap ? RUNF_AIM_SWAP_DURATION : CROSSFADE_DURATION;
          from.crossFadeTo(to, fade, false);
        }
        currentRef.current = desired;
      }
    }

    // Step 1: advance the skeletal animation first. The mixer writes
    // its clip output into every bone's local quaternion, wiping
    // whatever procedural pose we applied on the previous frame —
    // which is exactly what we want. Procedural recoil is an ADDITIVE
    // layer applied AFTER the mixer so it rides on top of the
    // locomotion without permanently drifting it.
    mixer.update(dt);

    // Step 1.5 — Airborne aim bias.
    //
    // Problem: Aegis' animation library doesn't ship a
    // "rifle_stand_aim_jump_*" clip. The baseline `jump_start / loop
    // / end` clips were authored un-armed, so during a jump the
    // character's arms hang at the sides while LMB is held. Tracers,
    // muzzle flash, and the procedural recoil already fire (the
    // Shooter doesn't gate on airborne state), but visually it reads
    // as "arms asleep while bullets magically spawn out of the
    // shoulder" — user: "점프 사격 모션도 연결해줘".
    //
    // Solution: when airborne AND firing, ease the upper-body bones
    // toward the aim-idle rest pose we sampled at load time. The
    // LERP weight grows with how long LMB has been held (so a tap-
    // fire gets a subtle arm twitch, sustained fire locks into a
    // full rifle silhouette). This runs BEFORE the recoil step so
    // the kick rides on top of the aimed pose, not the jump pose.
    //
    // Non-airborne firing uses the dedicated `runFAim` / `crouch*Aim`
    // clips instead, which the state machine above already swaps in.
    const airborne =
      rawDesired === 'jumpStart' || rawDesired === 'jumpLoop' || rawDesired === 'jumpEnd';
    if (airborne && firing) {
      const aim = aimPoseRef.current;
      const bones = upperBodyBonesRef.current;
      if (aim && bones.length > 0) {
        // Fire-hold ramp: we approximate "how long has trigger been
        // held" via fireTick cadence. Shooter publishes a new tick
        // every shot at ~12 rps, so after ~0.2 s of continuous fire
        // (2–3 ticks) we want the arms fully committed. Ramp value
        // tracks fireTime directly — simpler and doesn't need a new
        // ref.
        // Shooter publishes `fireTime` using R3F's `clock.elapsedTime`
        // (seconds since the Canvas mounted), so we subtract against
        // the same clock here. Using `performance.now()` would produce
        // a giant offset the very first frame of a session and lock
        // the weight to ~0 for ever.
        const holdS = Math.max(0, now - playModeState.fireTime);
        // Invert: holdS is "seconds since LAST shot". Weight should
        // be HIGH when holdS is small (recent shot), low when stale.
        // Half-life ≈ 120 ms ⇒ arms relax within 200-300 ms of last
        // trigger pull.
        const weight = Math.max(0, Math.min(1, Math.exp(-holdS / 0.12)));
        if (weight > 0.01) {
          for (const b of bones) {
            const target = aim.get(b.name);
            if (!target) continue;
            b.quaternion.slerp(target, weight);
          }
        }
      }
    }

    // Step 2: detect "new shot this frame" via tick diff. On a new
    // shot, inject an impulse into our recoil state; every frame
    // (shot or not) the state decays toward zero so the pose springs
    // back between rounds. 10 rps = one kick per ~0.1 s, decay time
    // constant of ~0.12 s keeps each kick distinguishable without
    // stacking into a locked pose.
    const tick = playModeState.fireTick;
    if (tick !== lastFireTickRef.current) {
      const kickScale = 1; // full strength for every shot in M1
      const rs = recoilStateRef.current;
      // Random small jitter so continuous fire doesn't look perfectly
      // periodic. Ranges tuned to read on the shoulder-cam POV.
      rs.chestPitch += (Math.random() * 0.5 + 0.75) * 0.05 * kickScale;  // up to ~3°
      rs.armPitch   += (Math.random() * 0.5 + 0.75) * 0.12 * kickScale;  // up to ~8°
      rs.armYaw     += (Math.random() - 0.5) * 0.06 * kickScale;         // ±1.7° lateral
      rs.handRoll   += (Math.random() - 0.5) * 0.08 * kickScale;         // ±2.3° wrist torque
      lastFireTickRef.current = tick;
    }

    // Step 3: decay the recoil state. Exponential time constant τ so
    // the amplitude halves every `τ · ln 2 ≈ 0.083` s at τ=0.12.
    const RECOIL_TAU = 0.12;
    const decay = Math.exp(-dt / RECOIL_TAU);
    const rs = recoilStateRef.current;
    rs.chestPitch *= decay;
    rs.armPitch *= decay;
    rs.armYaw *= decay;
    rs.handRoll *= decay;

    // Step 4: apply recoil on top of the mixer pose. We rotate each
    // contributing bone a little — bigger kick on the arm that
    // actually holds the gun, subtler rear-lean on the chest so the
    // whole torso reacts like a gas-operated rifle would.
    //
    // NB: Unity / 3ds Max rigs put the arm bone's local +X roughly
    // along the bone (collar → wrist). A pitch recoil is therefore a
    // rotation around the bone's local Z (up-vector cross bone-
    // forward). We'd have to inspect the bind pose to get this
    // exact per-rig; the "noisy but natural" choice is to just rotate
    // around WORLD X (pitch up), which reads as a muzzle climb to
    // any viewer angle and doesn't need the per-rig calibration. The
    // arm/hand bones inherit the chest's pitch automatically, so the
    // additive becomes a *residual* kick beyond the chest movement.
    const bones = recoilBonesRef.current;
    if (bones.chest) {
      // Apply world-X pitch on top of the mixer pose.
      _qKick.setFromAxisAngle(_axisX, -rs.chestPitch);
      bones.chest.quaternion.multiply(_qKick);
    }
    if (bones.rightArm) {
      _qKick.setFromAxisAngle(_axisX, -rs.armPitch);
      bones.rightArm.quaternion.multiply(_qKick);
      _qKick.setFromAxisAngle(_axisY, rs.armYaw);
      bones.rightArm.quaternion.multiply(_qKick);
    }
    if (bones.rightHand) {
      _qKick.setFromAxisAngle(_axisZ, rs.handRoll);
      bones.rightHand.quaternion.multiply(_qKick);
    }
  });

  if (!pack) {
    // While the FBX is in flight (or fails to load), render a rough
    // proxy so the spawn point still reads as "a player is here".
    // Styled differently from the old capsule so a persistent fallback
    // is visible as "something's wrong" rather than "design choice".
    return (
      <group>
        <mesh position={[0, 0.9, 0]}>
          <capsuleGeometry args={[0.35, 1.0, 6, 12]} />
          <meshStandardMaterial
            color={error ? '#cc3333' : '#808080'}
            metalness={0.1}
            roughness={0.8}
          />
        </mesh>
      </group>
    );
  }

  return <primitive object={pack.group} />;
}

const CROSSFADE_DURATION = 0.15;
// Trigger-pull → aim-pose swap. Faster than the generic crossfade
// because any perceptible lag here reads as weapon input lag — the
// gun should come up the instant LMB is depressed, not 150 ms later.
const RUNF_AIM_SWAP_DURATION = 0.06;

// --- Weapon rig calibration -----------------------------------------
//
// We split the calibration into TWO halves:
//
//   1. ATTACH (pose-sampled quaternion + `WEAPON_PALM_OFFSET`): how
//      the "weaponAttach" wrapper sits inside the right-hand bone.
//      The orientation half is computed at runtime by sampling the
//      aim-idle clip's first frame (see the `attach.quaternion.copy`
//      block in the mount effect) so attach.+Z ends up along the
//      character's forward axis regardless of what the hand bone's
//      local axes are in the bind pose. Only the positional palm
//      tweak survives as a constant — it's rig-specific (not
//      weapon-specific), so swapping rifles doesn't change it.
//      same.
//
//   2. WEAPON (`orientAndGripWeapon`): how the rifle sits inside the
//      attach. Computed dynamically from the weapon's bbox: longest
//      axis = barrel, orient so barrel-tip → attach.+Z, translate so
//      the OPPOSITE end (grip/butt) sits at attach origin. Works for
//      any FBX authoring convention without us having to know which
//      local axis is the barrel.
//
// If you swap the character rig, re-tune half (1). If you swap the
// weapon, everything is auto.
//
// Only the TRANSLATIONAL palm tweak lives here as a constant — the
// rotational half is computed at runtime from the aim-idle pose
// (see the `attach.quaternion.copy(attachLocalQ)` branch in the
// mount effect). Previous attempts hard-coded a fixed Euler here
// and kept miss-orienting (user report: "총구가 밑을 향하고 있다"),
// because the "right" Euler depends on which axis convention the
// DCC exporter used for the hand bone — 3ds Max Biped and Maya HIK
// disagree, Unity's Humanoid re-export can differ again, and even
// same-export-tool rigs can end up transposed if bind-pose
// alignment differs. Sampling the pose sidesteps all of it: we
// measure how the skeleton holds the rifle and derive the local
// quaternion algebraically.

/** [x, y, z] — attach origin offset from the right-hand bone origin,
 *  in metres (the attach's 1/rootScale scaling puts us in world
 *  metres inside). Small +up and +forward to clear the fingers. */
const WEAPON_PALM_OFFSET: [number, number, number] = [0, 0.02, 0.03];

/** Fallback muzzle offset (metres) used only when neither the FBX
 *  has a named muzzle helper nor we could derive a barrel tip from
 *  the bbox — belt-and-suspenders default so `Shooter` still spawns
 *  tracers from something-like-the-front-of-the-rifle. */
const WEAPON_MUZZLE_OFFSET: [number, number, number] = [0, 0, 0.45];

// Hot-path scratch for recoil application.
const _qKick = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);

/**
 * Orient a weapon inside its parent attach so the barrel exits along
 * the attach's local +Z, and slide it along +Z so the grip end sits
 * at the attach origin (≈ the palm). Works independent of which FBX
 * axis the artist happened to use for the barrel.
 *
 * Algorithm:
 *   1. Snapshot bbox in weapon-local (identity rotation + identity
 *      position). The bbox's longest axis is the barrel.
 *   2. The END of the barrel is whichever extent (±) is further
 *      from origin along that axis — most weapon FBXes have origin
 *      near the grip so the muzzle is on the far positive side, but
 *      we tolerate either.
 *   3. Build the shortest-arc quaternion that rotates
 *      (barrelAxis) → (0, 0, 1).
 *   4. After rotation, the grip/butt end is at `minZ_after_rotation`
 *      (negative), so translate by -minZ_after_rotation along +Z to
 *      bring the grip to z=0.
 *   5. Stash the post-rotation barrel tip Z on userData so the
 *      muzzle anchor can be placed exactly at the muzzle without
 *      recomputing the bbox.
 *
 * The choice of "shortest-arc" quaternion in step 3 is intentional:
 * it avoids gratuitous roll around the barrel axis. If the result
 * looks roll-wrong (scope sideways) on a specific rig, multiply an
 * extra `THREE.Quaternion().setFromAxisAngle(_axisZ, k)` into the
 * attach quaternion AFTER the pose-sampled copy — the roll knob
 * lives on the rig-side wrapper, not in this function.
 */
function orientAndGripWeapon(weapon: THREE.Group): void {
  // 1. Neutralise rotation/position before measuring. We also
  //    TEMPORARILY detach from the parent so `setFromObject`
  //    produces the bbox in weapon-local space (modulo the weapon's
  //    own scale) rather than inheriting whatever yaw/pitch/roll the
  //    hand bone currently carries from the aim-idle clip — which
  //    would rotate our "longest axis" detection into world space
  //    and make the detection drift every frame with the pose.
  const savedParent = weapon.parent;
  if (savedParent) savedParent.remove(weapon);
  weapon.quaternion.identity();
  weapon.position.set(0, 0, 0);
  weapon.updateMatrixWorld(true);

  const preBox = new THREE.Box3().setFromObject(weapon);
  if (preBox.isEmpty()) {
    if (savedParent) savedParent.add(weapon);
    return;
  }
  const preSize = new THREE.Vector3();
  const preCenter = new THREE.Vector3();
  preBox.getSize(preSize);
  preBox.getCenter(preCenter);

  // 2. Pick longest axis as barrel; sign = whichever extent is
  // further from origin.
  type Axis = 'x' | 'y' | 'z';
  let axis: Axis = 'x';
  if (preSize.y >= preSize.x && preSize.y >= preSize.z) axis = 'y';
  else if (preSize.z >= preSize.x && preSize.z >= preSize.y) axis = 'z';

  const lo = axis === 'x' ? preBox.min.x : axis === 'y' ? preBox.min.y : preBox.min.z;
  const hi = axis === 'x' ? preBox.max.x : axis === 'y' ? preBox.max.y : preBox.max.z;
  const sign = Math.abs(hi) >= Math.abs(lo) ? 1 : -1;

  const barrelDir = new THREE.Vector3(
    axis === 'x' ? sign : 0,
    axis === 'y' ? sign : 0,
    axis === 'z' ? sign : 0,
  );

  // 3. Shortest-arc rotation barrelDir → +Z.
  const targetDir = new THREE.Vector3(0, 0, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(barrelDir, targetDir);
  weapon.quaternion.copy(q);
  weapon.updateMatrixWorld(true);

  // 4. Recompute bbox to find the grip side (min z in new frame).
  const postBox = new THREE.Box3().setFromObject(weapon);
  const postMinZ = postBox.min.z;
  const postMaxZ = postBox.max.z;
  weapon.position.set(0, 0, -postMinZ);
  weapon.updateMatrixWorld(true);

  // 5. Stash barrel tip Z (post-translation) for muzzle placement.
  const barrelLen = postMaxZ - postMinZ;
  weapon.userData.barrelTipZ = barrelLen;

  // Re-attach to the saved parent (weaponAttach) with the transform
  // we just computed still intact.
  if (savedParent) savedParent.add(weapon);

  // eslint-disable-next-line no-console
  console.info('[CharacterAvatar] weapon oriented:', {
    barrelAxis: axis + (sign > 0 ? '+' : '-'),
    bbox: [preSize.x.toFixed(3), preSize.y.toFixed(3), preSize.z.toFixed(3)],
    barrelLen: barrelLen.toFixed(3),
  });
}

/**
 * Read a `rifle_stand_aim_idle`-style clip and extract each bone's
 * rotation at time 0 into a `name -> Quaternion` table. This is what
 * the `airborne + firing` code path lerps upper-body bones toward so
 * the character looks like it's actually holding the rifle in the
 * air instead of flopping its arms per the base `jump_loop` clip.
 *
 * Why only the first frame: aim-idle is a near-static "ready" pose
 * by design (small breathing sway), so frame 0 is already a
 * representative clean aim silhouette. Sampling dynamically every
 * frame would add per-bone track decode cost with negligible visual
 * benefit.
 *
 * We only consume `.quaternion` tracks. Position tracks (usually on
 * the hip/root bone) would fight the jump clip's vertical motion;
 * scale tracks are vanishingly rare on humanoid rigs and would break
 * the skin deformation if applied. Both are skipped silently.
 */
function sampleAimPose(clip: THREE.AnimationClip): Map<string, THREE.Quaternion> {
  const out = new Map<string, THREE.Quaternion>();
  for (const track of clip.tracks) {
    const name = track.name;
    // Track names come through as "<BoneName>.quaternion" or
    // "<BoneName>.position" etc. Split on the last dot to isolate
    // the property.
    const dot = name.lastIndexOf('.');
    if (dot < 0) continue;
    const boneName = name.slice(0, dot);
    const prop = name.slice(dot + 1);
    if (prop !== 'quaternion') continue;
    const vals = track.values as Float32Array | number[];
    if (vals.length < 4) continue;
    out.set(
      boneName,
      new THREE.Quaternion(vals[0], vals[1], vals[2], vals[3]).normalize(),
    );
  }
  return out;
}

/**
 * Enumerate every bone whose name matches an "upper body" hint.
 * Used by the airborne-aim step to know which bones to slerp toward
 * the aim pose. Deliberately generous — hands, fingers, neck, and
 * head all come along — because the aim-idle clip animates all of
 * them and we want a coherent silhouette, not half a rifle grip.
 *
 * Leg / pelvis / toe bones are explicitly excluded: the jump clip
 * drives those (knee flex, foot dangle), and overwriting them would
 * kill the jump silhouette entirely.
 */
const UPPER_BODY_BONE_RE =
  /(chest|spine|clavicle|shoulder|upperarm|forearm|elbow|wrist|hand|finger|thumb|index|middle|ring|pinky|pinkie|neck|head|bip01\s*spine|bip01\s*r\s*clavicle|bip01\s*l\s*clavicle)/i;
const LOWER_BODY_BONE_RE =
  /(thigh|upperleg|knee|shin|calf|foot|toe|pelvis|hip|bip01\s*l\s*thigh|bip01\s*r\s*thigh)/i;

function collectUpperBodyBones(group: THREE.Object3D): THREE.Bone[] {
  const out: THREE.Bone[] = [];
  group.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    const n = obj.name || '';
    // Explicit lower-body reject wins: "lowerSpine" would otherwise
    // match the upper regex via "spine" and get slurped into the
    // aim pose.
    if (LOWER_BODY_BONE_RE.test(n)) return;
    if (UPPER_BODY_BONE_RE.test(n)) out.push(obj as THREE.Bone);
  });
  return out;
}

/**
 * Scan a weapon FBX hierarchy for a node that represents the barrel
 * tip. DCC artists use a variety of conventions — Aegis most often
 * leaves an empty helper named "muzzle" / "fire_point" / "socket_fire"
 * at the exit of the barrel. If one exists we parent the tracer
 * muzzle Object3D under it so recoil + weapon sway automatically
 * transform the firing origin. `null` ⇒ caller falls back to the
 * WEAPON_MUZZLE_OFFSET constant.
 *
 * The matcher is deliberately generous (case-insensitive + substring)
 * because artists use a lot of cousin names; false positives have no
 * gameplay cost (a tracer origin 5 cm off is imperceptible).
 */
function findWeaponMuzzleNode(weapon: THREE.Object3D): THREE.Object3D | null {
  let best: THREE.Object3D | null = null;
  const patterns = [
    /^muzzle/,
    /muzzle_?(?:flash|point|socket)/,
    /fire_?point/,
    /socket_?(?:fire|muzzle)/,
    /barrel_?end/,
    /gun_?muzzle/,
    /weapon_?muzzle/,
  ];
  weapon.traverse((obj) => {
    if (best) return;
    const n = (obj.name || '').toLowerCase();
    if (!n) return;
    for (const re of patterns) {
      if (re.test(n)) {
        best = obj;
        return;
      }
    }
  });
  if (best) {
    // eslint-disable-next-line no-console
    console.info('[CharacterAvatar] using FBX muzzle node:', (best as THREE.Object3D).name);
  }
  return best;
}

/**
 * Traverse the character skeleton and identify the bones the recoil
 * layer can write to. Aegis rigs use plain "RightHand" / "RightArm"
 * / "Spine2" names; 3ds Max Biped rigs use "Bip01 R Hand" etc. We
 * accept either — a fuzzy `includes()` match against a lowercased
 * name is plenty given we own the asset pipeline and there's no risk
 * of colliding bone names inside one FBX.
 *
 * Missing bones return `null` — the recoil step degrades gracefully,
 * it just doesn't contribute that particular motion track.
 */
function findRecoilBones(group: THREE.Object3D): {
  chest: THREE.Bone | null;
  rightArm: THREE.Bone | null;
  rightHand: THREE.Bone | null;
} {
  let chest: THREE.Bone | null = null;
  let rightArm: THREE.Bone | null = null;
  let rightHand: THREE.Bone | null = null;

  const collected: string[] = [];
  group.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    const name = (obj.name || '').toLowerCase();
    if (collected.length < 200) collected.push(obj.name || '<anon>');
    // Prefer the specific match first so we don't overwrite a good
    // hit with a looser one later (e.g. "righthand" beats "hand").
    if (!rightHand && /(right.?hand|r.?hand|bip01\s*r\s*hand|hand_?r)\b/.test(name)) {
      rightHand = obj as THREE.Bone;
    }
    if (!rightArm && /(right.?arm|r.?arm|bip01\s*r\s*upperarm|upperarm_?r|shoulder_?r)\b/.test(name)) {
      rightArm = obj as THREE.Bone;
    }
    // Avoid matching "Spine" root as chest; prefer the highest Spine
    // (Spine2 / Chest / UpperChest) so torso kick concentrates near
    // the shoulders rather than the hips.
    if (/(chest|upperchest|spine\s*2|spine_?2|bip01\s*spine2)\b/.test(name)) {
      chest = obj as THREE.Bone;
    } else if (!chest && /(spine\s*1|spine_?1|bip01\s*spine1)\b/.test(name)) {
      chest = obj as THREE.Bone;
    }
  });

  // eslint-disable-next-line no-console
  console.info('[CharacterAvatar] bones found:', {
    chest: (chest as THREE.Bone | null)?.name ?? null,
    rightArm: (rightArm as THREE.Bone | null)?.name ?? null,
    rightHand: (rightHand as THREE.Bone | null)?.name ?? null,
    sampleBoneNames: collected.slice(0, 30),
  });
  return { chest, rightArm, rightHand };
}
