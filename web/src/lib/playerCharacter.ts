import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

import { apiUrl, type MaterialJson } from './api';
import { buildMaterial } from './sceneToR3F';

/**
 * Loader + cache for the Play-mode player avatar — right now the
 * `striker_low` humanoid from Project Aegis (Unity), plus a handful of
 * animation FBX clips that drive the idle / run / jump states.
 *
 * Why a hand-rolled loader instead of the existing `fbxCache`:
 * - `fbxCache` is aggressively tuned for *static* scene geometry. It
 *   rips materials, strips the FBX hierarchy, bakes per-node transforms
 *   into vertex buffers, and dedupes by GUID into plain
 *   `BufferGeometry` records. All of that is exactly wrong for a
 *   SkinnedMesh: we MUST keep the SkinnedMesh object, its `skeleton`
 *   bone graph, and the `bindMatrix` alive so `AnimationMixer` can drive
 *   them each frame.
 * - Animation FBX files aren't "meshes" at all — they're skeleton +
 *   `AnimationClip` payloads. We load each one just to yank
 *   `group.animations[0]` out, then let the rest garbage-collect.
 *
 * Unity Humanoid rig caveat: clips authored against Unity's Human
 * avatar are retargeted at runtime via that avatar, not by raw bone
 * name. Three.js has no Humanoid retargeting, but because all the
 * Aegis character FBX files and animation FBX files are exported from
 * the SAME underlying rig (matching `Bip01 *` / `bip_*` bone names),
 * an `AnimationMixer` bound to the character's skeleton happily
 * consumes the clip tracks as-is.
 */

// ---------------------------------------------------------------------
// GUIDs — grabbed from the `.meta` sidecars once; these never change
// for the lifetime of the Unity asset. Kept in this module so the rest
// of the codebase (and the SNS layer later) can reference semantic
// names instead of 32-char hex strings.
// ---------------------------------------------------------------------

/** `Player_g_1/striker_low/mesh/striker_low.fbx` — the character's
 *  skinned mesh + skeleton. The sibling `.prefab` just adds Magica
 *  Cloth colliders we can't simulate here anyway. */
export const PLAYER_CHARACTER_FBX_GUID = '9b49e922223ddbb4191985ea1b9df8ff';

/** `DevAssets(not packed)/_3DModel/striker/striker_weapon_001.fbx` —
 *  the default rifle (AR "스위프트"/striker main weapon) we parent to
 *  the character's right hand. Loaded as a standalone rigid group,
 *  NOT a skinned mesh — Aegis handles weapons via prop attachment in
 *  Unity, not vertex weights. */
export const PLAYER_WEAPON_FBX_GUID = 'c392d081eb00fc64b91518acdc3b53d7';

/** Animation clip GUIDs. Labels match the keys of `PlayerCharacterPack.clips`
 *  so the state machine in `CharacterAvatar` can look clips up by
 *  semantic name. */
