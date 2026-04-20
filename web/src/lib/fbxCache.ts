import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

/**
 * Client-side cache for FBX assets.
 *
 * Unity scenes reference thousands of mesh-filter instances, but most scenes
 * only touch a few dozen unique FBX files. We fetch + parse each FBX at most
 * once per session, then vend BufferGeometries out of a name→geometry map.
 *
 * Design notes:
 * - Entries are keyed by the Unity asset GUID (lowercased).
 * - The cache stores the Promise so parallel callers dedupe naturally.
 * - On failure (404, LFS pointer, parse error) we cache `null` so we don't
 *   retry the same broken asset hundreds of times per scene.
 * - Geometries vended from here are NOT cloned. Callers share the same
 *   BufferGeometry across all instances (Three.js happily renders this).
 * - After parsing we strip materials / textures / nodes we don't need and
 *   drop the FBX scene graph, keeping only the BufferGeometries. This
 *   dramatically reduces GPU memory pressure for scenes with many FBX
 *   meshes — an important factor in avoiding WebGL context-loss on GPUs
 *   with tight per-tab resource budgets.
 */

export type FbxStatus = 'pending' | 'ready' | 'missing' | 'lfs-pointer' | 'error';

/**
 * Geometry + its FBX-embedded material NAME table, in submesh-index order.
 *
 * Unity's FBX importer lets users remap each embedded material (by name) to
 * an external `.mat`. A scene / prefab that leaves `m_Materials` empty relies
 * on Unity doing this name-based substitution at edit time. The `.meta`
 * carries the name→GUID table, but to bind the correct external `.mat` to
 * each submesh group we also need to know the material NAME for each
 * submesh index — and that only lives inside the FBX binary.
 *
 * FBXLoader gives us this for free: the parsed Mesh exposes a `material`
 * array whose order matches `geometry.groups[i].materialIndex`. We snapshot
 * the names before disposing the embedded material objects.
 */
export interface FbxMeshRecord {
  geometry: THREE.BufferGeometry;
  /** Names of the embedded FBX materials, in the same index order the
   *  mesh's `geometry.groups` reference via `materialIndex`. Length 1 for
   *  single-material meshes. Names like "Material #27", "brick", etc. */
  materialNames: string[];
  /** The quaternion we baked into the vertices (rotation-only portion of
   *  this mesh's FBX-hierarchy `matrixWorld`). For a 3ds Max export this
   *  is typically the `-90° X` PreRotation that converts Z-up modelling
   *  space into Y-up world space; for Y-up Maya exports it's identity.
   *
   *  The renderer needs this when the scene's rotation is authoritative
   *  (`hasRotationOverride: true` on the GameObject's transform): Unity
   *  doesn't bake the PreRotation into its own mesh vertices, so its
   *  stored scene quaternion already includes that rotation. If we
   *  applied our baked geometry under the same quaternion verbatim, we'd
   *  double-apply the PreRotation — the sky dome would tip onto its
   *  side. Applying `inverse(bakedRotation)` between the group and the
   *  mesh cancels the bake for exactly those nodes.
   *
   *  When the scene lets the prefab default through (`hasRotationOverride:
   *  false`), we DON'T cancel the bake — the bake itself stands in for
   *  Unity's prefab-root PreRotation in that case. */
  bakedRotation: [number, number, number, number];
  /** True when `bakedRotation` is meaningfully non-identity (so the
   *  renderer can skip the inverse-rotation wrapper group entirely for
   *  the common case). */
  hasBakedRotation: boolean;
  /** Name of the FBX Object3D this geometry came from. Used by the
   *  multi-mesh rendering path to label children and as a fallback when
   *  two records share a BufferGeometry (shared-geometry meshes). */
  meshName: string;
  /** Translation component of this mesh node's FBX-hierarchy `matrixWorld`,
   *  expressed in FBX file units (NOT yet scaled to metres — the renderer
   *  applies `unitScale` at the group level so these numbers multiply
   *  correctly).
   *
   *  Required for the "render all meshes" path used by model-prefab
   *  PrefabInstances (scenes that drag an FBX in directly). Unity expands
   *  the FBX into one GameObject per node, each carrying that node's
   *  local transform; we have to reproduce that placement client-side
   *  because the server has no FBX parser of its own. Without this, every
   *  sub-mesh would pile up at the prefab origin and levels authored as
   *  a single `.fbx` (e.g. Mirama Factory's `F_Sample.fbx`) would render
   *  as a jumbled heap. */
  localPosition: [number, number, number];
  /** Scale component of this mesh node's FBX-hierarchy `matrixWorld`.
   *  Typically `(1,1,1)` for untouched DCC exports but non-trivial when
   *  the modeller used non-uniform node-level scales. Dimensionless — the
   *  outer FBX unit conversion is applied separately by the renderer. */
  localScale: [number, number, number];
}

