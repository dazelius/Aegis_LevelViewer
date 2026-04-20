import path from 'node:path';
import { assetIndex } from './assetIndex.js';
import { getFbxMeshInfo, resolveFbxMeshName } from './metaParser.js';
import {
  buildGameObjectTree,
  loadDocs,
  type GameObjectNode,
  type TreeStats,
} from './sceneParser.js';

export interface ParsedPrefab {
  guid: string;
  /** Prefab root GameObject. Prefabs are required to have exactly one root, but
   *  some legacy/broken prefabs may expose multiple — we take the first. */
  root: GameObjectNode;
  /** Lookup by transform fileID (in the prefab's own namespace) for use by
   *  PrefabInstance.m_Modifications that target Transforms. */
  byTransformFileID: Map<string, GameObjectNode>;
  byGOFileID: Map<string, GameObjectNode>;
  /** Maps component fileID (MeshFilter/MeshRenderer/…) -> owning GameObject.
   *  Scene-level `m_Mesh` and `m_Materials.Array.data[N]` overrides address
   *  components by fileID, not by GameObject. Without this map those mods
   *  miss and scenes like `Test_0323.unity` never see their ProBuilder
   *  inline meshes swapped in. */
  byComponentFileID: Map<string, GameObjectNode>;
  /**
   * True for prefabs synthesized from imported models (.fbx / .obj). Those
   * have a single synthetic root whose GameObject/Transform fileIDs are
   * internal to the FBX (hashed by Unity) and therefore unreachable via our
   * .prefab/.meta scans. When expanding a model-prefab instance, we fall back
   * to applying transform/material mods directly to the synthetic root so
   * scene-placed FBX props still respect their overrides.
   *
   * Regular .prefab trees DO have every Transform/GO addressable by fileID
   * (or via a nested PrefabInstance expansion). Falling back to the root for
   * unresolved mods there causes catastrophic overwrites — e.g. a mod
   * targeting a nested wall's x offset would clobber the prefab root's own
   * position. So we only enable the root-fallback heuristic for model
   * prefabs.
   */
  isModelPrefab: boolean;
}

const CACHE = new Map<string, ParsedPrefab>();
const INFLIGHT = new Map<string, Promise<ParsedPrefab | undefined>>();

/**
 * Parse a .prefab file into a single-rooted GameObject tree. Results are
 * cached globally by GUID: prefabs are large, frequently reused across
 * scenes, and their parse cost is linear in doc count.
 *
 * Cycle guard: nested prefabs may reference each other (rare but seen on
 * variant chains). We pass `prefabStack` down through `buildGameObjectTree`
 * to refuse reentrance on a GUID already being expanded on the same path.
 */
export async function parsePrefabByGuid(
  guid: string,
  prefabStack: Set<string>,
): Promise<ParsedPrefab | undefined> {
  if (!guid) return undefined;
  const key = guid.toLowerCase();
  if (prefabStack.has(key)) return undefined; // cycle guard

  const cached = CACHE.get(key);
  if (cached) return cached;

  const inflight = INFLIGHT.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<ParsedPrefab | undefined> => {
    const rec = assetIndex.get(key);
    if (!rec) return undefined;

    // Unity treats imported models (.fbx / .obj) as "Model Prefabs":
    // other prefabs / scenes can use them as a PrefabInstance source. We
    // synthesize a minimal single-root tree so those references render with
    // the model's geometry instead of dropping to a placeholder cube.
    if (rec.ext === '.fbx' || rec.ext === '.obj') {
      const synth = await synthesizeModelPrefab(key, rec.absPath, rec.ext);
      if (synth) CACHE.set(key, synth);
      return synth;
    }

    if (rec.ext !== '.prefab') return undefined;

    const childStack = new Set(prefabStack);
    childStack.add(key);

    let docs;
    try {
      docs = await loadDocs(rec.absPath);
    } catch {
      return undefined;
    }

    // Prefabs carry their own stats; we don't want them bleeding into the scene
    // stats until the scene actually instantiates them.
    const localStats: TreeStats = {
      totalGameObjects: 0,
      renderedMeshes: 0,
      lights: 0,
      cameras: 0,
      prefabInstances: 0,
      inlineMeshes: 0,
      materials: 0,
    };

    let tree;
    try {
      tree = await buildGameObjectTree(docs, { prefabStack: childStack, stats: localStats });
    } catch {
      return undefined;
    }

    if (tree.roots.length === 0) return undefined;
    // Take the first root. Unity guarantees a single root for well-formed prefabs.
    const root = tree.roots[0];

    // "Thin wrapper" detection. Many component prefabs in this project follow
    // the pattern: one PrefabInstance of an FBX/OBJ model, optionally a few
    // added components (BoxCollider, etc.), and NO native GameObject docs of
    // their own. When a scene instantiates such a wrapper, its overrides
    // frequently reference Unity-2022-style stable-hashed fileIDs that don't
    // appear anywhere in the YAML (e.g. a hashed Transform fileID derived
    // from the nested prefab chain). Those targets are unresolvable by us,
    // but semantically they always refer to the only thing the wrapper
    // exposes — the root. Marking the wrapper as a model-prefab lets
    // applyPrefabModifications route unresolved root-applicable properties
    // to the root, which is the same thing Unity ends up doing.
    let hasNativeGameObject = false;
    let prefabInstanceCount = 0;
    for (const d of docs) {
      if (d.header.stripped) continue;
      if (d.header.classId === 1) {
        hasNativeGameObject = true;
        break;
      }
      if (d.header.classId === 1001) prefabInstanceCount += 1;
    }
    const isThinWrapper = !hasNativeGameObject && prefabInstanceCount >= 1;

    const parsed: ParsedPrefab = {
      guid: key,
      root,
      byTransformFileID: tree.byTransformFileID,
      byGOFileID: tree.byGOFileID,
      byComponentFileID: tree.byComponentFileID,
      isModelPrefab: isThinWrapper,
    };
    CACHE.set(key, parsed);
    return parsed;
  })();

  INFLIGHT.set(key, promise);
  try {
    return await promise;
  } finally {
    INFLIGHT.delete(key);
  }
}