// Forward run has TWO variants keyed on whether the player is
// currently firing (i.e. trigger held + shots being spawned):
//
//   runF    — `rifle_stand_run_f`: un-aimed full-speed sprint. Arms
//             swing natural-cycle, weapon is low-ready. This is what
//             plays on a normal traversal and sells the 4.5 m/s move
//             speed (user: "뛰는게 run 이 아닌거같은데" — they disliked
//             the aim-run shuffle as the default).
//   runFAim — `rifle_stand_aim_run_f`: aim-run. Upper body holds the
//             weapon forward in a firing pose while the legs continue
//             the run cycle. Plays while the user is firing AND
//             sprinting forward (user: "뛰면서 쏠때 사격모션해줘야지")
//             — the procedural recoil rides on top of THIS clip, not
//             the un-aimed sprint, so the gun is actually pointed
//             down the aim line when it kicks.
//
// L/B/R only have an aim-run variant in the Aegis library, which is
// fine: strafing/backpedalling is inherently a combat movement in a
// shooter, and non-aim clips don't exist for these directions anyway.
// Firing while strafing therefore reuses the same run clip — the
// procedural recoil on top is what sells "firing" for those cases.
export const PLAYER_ANIM_GUIDS = {
  idle: 'a890c2483d4cb0943a72cf663370b1fb',      // rifle_stand_aim_idle
  runF: '96a7ca11a3b7aac47a6905a6175d373e',      // rifle_stand_run_f (un-aimed sprint)
  runFAim: 'eb4ca948711fe0943aa7f94d34bfcd10',   // rifle_stand_aim_run_f (firing forward)
  runB: '204a80b70b90b8d4294a885dd7f6ebca',      // rifle_stand_aim_run_b
  runL: '648c4e3e19e6fce4c8d1aabd91f7205c',      // rifle_stand_aim_run_l
  runR: 'd11afb85d6bc053418016f9081879065',      // rifle_stand_aim_run_r
  jumpStart: '9fbad436d143fca478fa8ea42ed129ba', // jump_start
  jumpLoop: '02e4dab38a9dbb5479f83aa3cc4198fe',  // jump_loop
  jumpEnd: 'f99d7b1af56db6b40a85bc0228a06d67',   // jump_end

  // --- Crouch stance --------------------------------------------
  // Same aim / un-aim naming pattern as standing. Forward has both
  // variants (walking forward at low ready vs actively firing);
  // B/L/R only have the aim-walk strafes in the Aegis library — we
  // reuse those for both firing and non-firing (procedural recoil
  // sells the firing state regardless).
  crouchIdle: '79fe1cfd902bc0642ac75e3ca0665d87',      // rifle_crouch_aim_idle
  crouchWalkF: 'f22fbbf1830463347b0aa538a70101da',     // rifle_crouch_walk_f (un-aim)
  crouchWalkFAim: 'fbd1de97965faa84ba111590fcd1b052',  // rifle_crouch_aim_walk_f (firing)
  crouchWalkB: 'e3538b7c419f7344d9cf01ee5e33808c',     // rifle_crouch_aim_walk_b
  crouchWalkL: 'ffc1643e7a36158438cca6614f371330',     // rifle_crouch_aim_walk_l
  crouchWalkR: 'bf2bbf7db58eaac4faa3df26ae725e90',     // rifle_crouch_aim_walk_r
} as const;

export type PlayerAnimKey = keyof typeof PLAYER_ANIM_GUIDS;

export interface PlayerCharacterPack {
  /** FBX root group ready to `<primitive object={...} />` directly
   *  under the player's world-space anchor. Already scaled to metres
   *  via `unitScaleFactor / 100` so a 180 cm humanoid renders ~1.8 m
   *  tall, matching the shoulder-camera offsets. */
  group: THREE.Group;
  /** All animation clips keyed by semantic name. Each clip is already
   *  renamed to its key so debug HUDs can show "idle" / "runF" /
   *  "jumpLoop" rather than the Unity FBX's generic "Take 001". Clips
   *  a given FBX file doesn't contain come through as `undefined` so
   *  callers can feature-detect without crashing. */
  clips: Partial<Record<PlayerAnimKey, THREE.AnimationClip>>;
  /** Default rifle mesh, pre-scaled to metres. Caller is responsible
   *  for parenting it under the right-hand bone with a rig-specific
   *  grip offset (see `CharacterAvatar.tsx`). `null` when the weapon
   *  load failed — the character still renders, just without a gun
   *  (the procedural recoil and tracers still fire, so gameplay is
   *  not blocked on weapon asset availability). */
  weapon: THREE.Group | null;
}

// ---------------------------------------------------------------------
// Low-level FBX fetch
// ---------------------------------------------------------------------

/** Singleton to parse FBX binaries — the loader itself is stateless, but
 *  instantiating it isn't free (registers built-in NURBS subloaders etc).
 *  One per tab is plenty. */
const fbxLoader = new FBXLoader();

/**
 * Fetch + parse an FBX asset by its Unity GUID. Server route already
 * handles Git LFS pointers and 404s by returning non-200, which we
 * re-throw so the caller's `loadPlayerCharacter()` promise rejects with
 * an actionable error instead of producing a silent empty scene.
 */