export interface FbxEntry {
  /** All mesh geometries + material-name tables found in the FBX,
   *  keyed by Object3D.name. */
  geometryByName: Map<string, FbxMeshRecord>;
  /** Secondary index keyed by a *normalised* name where every `.`, `:`, `/`,
   *  `[`, `]` has been replaced with `_`. three.js FBXLoader runs model
   *  names through `PropertyBinding.sanitizeNodeName`, which collapses all
   *  of those characters to underscores before setting `Object3D.name`. That
   *  means a mesh authored in 3ds Max / Blender as `SM_WallParts_E.001`
   *  comes back out as `SM_WallParts_E_001` on the three.js side — so a
   *  scene GameObject literally named `SM_WallParts_E.001_003` (Unity
   *  happily preserves the dot) would never hit the primary map even
   *  though the right sub-mesh exists. We build a second map of the
   *  normalised spellings so the resolver can try both forms and the
   *  fuzzy matcher can compare apples to apples. */
  geometryByNormalizedName: Map<string, FbxMeshRecord>;
  /** The first mesh record we encountered while traversing, used as a
   *  fallback when `submeshName` isn't provided or doesn't match anything. */
  first: FbxMeshRecord | null;
  /** Every mesh record in FBX traversal order, including duplicates with
   *  the same Object3D.name (which `geometryByName` would collapse). Used
   *  by the multi-mesh rendering path for model-prefab PrefabInstances,
   *  where the scene references an FBX as a whole and the viewer has to
   *  instantiate every sub-mesh at its own FBX-local transform. For
   *  ordinary single-submesh props this list has length 1. */
  allMeshes: FbxMeshRecord[];
  /** Scale factor the FBXLoader applied to the root Group based on the
   *  FBX file's `UnitScaleFactor`. We lose this when we extract just the
   *  BufferGeometry, so we store it here and the renderer re-applies it as
   *  a mesh scale. For a cm-native Maya/3dsMax export (UnitScale=100) this
   *  is 0.01; for a meter-native FBX it's 1. Unity's importer normalises
   *  both via `useFileScale=true`, so the Unity scene transforms assume
   *  metres either way — we have to reproduce the conversion here. */
  unitScale: number;
  status: FbxStatus;
  reason?: string;
}

const cache = new Map<string, Promise<FbxEntry>>();

// ---------------------------------------------------------------- Cache stats ----
//
// Observable aggregate counters so the HUD can show "how many FBX assets have
// actually resolved" vs. just "how many mesh?guid= requests fired". Lets the
// viewer distinguish between a healthy pipeline and silent failures without
// having to inspect network tab + console every time.

export interface FbxCacheStats {
  /** Unique GUIDs we've kicked off a fetch for (total queued/completed). */
  requested: number;
  /** Still fetching or parsing. */
  pending: number;
  /** Parsed successfully — geometries are available to the renderer. */
  ready: number;
  /** Final terminal failures (missing asset, HTTP error, LFS pointer, parse exception). */
  failed: number;
}

let _stats: FbxCacheStats = { requested: 0, pending: 0, ready: 0, failed: 0 };
const statsListeners = new Set<(s: FbxCacheStats) => void>();

function publishStats(): void {
  // Freeze snapshot per call so subscribers see a stable object. Cheap —
  // this runs O(distinct FBXs), not per frame.
  const snapshot = { ..._stats };
  for (const fn of statsListeners) fn(snapshot);
}

export function getFbxCacheStats(): FbxCacheStats {
  return { ..._stats };
}

/** Subscribe to live cache-stat updates. Returns an unsubscribe fn. Safe to
 *  call from React via `useEffect`. Fires immediately with the current
 *  snapshot so initial render already has numbers. */
export function subscribeFbxCacheStats(fn: (s: FbxCacheStats) => void): () => void {
  statsListeners.add(fn);
  fn({ ..._stats });
  return () => {
    statsListeners.delete(fn);
  };
}

/**
 * Minimal stub that stands in for the TGA / texture loaders FBXLoader looks
 * up via `manager.getHandler(ext)`. FBXLoader doesn't just call `.load()` —
 * it also invokes `setPath()`, `setCrossOrigin()`, etc. on whatever loader
 * it gets back (three r161 does `loader.setPath(resourceDirectory).load(...)`
 * when parsing embedded textures). If those methods are missing, parsing
 * throws `TypeError: loader.setPath is not a function` and the entire FBX
 * fails to yield geometry, even though we don't care about the texture.
 *
 * Extending `THREE.Loader` gives us `setPath`/`setResourcePath`/`setCrossOrigin`
 * /`setWithCredentials` / `manager` field / etc. for free. We only override
 * `load()` to return an empty placeholder texture synchronously so the FBX
 * parse continues without network traffic — all real textures come from
 * Unity's `.mat` graph via our own GUID-keyed endpoint.
 */