/**
 * Build a minimal ParsedPrefab for an imported model asset (.fbx / .obj).
 *
 * Unity prefab-variants frequently extend imported models directly — the
 * variant's `m_SourcePrefab` points at an FBX guid with fileID `100100000`,
 * and the variant carries only modifications (material overrides, transform
 * offsets). For those variants to render, we need *something* to clone.
 *
 * We surface a single root GameObjectNode whose renderer points at the FBX.
 * That's a lossy simplification (real FBXs can be multi-node hierarchies),
 * but it captures the dominant case of a single-mesh prop, and the client's
 * FBXLoader will still pick up the first geometry inside the FBX.
 *
 * Caveats:
 * - `transform` is identity. Scene-level / variant-level modifications apply
 *   on top of that, so final placement is still correct.
 * - `materialGuids` is empty here; the variant's `m_Materials.Array.data[N]`
 *   modifications (handled in sceneParser) fill it in. Without any override
 *   the client falls back to the default grey PBR material — acceptable.
 * - `fileID`/`byGOFileID` use Unity's canonical model-prefab root fileID
 *   (`100100000`). Modifications that reference the model's *internal*
 *   fileIDs (generated by Unity from FBX node hashes) won't resolve here
 *   directly; sceneParser's applyPrefabModifications falls back to the root
 *   node for transform-style property paths, which covers the usual case.
 */
async function synthesizeModelPrefab(
  guid: string,
  absPath: string,
  ext: string,
): Promise<ParsedPrefab | undefined> {
  const base = path.basename(absPath, ext);
  const ROOT_FILE_ID = '100100000';

  // Best-effort: try to resolve the primary sub-mesh name + external
  // material remaps from the model's `.meta`. The submesh name helps the
  // client FBXLoader pick the right geometry by Object3D.name (falls back
  // to the first geometry otherwise). The external material GUIDs are
  // critical for model-prefab instances in a scene that leave `m_Materials`
  // empty — Unity normally resolves those at edit time via
  // ModelImporter.externalObjects, so we need to reproduce that mapping
  // here, otherwise a large fraction of props in the scene render as flat
  // white fallbacks ("텍스처 없는 흰 박스").
  let submeshName: string | undefined;
  let externalMaterialGuids: string[] = [];
  try {
    const meta = await getFbxMeshInfo(guid);
    if (meta) {
      submeshName = meta.meshNames.get('4300000');
      externalMaterialGuids = [...meta.materialGuidsInOrder];
    }
  } catch {
    // ignored
  }
  if (!submeshName) {
    try {
      submeshName = await resolveFbxMeshName(guid, '4300000');
    } catch {
      // ignored
    }
  }

  const root: GameObjectNode = {
    name: base,
    active: true,
    fileID: ROOT_FILE_ID,
    isCollider: false,
    transform: {
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      eulerHint: [0, 0, 0],
      scale: [1, 1, 1],
      // Synth'd model-prefab roots have no YAML-native rotation; we leave
      // `hasRotationOverride` false so the client can fold the FBX's
      // PreRotation in at render time (Unity keeps PreRotation on the
      // model prefab's root Transform rather than baking vertices, so
      // scene instances that never touch m_LocalRotation inherit that
      // rotation — we have to reproduce that behaviour here).
      hasRotationOverride: false,
    },
    renderer: {
      enabled: true,
      color: [1, 1, 1, 1],
      materialGuids: externalMaterialGuids,
      meshGuid: guid,
      meshName: path.basename(absPath),
      meshFileID: '4300000',
      meshSubmeshName: submeshName,
    },
    children: [],
  };

  const byGOFileID = new Map<string, GameObjectNode>();
  byGOFileID.set(ROOT_FILE_ID, root);
  const byTransformFileID = new Map<string, GameObjectNode>();
  const byComponentFileID = new Map<string, GameObjectNode>();

  return {
    guid,
    root,
    byGOFileID,
    byTransformFileID,
    byComponentFileID,
    isModelPrefab: true,
  };
}