async function fetchFbxGroup(guid: string): Promise<THREE.Group> {
  const url = apiUrl(`/api/assets/mesh?guid=${encodeURIComponent(guid)}`);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`fetch FBX ${guid} failed: ${res.status} ${res.statusText} ${body}`);
  }
  const buf = await res.arrayBuffer();
  // `parse` takes the raw buffer + a base path for external texture
  // resolution. We don't need textures from the FBX itself (Unity
  // manages materials separately, and a blank capsule colour is fine
  // for M1), so an empty base path is safe — the loader just skips
  // missing images.
  return fbxLoader.parse(buf, '') as unknown as THREE.Group;
}

/** Unity FBX exporter stashes the file's `UnitScaleFactor` on the
 *  root group's `userData`. Three.js's FBXLoader does NOT apply this
 *  to the scene, which is why 3dsMax/Maya centimetre-native exports
 *  load 100× too big by default. We replicate `fbxCache.ts`'s policy
 *  here: `scale = unitScaleFactor / 100` (cm export → 0.01, m export
 *  → 1.0). */
/**
 * Fetch the `name → MaterialJson` remap for a character FBX. Returns
 * an empty map if the server doesn't know about the FBX or the FBX
 * has no `externalObjects` remap in its `.meta` (= it's using its
 * own embedded materials straight from the DCC). Never throws —
 * missing materials are a visual-quality issue, not a fatal one.
 */
async function fetchCharacterMaterials(
  guid: string,
): Promise<Record<string, MaterialJson>> {
  try {
    const res = await fetch(
      apiUrl(`/api/assets/fbx-character-materials?guid=${encodeURIComponent(guid)}`),
    );
    if (!res.ok) return {};
    const body = (await res.json()) as { materials?: Record<string, MaterialJson> };
    return body.materials ?? {};
  } catch {
    return {};
  }
}

/**
 * Walk a freshly-loaded FBX group and swap every submesh material
 * whose `.name` matches an entry in `matMap` for a real
 * three.js material built from Unity's `.mat` YAML. Materials the
 * map doesn't cover are left as the FBX's own embedded material so
 * the mesh still renders *something* (usually a plain grey lambert
 * from FBXLoader's default).
 *
 * FBXLoader delivers per-submesh materials as either a single
 * `THREE.Material` (if the mesh has only one group) or a
 * `THREE.Material[]` (one entry per `THREE.BufferGeometry.groups[i]`).
 * We handle both shapes uniformly. We also dedupe rebuilt materials
 * per entry-name so two meshes sharing `m_striker.001` end up with
 * the same `MeshStandardMaterial` instance — keeps the texture
 * upload count sane.
 */
function applyCharacterMaterials(
  root: THREE.Object3D,
  matMap: Record<string, MaterialJson>,
): void {
  if (Object.keys(matMap).length === 0) return;
  const built = new Map<string, THREE.Material>();
  const getOrBuild = (name: string): THREE.Material | null => {
    const cached = built.get(name);
    if (cached) return cached;
    const src = matMap[name];
    if (!src) return null;
    // FBX humanoid characters are almost always single-sided
    // (backface culled), double-sidedness comes from the `.mat`
    // itself. Pass `false` for `doubleSidedHint`.
    const m = buildMaterial(src, false);
    // Skinned materials MUST have `skinning` flagged or three.js
    // uploads the rest-pose vertex positions and animations won't
    // visibly deform the mesh. three.js r150+ sets this via the
    // object's `isSkinnedMesh` flag at program-compile time, so
    // we don't need to touch it explicitly — but we DO need to
    // re-enable `vertexColors = false` because `buildMaterial`
    // inherits it from the MeshStandardMaterial defaults, which
    // is already fine.
    built.set(name, m);
    return m;
  };

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const cur = mesh.material;
    if (Array.isArray(cur)) {
      const next = cur.map((m) => getOrBuild(m.name) ?? m);
      mesh.material = next;
    } else if (cur) {
      const replaced = getOrBuild(cur.name);
      if (replaced) mesh.material = replaced;
    }
  });
}