class NullTextureLoader extends THREE.Loader {
  load(
    _url: string,
    onLoad?: (t: THREE.Texture) => void,
    _onProgress?: (e: ProgressEvent) => void,
    _onError?: (e: unknown) => void,
  ): THREE.Texture {
    const tex = new THREE.Texture();
    if (onLoad) Promise.resolve().then(() => onLoad(tex));
    return tex;
  }
}

const manager = new THREE.LoadingManager();
// Intercept every embedded-texture extension FBXLoader might see so we never
// hit the network for sibling image files. Unity's `.mat` is our sole source
// of truth for textures; anything FBXLoader would try to fetch here is either
// a stale 3ds Max reference or a sibling file that wouldn't resolve at our
// resource-less parse anyway. Use a single catch-all regex to avoid having
// to enumerate every format.
const nullTextureLoader = new NullTextureLoader();
manager.addHandler(/\.(tga|png|jpe?g|bmp|tif{1,2}|gif|webp|psd|hdr|exr)$/i, nullTextureLoader);

const loader = new FBXLoader(manager);

/**
 * Dispose everything in an FBX scene graph that isn't the BufferGeometries we
 * keep. FBXLoader attaches textures + materials even when we've told it we
 * don't care; holding onto them long-term costs texture memory on the GPU.
 */
function disposeUnusedFbxResources(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const material = mesh.material;
    if (material) {
      const mats = Array.isArray(material) ? material : [material];
      for (const mat of mats) {
        // Dispose any Texture-valued property the material holds.
        for (const key of Object.keys(mat)) {
          const v = (mat as unknown as Record<string, unknown>)[key];
          if (v instanceof THREE.Texture) v.dispose();
        }
        mat.dispose();
      }
      // Clear the ref so subsequent GC passes can free the Material object.
      // Type-cast because `.material` is non-nullable in three's typings.
      (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material = undefined;
    }
  });
}

async function fetchAndParse(guid: string): Promise<FbxEntry> {
  // Mark as pending before we touch the network so the HUD counter jumps
  // immediately when a scene starts loading (otherwise the first few dozen
  // fetches would appear invisible until their first response came back).
  _stats = { ..._stats, requested: _stats.requested + 1, pending: _stats.pending + 1 };
  publishStats();

  const settle = (entry: FbxEntry): FbxEntry => {
    const isReady = entry.status === 'ready';
    _stats = {
      ..._stats,
      pending: Math.max(0, _stats.pending - 1),
      ready: _stats.ready + (isReady ? 1 : 0),
      failed: _stats.failed + (isReady ? 0 : 1),
    };
    publishStats();
    return entry;
  };

  const url = `/api/assets/mesh?guid=${encodeURIComponent(guid)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return settle(empty('error', (err as Error).message));
  }

  if (res.status === 409) {
    // Server told us this asset is an unresolved Git LFS pointer.
    return settle(empty('lfs-pointer', 'LFS fetch not enabled'));
  }
  if (!res.ok) {
    return settle(empty('missing', `HTTP ${res.status}`));
  }

  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (err) {
    return settle(empty('error', (err as Error).message));
  }

  let root: THREE.Group;
  try {
    // FBXLoader.parse wants (data, resourceDirectory). We pass empty dir
    // because we intentionally don't want it to chase sibling .tga/.png
    // files over the network — all real textures come from Unity's material
    // graph and are already loaded by RendererProxy.
    //
    // FBXLoader is noisy about 3ds Max / Maya proprietary material params
    // (`3dsMax|Parameters|base_color_map`) and unknown material types; we
    // throw all embedded materials away anyway (Unity's .mat is the source
    // of truth), so these warnings are pure console spam. Silence them for
    // the duration of the parse to keep the browser devtools usable when a
    // scene loads 50+ FBXs.
    root = withSilencedWarnings(() => loader.parse(buf, ''));
  } catch (err) {
    return settle(empty('error', (err as Error).message));
  }

  // FBXLoader does NOT apply the FBX's `UnitScaleFactor` to any transform —
  // it stashes the raw value on `root.userData.unitScaleFactor` and leaves
  // it to the caller to convert. The field encodes "1 FBX unit = X cm", so
  // to get metres we multiply vertices by `unitScaleFactor / 100`:
  //   - `UnitScaleFactor = 1`   → 1 unit = 1 cm (Maya/3dsMax centimetre
  //     mode, very common). Multiplier = 0.01.
  //   - `UnitScaleFactor = 100` → 1 unit = 1 m (FBX authored in metres,
  //     e.g. Unity re-export). Multiplier = 1.
  //   - `UnitScaleFactor = 2.54` → 1 unit = 1 inch. Multiplier = 0.0254.
  // This matches what Unity's importer does with `useFileScale = true`, so
  // Unity scene transforms remain consistent. We store the multiplier (not
  // the raw factor) so the renderer can just read and apply.
  const unitScaleFactor =
    typeof root.userData.unitScaleFactor === 'number' && root.userData.unitScaleFactor > 0
      ? root.userData.unitScaleFactor
      : 1; // default to cm (factor=1) if the FBX didn't expose the field at all
  const rootScale = unitScaleFactor / 100;

  // Extract geometry references + their FBX-embedded material-name tables
  // before we dispose the materials below. `material` is either a single
  // Material object (single-submesh mesh) or an array indexed by the
  // submesh's materialIndex (multi-submesh mesh). We capture the names in
  // that exact order so the renderer can later bind
  // `externalObjects[materialName]` to each submesh group.
  //
  // Bake each mesh's ROTATION-ONLY world transform into its geometry.
  //
  // 3ds Max / Maya FBX exports frequently include a per-node `PreRotation`
  // (and sometimes an intermediate `Null` parent with rotation) to compensate
  // for Z-up → Y-up axis conversion. FBXLoader puts that rotation on the
  // Object3D's `quaternion`, NOT into vertex positions. Unity's
  // `ModelImporter` instead bakes the rotation straight into the mesh
  // vertices so that the resulting GameObject's transform rotation is
  // identity. Scene YAML transforms are authored relative to that baked
  // geometry, so we have to mirror what Unity does — otherwise models
  // authored in Max (antennas, girders, anything with PreRotation) render
  // lying on their side.
  //
  // We deliberately bake ONLY the rotation component of `matrixWorld`:
  //   - Translation stays separate: FBX hierarchies often place nested
  //     meshes at a non-zero offset (e.g. gun barrel at (0, 100, 0) inside
  //     a prefab); Unity captures that with the child GameObject's Transform,
  //     not with vertex offsets. Baking translation would double-apply it
  //     and the model would float in Y.
  //   - Scale stays separate: the FBX `UnitScaleFactor` already feeds the
  //     per-mesh `rootScale` the renderer applies; baking node-level scale
  //     here would double-apply it.
  //
  // `applyMatrix4` on an identity rotation is a no-op, so meshes that
  // FBXLoader already had oriented correctly are unaffected.
  root.updateMatrixWorld(true);
  const geometryByName = new Map<string, FbxMeshRecord>();
  const geometryByNormalizedName = new Map<string, FbxMeshRecord>();
  const allMeshes: FbxMeshRecord[] = [];
  let first: FbxMeshRecord | null = null;
  const bakedGeoms = new WeakSet<THREE.BufferGeometry>();
  const _tmpPos = new THREE.Vector3();
  const _tmpQuat = new THREE.Quaternion();
  const _tmpScl = new THREE.Vector3();
  const _rotOnly = new THREE.Matrix4();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const g = mesh.geometry as THREE.BufferGeometry | undefined;
    const isMeshLike = obj.type === 'Mesh' || obj.type === 'SkinnedMesh';
    if (!isMeshLike || !g) return;

    // Capture matrixWorld rotation BEFORE any mutations so multi-submesh
    // meshes (which share the same BufferGeometry under three's FBXLoader
    // when exported that way) record the same rotation they were baked
    // with the first time round.
    mesh.matrixWorld.decompose(_tmpPos, _tmpQuat, _tmpScl);
    const isIdentityRot = Math.abs(Math.abs(_tmpQuat.w) - 1) < 1e-6;
    const bakedRotation: [number, number, number, number] = [
      _tmpQuat.x,
      _tmpQuat.y,
      _tmpQuat.z,
      _tmpQuat.w,
    ];

    if (!bakedGeoms.has(g)) {
      // A quaternion's w → ±1 means rotation → identity (the remaining
      // x/y/z components are sin(θ/2) and collapse to 0). Skip the bake in
      // that case to avoid any floating-point drift on the vast majority of
      // meshes that don't need it.
      if (!isIdentityRot) {
        _rotOnly.makeRotationFromQuaternion(_tmpQuat);
        g.applyMatrix4(_rotOnly);
        g.computeBoundingBox();
        g.computeBoundingSphere();
      }
      bakedGeoms.add(g);
    }

    const mat = mesh.material;
    const rawMaterialNames: string[] = [];
    if (Array.isArray(mat)) {
      for (const m of mat) rawMaterialNames.push(m?.name ?? '');
    } else if (mat) {
      rawMaterialNames.push(mat.name ?? '');
    }

    // --- Normalize submesh ordering to match Unity's FBX importer --------
    //
    // Three's FBXLoader builds `geometry.groups` in polygon-appearance
    // order — i.e. the first group is the one whose vertices come first in
    // the index buffer. Each group carries a `.materialIndex` that points
    // into `mesh.material[]` (whose order matches the FBX's raw material
    // connection list, typically 0, 1, 2, 3, … of "Material #N" declared
    // under the Mesh node).
    //
    // Unity's FBX importer scans the same polygons but ASSIGNS submesh
    // indices in order of first-appearance of each distinct material
    // index, then populates `m_Materials[submeshIndex]` positionally.
    // That means when the raw FBX material IDs don't appear in their
    // natural 0,1,2,… order in the polygon stream (common for 3ds Max
    // exports like `DM_BLDG_ATeam_A.fbx` where the builder used Editor
    // material slots #500/#503/#4099/#597 assigned in arbitrary order),
    // Unity's submesh N ≠ FBX material index N.
    //
    // The net effect: if we hand Three.js the Unity-authored m_Materials
    // array as-is, Three looks up `sharedMaterials[group.materialIndex]`
    // with `group.materialIndex` still being the FBX raw index, and every
    // submesh renders with the wrong `.mat`. The user discovered this
    // manually with DM_BLDG_ATeam_A where `[1,2,0,3,4,5,6]` fixed the
    // binding.
    //
    // Fix: rewrite each group so `groups[i].materialIndex = i` (Unity's
    // submesh index), and reorder `materialNames` in lockstep so
    // `materialNames[i]` is the FBX-embedded name of submesh `i`. The
    // downstream renderer then just maps `m_Materials[i] → submesh i`
    // positionally, which is exactly what Unity's MeshRenderer does.
    //
    // Same geometry instance can be referenced by multiple mesh nodes in
    // one FBX (shared geometry). We key the "already normalized" marker
    // off the geometry itself so the second mesh picks up the already-
    // remapped groups and rebuilds its own `materialNames` accordingly.
    let materialNames = rawMaterialNames;
    const groups = g.groups;
    if (groups && groups.length > 0 && rawMaterialNames.length > 1) {
      const alreadyNormalized = (g.userData as Record<string, unknown>)
        .__aegisSlotsNormalized === true;
      if (!alreadyNormalized) {
        const remapFbxToUnity: number[] = rawMaterialNames.map(() => -1);
        const unityNames: string[] = [];
        for (let i = 0; i < groups.length; i += 1) {
          const fbxMatIdx = groups[i].materialIndex ?? 0;
          // Assign each distinct FBX material index a sequential Unity
          // submesh slot on first encounter; subsequent groups referencing
          // the same FBX material reuse that slot (rare but legal — a
          // single material split into disjoint polygon runs).
          let unitySlot = remapFbxToUnity[fbxMatIdx];
          if (unitySlot < 0 || unitySlot === undefined) {
            unitySlot = unityNames.length;
            remapFbxToUnity[fbxMatIdx] = unitySlot;
            unityNames.push(rawMaterialNames[fbxMatIdx] ?? '');
          }
          groups[i].materialIndex = unitySlot;
        }
        // Any FBX materials that weren't referenced by any group are
        // appended at the end so the names array stays complete — those
        // trailing names never appear in a draw but downstream diagnostics
        // (and Unity's m_Materials padding logic) still expect them.
        for (let k = 0; k < rawMaterialNames.length; k += 1) {
          if (remapFbxToUnity[k] < 0) unityNames.push(rawMaterialNames[k] ?? '');
        }
        materialNames = unityNames;
        (g.userData as Record<string, unknown>).__aegisSlotsNormalized = true;
        (g.userData as Record<string, unknown>).__aegisUnityMaterialNames = unityNames;
      } else {
        // Geometry already normalized by a sibling mesh that shares it:
        // reuse the canonical Unity-order material names we stashed then.
        const cached = (g.userData as Record<string, unknown>)
          .__aegisUnityMaterialNames as string[] | undefined;
        if (cached && cached.length > 0) materialNames = cached;
      }
    }

    // Snapshot translation + scale the same way we snapshotted rotation.
    // matrixWorld.decompose already ran above (to get _tmpQuat); we reuse
    // _tmpPos / _tmpScl here rather than decomposing a second time.
    //
    // FBXLoader does NOT apply `unitScaleFactor` to any Object3D, so these
    // numbers are in the FBX file's native units (typically centimetres
    // for 3ds Max / Maya cm-mode). The multi-mesh renderer applies the
    // cm→m conversion once at the group level so these values multiply
    // into world space cleanly.
    const localPosition: [number, number, number] = [_tmpPos.x, _tmpPos.y, _tmpPos.z];
    const localScale: [number, number, number] = [_tmpScl.x, _tmpScl.y, _tmpScl.z];

    const record: FbxMeshRecord = {
      geometry: g,
      materialNames,
      bakedRotation,
      hasBakedRotation: !isIdentityRot,
      meshName: obj.name ?? '',
      localPosition,
      localScale,
    };

    if (!first) first = record;
    if (obj.name && !geometryByName.has(obj.name)) {
      geometryByName.set(obj.name, record);
    }
    if (obj.name) {
      const norm = normalizeFbxName(obj.name);
      // Populate the normalised map in full — callers use it as the
      // canonical comparison index, so a missing entry here would make
      // dot-containing query names unresolvable even when the raw FBX
      // spelling and sanitised spelling coincide.
      if (!geometryByNormalizedName.has(norm)) {
        geometryByNormalizedName.set(norm, record);
      }
    }
    // Keep every mesh in FBX-traversal order so `renderAllFbxMeshes` can
    // instantiate duplicates-by-name too. `geometryByName` intentionally
    // collapses them; `allMeshes` keeps them.
    allMeshes.push(record);
  });

  disposeUnusedFbxResources(root);

  // Treat "parsed but yielded zero geometries" as a failure — it's always a
  // silent data problem (non-mesh FBX, bad submesh index) that the HUD
  // should surface.
  if (!first) {
    return settle(empty('error', 'no mesh geometry found in FBX'));
  }

  return settle({
    geometryByName,
    geometryByNormalizedName,
    first,
    allMeshes,
    unitScale: rootScale,
    status: 'ready',
  });
}

/**
 * Reproduce the character set that three.js `FBXLoader` strips when it
 * assigns `Object3D.name` from an FBX model attrName.
 *
 * Empirically — confirmed against a live dump of `F_Sample.fbx` — FBXLoader
 * **deletes** `.` entirely rather than replacing it with `_`. So a mesh
 * authored in the DCC as `SM_WallParts_E.001` comes back out as
 * `SM_WallParts_E001`, and `SM_Bottom_01.001` becomes `SM_Bottom_01001`.
 * This is *not* what `THREE.PropertyBinding.sanitizeNodeName` does (that
 * one replaces with `_`); FBXLoader has its own parser path that simply
 * skips the character.
 *
 * We strip the same characters here so both the FBX's own keys and the
 * scene-side query names end up in the exact same spelling. Getting this
 * wrong was why `.NNN` wall variants kept falling through to the short
 * base mesh (`SM_WallParts_E`) — the normalised query produced `_001`
 * but the normalised FBX key was `001`, so the lookup missed and the
 * longest-prefix scan picked the shorter name.
 */
function normalizeFbxName(name: string): string {
  return name.replace(/[\[\]\.:\/\s]/g, '');
}

/**
 * Runs `fn` with `console.warn` monkey-patched to drop known-benign FBXLoader
 * spam. We match on substrings that FBXLoader 0.161.x uniquely emits for
 * features we don't care about — anything that doesn't look like FBXLoader
 * material/parameter noise is still forwarded to the real console so we
 * don't accidentally hide genuine problems.
 */
function withSilencedWarnings<T>(fn: () => T): T {
  const original = console.warn;
  const isFbxNoise = (msg: unknown): boolean => {
    if (typeof msg !== 'string') return false;
    if (!msg.startsWith('THREE.FBXLoader:')) return false;
    return (
      msg.includes('not supported in three.js, skipping texture') ||
      msg.includes('unknown material type')
    );
  };
  console.warn = (...args: unknown[]) => {
    if (isFbxNoise(args[0])) return;
    original.apply(console, args as []);
  };
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

function empty(status: FbxStatus, reason?: string): FbxEntry {
  return {
    geometryByName: new Map(),
    geometryByNormalizedName: new Map(),
    first: null,
    allMeshes: [],
    unitScale: 1,
    status,
    reason,
  };
}

export function loadFbx(guid: string): Promise<FbxEntry> {
  const key = guid.toLowerCase();
  let existing = cache.get(key);
  if (!existing) {
    existing = fetchAndParse(key);
    cache.set(key, existing);
  }
  return existing;
}

/**
 * Pick a mesh record from an already-parsed FBX entry.
 *
 * Resolution order:
 *   1. `submeshName` — the name Unity stored in the FBX .meta's
 *      `internalIDToNameTable` for the referenced fileID. This is the
 *      authoritative binding when available.
 *   2. `fallbackName` — typically the GameObject's own name. Unity's
 *      default FBX import mode assigns the mesh name to the GameObject
 *      that owns the MeshFilter, so `node.name` is almost always the
 *      right sub-mesh to pick when the .meta lookup failed. This matters
 *      for FBX assets imported with `fileIdsGeneration: 2` (Unity 2022+
 *      "stable hashed IDs"), whose `internalIDToNameTable` is empty —
 *      the fileID is derived from the mesh name via SpookyHashV2 and we
 *      don't reverse that hash server-side.
 *   3. `entry.first` — whatever FBXLoader's traversal yielded first.
 *      Correct for single-mesh FBXs and the only option when neither
 *      of the names above matched anything.
 */
export function findGeometryInFbx(
  entry: FbxEntry,
  submeshName?: string,
  fallbackName?: string,
): FbxMeshRecord | null {
  if (submeshName) {
    const hit = lookupName(entry, submeshName);
    if (hit) return hit;
  }
  if (fallbackName && fallbackName !== submeshName) {
    const hit = lookupName(entry, fallbackName);
    if (hit) return hit;
    const fuzzy = findGeometryByFuzzyName(entry, fallbackName);
    if (fuzzy) return fuzzy;
  }
  return entry.first;
}

/**
 * Single source of truth for "look up a record by whatever name the caller
 * has". Tries the primary map first (FBXs *can* carry a literal `.` in a
 * mesh name when the exporter didn't route through Unity), then falls back
 * to the normalised map so names that got dot-mangled on either side of
 * the three.js sanitiser still match.
 */
function lookupName(entry: FbxEntry, name: string): FbxMeshRecord | null {
  const direct = entry.geometryByName.get(name);
  if (direct) return direct;
  const norm = normalizeFbxName(name);
  if (norm !== name) {
    const normHit = entry.geometryByNormalizedName.get(norm);
    if (normHit) return normHit;
  }
  return null;
}

/**
 * Attempt to resolve a GameObject's name against an FBX's mesh table when the
 * exact name didn't hit.
 *
 * Why we need this:
 *   When a level designer unpacks an FBX prefab in the scene (i.e. the FBX's
 *   per-sub-mesh GameObjects are promoted to native scene objects) and then
 *   duplicates those GameObjects, Unity appends `_NNN` / ` (NN)` suffixes.
 *   For FBXs imported with `fileIdsGeneration: 2` (Unity 2022+ stable hashed
 *   IDs) the .meta's `internalIDToNameTable` is empty, so the server can't
 *   hand us an authoritative `submeshName` and we fall through to the native
 *   GameObject's own name. That name is `SM_WallParts_B_013`, but the FBX
 *   exports the mesh as `SM_WallParts_B`.
 *
 * Strategy (ordered, first match wins):
 *   1. Strip Unity's `_NNN` duplicate suffix.
 *   2. Strip Blender's `.NNN` duplicate suffix.
 *   3. Strip a trailing `_Mirror` / ` (Mirror)` adornment (common when the
 *      designer horizontally mirrored the instance).
 *   4. Apply combinations of the above in turn.
 *   5. As a last resort, longest-prefix match against the FBX's mesh names
 *      so `SM_Factory_EMdoor_A_002` still finds `SM_Factory_EMdoor_A`.
 *
 * We deliberately keep this pure name-munging and resist reverse-engineering
 * Unity's SpookyHashV2-based stable fileID. The fuzzy strategy handles every
 * unpacked scene we've seen in practice and stays readable; if it ever isn't
 * enough we can always follow up with a proper hash-based lookup.
 */
function findGeometryByFuzzyName(
  entry: FbxEntry,
  raw: string,
): FbxMeshRecord | null {
  // Build a candidate set by exhaustively applying every combination of
  // the three strip rules. We can't walk cur→strip→cur iteratively because
  // doing so drops intermediate forms: e.g. `SM_WallParts_E.001_003` →
  // stripUnity → `SM_WallParts_E.001` → stripBlender → `SM_WallParts_E`
  // all in one iteration, so the intermediate `SM_WallParts_E.001` (which
  // is an actual FBX mesh name!) never gets pushed. Applying each rule
  // independently and transitively closes the candidate set.
  const stripUnitySuffix = (s: string) => s.replace(/_\d{1,4}$/u, '');
  const stripBlenderSuffix = (s: string) => s.replace(/\.\d{1,4}$/u, '');
  const stripMirror = (s: string) => s.replace(/(?:_Mirror|\s*\(Mirror\))$/u, '');

  const candidates = new Set<string>();
  const frontier: string[] = [raw];
  while (frontier.length > 0) {
    const cur = frontier.pop() as string;
    if (cur.length === 0 || candidates.has(cur)) continue;
    candidates.add(cur);
    const a = stripUnitySuffix(cur);
    if (a !== cur) frontier.push(a);
    const b = stripBlenderSuffix(cur);
    if (b !== cur) frontier.push(b);
    const c = stripMirror(cur);
    if (c !== cur) frontier.push(c);
  }

  candidates.delete(raw);
  for (const cand of candidates) {
    const hit = lookupName(entry, cand);
    if (hit) return hit;
  }

  // Longest-prefix fallback. Compare against the *normalised* FBX names so
  // a scene GO like `SM_WallParts_E.001_003` can hit the FBX mesh whose
  // three.js-stripped name is `SM_WallParts_E001` (authored as
  // `SM_WallParts_E.001` in the DCC). Without the normalisation both sides
  // collapse to the shortest common base (`SM_WallParts_E`), which is why
  // every `.NNN` wall variant was rendering with the wrong sub-mesh before.
  const rawNorm = normalizeFbxName(raw);
  let best: FbxMeshRecord | null = null;
  let bestLen = 0;
  for (const [name, rec] of entry.geometryByNormalizedName) {
    if (name.length <= bestLen) continue;
    if (!rawNorm.startsWith(name)) continue;
    const next = rawNorm.charAt(name.length);
    if (next !== '' && next !== '_' && next !== '.' && next !== ' ') continue;
    best = rec;
    bestLen = name.length;
  }
  return best;
}

/**
 * Convenience helper combining loadFbx + findGeometryInFbx.
 */
export async function loadFbxGeometry(
  guid: string,
  submeshName?: string,
  fallbackName?: string,
): Promise<{
  geometry: THREE.BufferGeometry | null;
  materialNames: string[];
  unitScale: number;
  /** Quaternion we baked into this geometry (see `FbxMeshRecord.bakedRotation`).
   *  Defaults to identity when the geometry is missing or the FBX's hierarchy
   *  didn't rotate the mesh. The renderer uses it to cancel the bake when the
   *  scene authoritatively sets the node's rotation. */
  bakedRotation: [number, number, number, number];
  hasBakedRotation: boolean;
  /** Which name actually hit inside the FBX — 'submesh' | 'fallback' | 'first'.
   *  Useful for the Inspector so we can surface when the authoritative
   *  lookup failed and we silently picked by GameObject name instead. */
  resolvedBy: 'submesh' | 'fallback' | 'first' | 'none';
  status: FbxStatus;
  reason?: string;
}> {
  const entry = await loadFbx(guid);
  if (entry.status !== 'ready') {
    return {
      geometry: null,
      materialNames: [],
      unitScale: 1,
      bakedRotation: [0, 0, 0, 1],
      hasBakedRotation: false,
      resolvedBy: 'none',
      status: entry.status,
      reason: entry.reason,
    };
  }
  let resolvedBy: 'submesh' | 'fallback' | 'first' | 'none' = 'none';
  let record: FbxMeshRecord | null = null;
  if (submeshName) {
    record = lookupName(entry, submeshName);
    if (record) resolvedBy = 'submesh';
  }
  if (!record && fallbackName && fallbackName !== submeshName) {
    record = lookupName(entry, fallbackName);
    if (record) resolvedBy = 'fallback';
    if (!record) {
      record = findGeometryByFuzzyName(entry, fallbackName);
      if (record) resolvedBy = 'fallback';
    }
  }
  if (!record) {
    record = entry.first;
    if (record) resolvedBy = 'first';
  }
  logFbxResolve(guid, submeshName, fallbackName, resolvedBy, record, entry);
  return {
    geometry: record?.geometry ?? null,
    materialNames: record?.materialNames ?? [],
    unitScale: entry.unitScale,
    bakedRotation: record?.bakedRotation ?? [0, 0, 0, 1],
    hasBakedRotation: record?.hasBakedRotation ?? false,
    resolvedBy,
    status: 'ready',
  };
}

// Guarded diagnostic logger. We only want to see *failures* and distinct
// requests — the scene has hundreds of renderers and logging every one
// floods the console. Dedupe on (guid, submesh, fallback) so identical
// repeats collapse to one line, and always print a one-time dump of the
// available mesh names the first time we touch a given FBX so the user
// can compare what's being asked for against what the FBX actually
// contains.
const _seenResolveKeys = new Set<string>();
const _dumpedGuids = new Set<string>();
function logFbxResolve(
  guid: string,
  submesh: string | undefined,
  fallback: string | undefined,
  resolvedBy: 'submesh' | 'fallback' | 'first' | 'none',
  record: FbxMeshRecord | null,
  entry: FbxEntry,
): void {
  const key = `${guid}|${submesh ?? ''}|${fallback ?? ''}`;
  if (_seenResolveKeys.has(key)) return;
  _seenResolveKeys.add(key);

  if (!_dumpedGuids.has(guid)) {
    _dumpedGuids.add(guid);
    const names = Array.from(entry.geometryByName.keys()).sort();
    const normNames = Array.from(entry.geometryByNormalizedName.keys()).sort();
    console.log(
      `[fbx-cache] guid=${guid.slice(0, 8)} meshNames(${names.length})=`,
      names,
      ` normalized(${normNames.length})=`,
      normNames,
    );
    // Expose to the window so the developer can grep the live map from the
    // DevTools console: `window.__fbxEntries['<guid prefix>']`.
    type W = Window & { __fbxEntries?: Record<string, FbxEntry> };
    const w = window as W;
    w.__fbxEntries = w.__fbxEntries ?? {};
    w.__fbxEntries[guid] = entry;
    w.__fbxEntries[guid.slice(0, 8)] = entry;
  }

  // Only noise for fallback/first resolutions — 'submesh' hits are the
  // happy path and don't need to be logged.
  if (resolvedBy === 'submesh') return;
  console.log(
    `[fbx-resolve] guid=${guid.slice(0, 8)} submesh=${submesh ?? '-'} fallback=${fallback ?? '-'} -> ${resolvedBy} (matched='${record?.meshName ?? ''}')`,
  );
}