/**
 * Load the rifle FBX + its Unity material remap, apply materials,
 * apply the FBX's `unitScaleFactor` (same convention as the
 * character). Returned group is a rigid mesh — no skeleton, no
 * animation — ready to `Object3D.add()` under a bone.
 *
 * Kept as its own routine (rather than fused into
 * `loadPlayerCharacter`) so a future "weapon swap" feature can
 * load alternate rifles (SMG / sniper / pistol) through the same
 * code path by taking the GUID as a parameter.
 */
async function loadWeaponGroup(): Promise<THREE.Group> {
  const [group, matMap] = await Promise.all([
    fetchFbxGroup(PLAYER_WEAPON_FBX_GUID).then((g) => {
      applyUnitScale(g);
      return g;
    }),
    fetchCharacterMaterials(PLAYER_WEAPON_FBX_GUID),
  ]);
  applyCharacterMaterials(group, matMap);
  return group;
}

function applyUnitScale(group: THREE.Group): void {
  const uf =
    typeof group.userData.unitScaleFactor === 'number' && group.userData.unitScaleFactor > 0
      ? group.userData.unitScaleFactor
      : 1;
  const s = uf / 100;
  group.scale.setScalar(s);
  group.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

let cached: Promise<PlayerCharacterPack> | null = null;

/**
 * Load (or return the cached) player character + all its animation
 * clips. Results are cached for the lifetime of the tab so re-entering
 * Play mode is instant.
 *
 * Failures are NOT cached: if the initial load fails (LFS pointer,
 * asset-index still warming up), a subsequent call retries. The
 * `PlayerController` surfaces the rejection by rendering its fallback
 * capsule and logging to the console.
 */
export function loadPlayerCharacter(): Promise<PlayerCharacterPack> {
  if (cached) return cached;
  const p = (async (): Promise<PlayerCharacterPack> => {
    // Kick the FBX fetch + the external-materials remap fetch in
    // parallel. The material endpoint is cheap (reads the FBX's
    // `.meta` sidecar + a handful of `.mat` YAMLs) so it almost
    // always completes first; awaiting them together avoids
    // sequential RTT.
    // Character + weapon + their material remaps all fire in
    // parallel. The weapon is non-critical: if either the FBX or
    // the material lookup fails, we log and keep a `null` weapon —
    // the character still renders, just without a gun prop. All
    // character-side failures still throw so the caller's UI can
    // show the error fallback capsule.
    const [charGroup, matMap, weaponResult] = await Promise.all([
      fetchFbxGroup(PLAYER_CHARACTER_FBX_GUID).then((g) => {
        applyUnitScale(g);
        return g;
      }),
      fetchCharacterMaterials(PLAYER_CHARACTER_FBX_GUID),
      loadWeaponGroup().catch((err): null => {
        // eslint-disable-next-line no-console
        console.warn('[playerCharacter] weapon load failed, continuing without gun:', err);
        return null;
      }),
    ]);
    applyCharacterMaterials(charGroup, matMap);

    const animEntries = await Promise.all(
      (Object.keys(PLAYER_ANIM_GUIDS) as PlayerAnimKey[]).map(async (key) => {
        try {
          const g = await fetchFbxGroup(PLAYER_ANIM_GUIDS[key]);
          const clip = g.animations[0];
          if (!clip) {
            // eslint-disable-next-line no-console
            console.warn(`[playerCharacter] ${key}: FBX has no animation clip`);
            return [key, undefined] as const;
          }
          clip.name = key;
          return [key, clip] as const;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[playerCharacter] ${key}: load failed`, err);
          return [key, undefined] as const;
        }
      }),
    );
    const clips: PlayerCharacterPack['clips'] = {};
    for (const [k, c] of animEntries) clips[k] = c;

    return { group: charGroup, clips, weapon: weaponResult };
  })();
  // Rethrow on consumer side but clear cache so a retry can recover.
  p.catch(() => {
    cached = null;
  });
  cached = p;
  return p;
}
