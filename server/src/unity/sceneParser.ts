import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUnityDocs, preprocessUnityYaml, UnityDocHeader } from './yamlSchema.js';
import {
  unityColorToRgba,
  unityEulerDegToThreeRad,
  unityPositionToThree,
  unityQuaternionToThree,
  unityScaleToThree,
  type Quat,
  type Vec3,
} from './coordTransform.js';
import { assetIndex } from './assetIndex.js';
import { parseMaterialByGuid, type ParsedMaterial } from './materialParser.js';
import { getFbxMeshInfo, resolveFbxMeshName } from './metaParser.js';
import { parseInlineMesh, type InlineMeshData } from './inlineMeshParser.js';
import { extractRenderSettings, type SceneRenderSettings } from './renderSettingsParser.js';

/** Unity class IDs we care about for the MVP. */
const CLASS_GAME_OBJECT = 1;
const CLASS_TRANSFORM = 4;
const CLASS_CAMERA = 20;
const CLASS_MESH_RENDERER = 23;
const CLASS_MESH_FILTER = 33;
const CLASS_MESH = 43;
const CLASS_LIGHT = 108;
const CLASS_RECT_TRANSFORM = 224;
const CLASS_SKINNED_MESH_RENDERER = 137;
const CLASS_PREFAB_INSTANCE = 1001;

/** A file reference in Unity YAML: `{fileID: 123, guid: abc, type: 2}` */
interface UnityRef {
  fileID?: number | string;
  guid?: string;
  type?: number;
}

type UnityObj = Record<string, unknown>;

export interface RawDoc {
  header: UnityDocHeader;
  /** The top-level Unity type name, e.g. "GameObject", "Transform", "PrefabInstance". */
  typeName: string;
  body: UnityObj;
}

export interface SceneJson {
  name: string;
  relPath: string;
  roots: GameObjectNode[];
  stats: {
    totalGameObjects: number;
    renderedMeshes: number;
    lights: number;
    cameras: number;
    prefabInstances: number;
    inlineMeshes: number;
    materials: number;
  };
  /** Scene-embedded Mesh documents (classId 43), keyed by Unity fileID. These
   *  typically come from ProBuilder, but also from a few procedural/baked
   *  mesh workflows. `renderer.inlineMeshFileID` points into this map. */
  inlineMeshes: Record<string, InlineMeshData>;
  /** PBR material dictionary keyed by material GUID. Each `renderer.materialGuids[i]`
   *  looks up a `MaterialJson` here. Materials not found in the asset index
   *  are not present in this map; the client falls back to a default grey
   *  PBR material in that case. */
  materials: Record<string, MaterialJson>;
  /**
   * Per-FBX `ModelImporter.externalObjects` material remap: for each FBX
   * asset referenced by any MeshRenderer in the scene, the table maps the
   * FBX-embedded material NAME (e.g. `"Material #27"`) to the external
   * `.mat` GUID Unity would substitute at import time.
   *
   * The client uses this when a MeshRenderer leaves `m_Materials` empty or
   * sparse: by pairing the FBX's internal per-submesh material-name order
   * (captured while parsing the FBX on the client) with this table, it
   * resolves the correct `.mat` per submesh group — matching what Unity's
   * editor does natively.
   *
   * Outer key: FBX asset GUID (lowercased). Inner key: embedded material
   * name. Value: external `.mat` GUID.
   */
  fbxExternalMaterials: Record<string, Record<string, string>>;
  /**
   * Project-wide `.mat` name→guid index: the file basename (without the
   * `.mat` extension) mapped to the material's GUID. Built from the asset
   * index at scene-load time.
   *
   * Reproduces Unity's `ModelImporter.MaterialSearch.RecursiveUp`: when an
   * FBX with no `externalObjects` entry has an embedded material whose
   * name matches a `.mat` file anywhere in the project, Unity binds that
   * file as the submesh's material at edit time. We let the client do the
   * same lookup after FBXLoader reports each submesh's embedded name.
   *
   * Duplicate names (rare in a well-managed project) resolve to the first
   * record encountered during the asset-index scan, matching Unity's
   * "first match wins" behaviour.
   */
  materialNameIndex: Record<string, string>;
  /** Scene-level render settings — ambient, fog, skybox reference. Mapped
   *  onto `THREE.Scene.fog` / `<ambientLight>` / scene background client-side. */
  renderSettings: SceneRenderSettings;
}

/**
 * Wire shape for a Unity material served to the web client. Designed to be
 * directly consumable by the same PBR material builder that renders the
 * Unity batch-export pipeline, so the two formats can share code client-side.
 */
export interface MaterialJson {
  guid: string;
  name: string;
  /** `"lit"` → three.js `MeshStandardMaterial`, `"unlit"` →
   *  `MeshBasicMaterial`. `"unknown"` defaults to lit client-side. */
  shaderKind: 'lit' | 'unlit' | 'unknown';
  shaderName?: string;

  baseColor: [number, number, number, number];
  baseMapGuid: string | null;
  baseMapTiling: [number, number] | null;
  baseMapOffset: [number, number] | null;

  normalMapGuid: string | null;
  normalScale: number;

  metallic: number;
  smoothness: number;
  metallicGlossMapGuid: string | null;

  occlusionMapGuid: string | null;
  occlusionStrength: number;

  emissionColor: [number, number, number];
  emissionMapGuid: string | null;

  renderMode: 'Opaque' | 'Cutout' | 'Transparent' | 'Fade';
  alphaCutoff: number;
  doubleSided: boolean;
}

/** Convert a server-side `ParsedMaterial` to the wire format sent to the client. */
function toMaterialJson(p: ParsedMaterial): MaterialJson {
  // Unity `_Cull` float: 0 = Off (double-sided), 1 = Front, 2 = Back.
  // Three.js `DoubleSide` corresponds to Cull=Off. Unity's default is 2
  // (cull back, aka front-facing only — visually equivalent to
  // THREE.FrontSide). We treat cullMode<=0.5 as double-sided, otherwise
  // single-sided, which is the common-case classification URP uses.
  const doubleSided = p.cullMode <= 0.5;
  return {
    guid: p.guid,
    name: p.name,
    shaderKind: p.shaderKind,
    shaderName: p.shaderName,

    baseColor: p.color,
    baseMapGuid: p.baseMap?.guid ?? null,
    baseMapTiling: p.baseMap?.tiling ?? null,
    baseMapOffset: p.baseMap?.offset ?? null,

    normalMapGuid: p.normalMap?.guid ?? null,
    normalScale: p.bumpScale,

    metallic: p.metallic,
    smoothness: p.smoothness,
    metallicGlossMapGuid: p.metallicGlossMap?.guid ?? null,

    occlusionMapGuid: p.occlusionMap?.guid ?? null,
    occlusionStrength: p.occlusionStrength,

    emissionColor: p.emissionColor,
    emissionMapGuid: p.emissionMap?.guid ?? null,

    renderMode: p.renderMode,
    alphaCutoff: p.alphaCutoff,
    doubleSided,
  };
}

export interface GameObjectNode {
  name: string;
  active: boolean;
  fileID: string;
  /**
   * True when this GameObject looks like a collider-only proxy (physics
   * geometry, not visual geometry). Unity scenes commonly keep visual and
   * collider hierarchies in separate sub-trees for level-designer clarity —
   * e.g. `ENV_DesertMine/collider/*`, `Collider_Mirror_Group_X/*` — and
   * duplicate the visual mesh under the collider root with a `_col` suffix
   * so the PhysX bake has watertight geometry. Those duplicates DO have a
   * MeshRenderer attached (Unity doesn't require disabling it) but the
   * author's intent is physics-only, and rendering them double-draws every
   * wall / prop in the scene.
   *
   * We flag these with a cheap heuristic so the viewer can hide them by
   * default, with a HUD toggle to unhide for debugging. The heuristic is:
   *   - the node (or any ancestor) has a name that normalises to `collider`
   *     / `Collider_*` / `_col` / `_Col_*`
   *   - OR this specific node's name ends with `_col` / `_collider`
   *
   * Does not affect actual scene data — purely a presentation hint.
   */
  isCollider: boolean;
  transform: {
    position: Vec3;
    quaternion: Quat;
    eulerHint: Vec3;
    scale: Vec3;
    /** True when the scene (or a native Transform doc) authoritatively sets
     *  `m_LocalRotation` — either via a prefab-instance modification or by
     *  the object having its own Transform YAML document. When false, the
     *  renderer should fold the source FBX's PreRotation into the node's
     *  world rotation to match Unity's "inherit prefab default rotation"
     *  behaviour. 3ds Max exports (e.g. Sky_Default) encode Z→Y-up axis
     *  conversion as a PreRotation; Unity leaves it on the model prefab's
     *  root Transform rather than baking it into vertices, so scenes that
     *  DO override rotation already account for it in the quaternion they
     *  store. Scenes that DON'T override rely on the prefab default, which
     *  our synth'd model prefab omits — hence the client-side fallback. */
    hasRotationOverride: boolean;
  };
  renderer?: {
    /**
     * Mirror of Unity's `MeshRenderer.m_Enabled`. When false, Unity skips
     * submitting this renderer to the rendering pipeline — the mesh lives
     * on the GameObject for scripts to toggle, but is not drawn. The
     * viewer treats `enabled === false` the same way a collider-only
     * object is treated: hidden by default, revealed when the user flips
     * the collider toggle in the HUD.
     */
    enabled: boolean;
    color: [number, number, number, number];
    mainTexGuid?: string;
    materialGuids: string[];
    /** GUID of the asset containing this mesh (usually an FBX). Only set when
     *  the MeshFilter points at a user asset that the client can actually
     *  fetch — i.e. `.fbx` / `.obj` / `.asset` / `.mesh`. */
    meshGuid?: string;
    /** Filename of the mesh asset (e.g. `building.fbx`). Informational. */
    meshName?: string;
    /** The specific sub-mesh inside the FBX, expressed as the Unity fileID
     *  (stringified, e.g. "4300000"). Lets the client pick the right Mesh
     *  inside an FBX that contains multiple. */
    meshFileID?: string;
    /** Human-readable name of the sub-mesh resolved from the FBX's `.meta`
     *  internalIDToNameTable. The client uses this to locate the matching
     *  Three.js Object3D after FBXLoader finishes parsing. */
    meshSubmeshName?: string;
    /** If set, the MeshFilter references a Unity built-in primitive. The web
     *  viewer maps this to a Three.js geometry constructor (BoxGeometry,
     *  SphereGeometry, ...). When absent, the renderer falls back to a unit
     *  cube placeholder. */
    builtinMesh?: 'Cube' | 'Sphere' | 'Cylinder' | 'Capsule' | 'Plane' | 'Quad';
    /** Scene-local fileID of an inline `!u!43 Mesh` document (e.g. ProBuilder
     *  geometry authored directly in the Unity editor). Present when the
     *  MeshFilter's `m_Mesh` reference has a fileID but no guid. The actual
     *  vertex/index data lives in `SceneJson.inlineMeshes[<fileID>]`. */
    inlineMeshFileID?: string;
  };
  light?: {
    type: 'Directional' | 'Point' | 'Spot' | 'Area' | 'Unknown';
    color: [number, number, number, number];
    intensity: number;
    range?: number;
    spotAngle?: number;
  };
  camera?: {
    fov: number;
    near: number;
    far: number;
  };
  children: GameObjectNode[];
}

export interface TreeStats {
  totalGameObjects: number;
  renderedMeshes: number;
  lights: number;
  cameras: number;
  prefabInstances: number;
  inlineMeshes: number;
  materials: number;
}

export interface TreeResult {
  roots: GameObjectNode[];
  /** Maps Transform fileID (in doc namespace) -> node, for prefab modifications targeting the transform. */
  byTransformFileID: Map<string, GameObjectNode>;
  /** Maps GameObject fileID (in doc namespace) -> node, for prefab modifications targeting the GO (m_Name, m_IsActive). */
  byGOFileID: Map<string, GameObjectNode>;
  /** Maps Component fileID (MeshFilter, MeshRenderer, …) -> owning GameObject
   *  node. Scene / outer-prefab modifications commonly target a component
   *  fileID (e.g. `m_Mesh` on a MeshFilter at `{fileID: 3342921016991286800}`
   *  inside `Wall_4m.prefab`). Without this map those overrides miss every
   *  lookup and get silently dropped — catastrophic for ProBuilder / inline
   *  mesh scenes like `Test_0323.unity`, where ~2200 instance-level `m_Mesh`
   *  swaps flow through component-targeted mods. */
  byComponentFileID: Map<string, GameObjectNode>;
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function fileIdOf(ref: unknown): string | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  const r = ref as UnityRef;
  if (r.fileID === undefined || r.fileID === null) return undefined;
  const s = String(r.fileID);
  if (s === '0') return undefined;
  return s;
}

function guidOf(ref: unknown): string | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  const r = ref as UnityRef;
  if (typeof r.guid !== 'string') return undefined;
  const s = r.guid.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(s) ? s : undefined;
}

/**
 * Load and pre-parse all documents from a Unity YAML file (scene or prefab).
 * Exported so prefabParser can share it.
 */
export async function loadDocs(absPath: string): Promise<RawDoc[]> {
  const raw = await fs.readFile(absPath, 'utf8');
  const pre = preprocessUnityYaml(raw);
  const docs = loadUnityDocs(pre);

  const out: RawDoc[] = [];
  for (let i = 0; i < docs.length; i += 1) {
    const header = pre.headers[i];
    const doc = docs[i];
    if (!header || !doc || typeof doc !== 'object') continue;

    const keys = Object.keys(doc as UnityObj);
    if (keys.length === 0) continue;
    const typeName = keys[0];
    const body = (doc as UnityObj)[typeName];
    if (!body || typeof body !== 'object') continue;

    out.push({ header, typeName, body: body as UnityObj });
  }
  return out;
}

/** Options that flow through recursive tree building (and into prefab expansion). */
export interface BuildOpts {
  /** Set of prefab guids currently being expanded (cycle guard). */
  prefabStack: Set<string>;
  stats: TreeStats;
  /** Accumulator for fileIDs of inline Mesh (!u!43) docs referenced by any
   *  MeshFilter in the scene being built. The caller (parseScene) decodes
   *  these once after the tree is complete. Optional so prefab-only call-
   *  sites can opt out; inline meshes inside `.prefab` files aren't wired
   *  through yet. */
  referencedInlineMeshes?: Set<string>;
}

/**
 * Build a GameObject tree from a flat list of Unity docs. Handles:
 *   - Transform/RectTransform hierarchy via m_Father/m_Children
 *   - Attached MeshRenderer/MeshFilter/Light/Camera components
 *   - PrefabInstance expansion (asynchronously loads .prefab files and splices
 *     the prefab tree in at the referenced Transform parent, applying known
 *     Modifications)
 */
export async function buildGameObjectTree(
  docs: RawDoc[],
  opts: BuildOpts,
): Promise<TreeResult> {
  const { parsePrefabByGuid } = await import('./prefabParser.js');

  const byFileID = new Map<string, RawDoc>();
  for (const d of docs) byFileID.set(d.header.fileID, d);

  const transforms: RawDoc[] = [];
  // Stripped Transform/GameObject docs act as "aliases" for nested
  // PrefabInstance roots. Their fileID lives in the OUTER prefab's namespace
  // and is what the scene / an outer prefab uses when overriding a nested
  // instance's root (m_LocalPosition.x, m_Name, m_IsActive, m_Materials, …).
  // Index them by the PrefabInstance fileID they point at so we can register
  // those aliases into byTransformFileID / byGOFileID once the instance is
  // expanded — otherwise the scene's overrides can't resolve to any node and
  // are silently dropped (which manifested as props floating at default
  // positions, or the prefab root's x=-69 being clobbered by child mods via
  // the old root-fallback heuristic).
  const strippedXformByInstanceId = new Map<string, string>();
  const strippedGoByInstanceId = new Map<string, string>();
  for (const d of docs) {
    if (!d.header.stripped) {
      if (d.header.classId === CLASS_TRANSFORM || d.header.classId === CLASS_RECT_TRANSFORM) {
        transforms.push(d);
      }
      continue;
    }
    const instId = fileIdOf(d.body['m_PrefabInstance']);
    if (!instId) continue;
    if (d.header.classId === CLASS_TRANSFORM || d.header.classId === CLASS_RECT_TRANSFORM) {
      strippedXformByInstanceId.set(instId, d.header.fileID);
    } else if (d.header.classId === CLASS_GAME_OBJECT) {
      strippedGoByInstanceId.set(instId, d.header.fileID);
    }
  }

  const byGOFileID = new Map<string, GameObjectNode>();
  const byTransformFileID = new Map<string, GameObjectNode>();
  const byComponentFileID = new Map<string, GameObjectNode>();

  async function buildFromTransform(transformDoc: RawDoc): Promise<GameObjectNode | undefined> {
    const goFileID = fileIdOf(transformDoc.body['m_GameObject']);
    if (!goFileID) return undefined;
    const goDoc = byFileID.get(goFileID);
    if (!goDoc || goDoc.header.classId !== CLASS_GAME_OBJECT) return undefined;

    opts.stats.totalGameObjects += 1;

    const name = str(goDoc.body['m_Name'], '(Unnamed)');
    const active = num(goDoc.body['m_IsActive'], 1) !== 0;

    const compList = Array.isArray(goDoc.body['m_Component'])
      ? (goDoc.body['m_Component'] as unknown[])
      : [];

    const componentDocs: RawDoc[] = [];
    for (const entry of compList) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const compRef = e.component ?? e['component'];
      const cid = fileIdOf(compRef);
      if (!cid) continue;
      const d = byFileID.get(cid);
      if (d) componentDocs.push(d);
    }

    const transform = extractTransform(transformDoc);

    const node: GameObjectNode = {
      name,
      active,
      fileID: goFileID,
      isCollider: false, // set in a post-pass once the hierarchy is known
      transform,
      children: [],
    };

    byGOFileID.set(goFileID, node);
    byTransformFileID.set(transformDoc.header.fileID, node);

    let meshFilter: RawDoc | undefined;
    let meshRenderer: RawDoc | undefined;

    for (const c of componentDocs) {
      // Every component on this GO should be reachable by its fileID so a
      // scene-level `m_Mesh` / `m_Materials` modification can find its owning
      // GameObject even when the mod targets the MeshFilter / MeshRenderer
      // directly (which is the common shape Unity writes for prefab
      // instances — the scene doesn't know the GO fileID inside the source
      // prefab, only the component fileID).
      byComponentFileID.set(c.header.fileID, node);
      switch (c.header.classId) {
        case CLASS_MESH_FILTER:
          meshFilter = c;
          break;
        case CLASS_MESH_RENDERER:
        case CLASS_SKINNED_MESH_RENDERER:
          meshRenderer = c;
          break;
        case CLASS_LIGHT:
          node.light = extractLight(c);
          opts.stats.lights += 1;
          break;
        case CLASS_CAMERA:
          node.camera = extractCamera(c);
          opts.stats.cameras += 1;
          break;
        default:
          break;
      }
    }

    if (meshRenderer) {
      const renderer = await extractRenderer(
        meshRenderer,
        meshFilter,
        opts.referencedInlineMeshes
          ? { byFileID, referencedInlineMeshes: opts.referencedInlineMeshes }
          : undefined,
      );
      if (renderer) {
        node.renderer = renderer;
        opts.stats.renderedMeshes += 1;
      }
    }

    // Recurse via m_Children order.
    const childRefs = Array.isArray(transformDoc.body['m_Children'])
      ? (transformDoc.body['m_Children'] as unknown[])
      : [];
    for (const ref of childRefs) {
      const cid = fileIdOf(ref);
      if (!cid) continue;
      const childT = byFileID.get(cid);
      if (!childT) continue;
      if (
        childT.header.classId !== CLASS_TRANSFORM &&
        childT.header.classId !== CLASS_RECT_TRANSFORM
      ) {
        continue;
      }
      const childNode = await buildFromTransform(childT);
      if (childNode) node.children.push(childNode);
    }

    return node;
  }

  // Determine roots: Transforms with no m_Father.
  const roots: GameObjectNode[] = [];
  for (const t of transforms) {
    const father = fileIdOf(t.body['m_Father']);
    if (father) continue;
    const node = await buildFromTransform(t);
    if (node) roots.push(node);
  }

  // --- PrefabInstance expansion pass ------------------------------------
  // For each PrefabInstance doc, load the source .prefab, clone its tree,
  // apply m_Modification.m_Modifications, then splice it in at the referenced
  // parent Transform (or at scene root if m_TransformParent = 0).
  for (const d of docs) {
    if (d.header.classId !== CLASS_PREFAB_INSTANCE) continue;
    opts.stats.prefabInstances += 1;

    const modBlock = d.body['m_Modification'];
    if (!modBlock || typeof modBlock !== 'object') continue;
    const mod = modBlock as UnityObj;
    const sourceGuid = guidOf(d.body['m_SourcePrefab']);
    if (!sourceGuid) continue;

    let prefabNode: GameObjectNode | undefined;
    let sourcePrefab: Awaited<ReturnType<typeof parsePrefabByGuid>> = undefined;
    try {
      sourcePrefab = await parsePrefabByGuid(sourceGuid, opts.prefabStack);
      if (sourcePrefab) {
        prefabNode = clonePrefabTree(sourcePrefab.root);
        // Apply modifications
        applyPrefabModifications(prefabNode, sourcePrefab, mod);
      }
    } catch {
      // Swallow: a broken prefab shouldn't kill the whole scene.
    }
    if (!prefabNode) continue;

    opts.stats.totalGameObjects += countGameObjects(prefabNode);
    opts.stats.renderedMeshes += countRenderers(prefabNode);
    opts.stats.lights += countLights(prefabNode);
    opts.stats.cameras += countCameras(prefabNode);

    // Attach the cloned sub-tree to its parent BEFORE merging the nested
    // prefab's fileID namespace into ours. If we merged first, the nested
    // prefab's own native root fileIDs would clobber this outer prefab's
    // (because Unity reuses small fileIDs like `629154658267911177` across
    // prefabs — they're scoped per-file, not globally unique). The parent
    // lookup below must see the OUTER prefab's map, untouched.
    const parentId = fileIdOf(mod['m_TransformParent']);
    if (parentId) {
      const parent = byTransformFileID.get(parentId);
      if (parent) {
        parent.children.push(prefabNode);
      } else {
        roots.push(prefabNode);
      }
    } else {
      roots.push(prefabNode);
    }

    // Propagate the inner prefab's fileID namespace outward so scene-level
    // overrides like `{fileID: wallChildXformInWallModule, guid: Blue}` can
    // resolve three prefabs deep. Crucially, we only fill in entries that
    // aren't already set: the outer prefab's own native mappings are
    // authoritative, and nested prefab roots commonly reuse the same small
    // fileIDs (e.g. both StairSet_2m and its nested Stair use
    // `629154658267911177` as their native Transform ID).
    if (sourcePrefab) {
      const srcOrder: GameObjectNode[] = [];
      const cloneOrder: GameObjectNode[] = [];
      const pushAll = (n: GameObjectNode, arr: GameObjectNode[]) => {
        arr.push(n);
        for (const c of n.children) pushAll(c, arr);
      };
      pushAll(sourcePrefab.root, srcOrder);
      pushAll(prefabNode, cloneOrder);
      for (const cloneNode of cloneOrder) {
        if (cloneNode.fileID && !byGOFileID.has(cloneNode.fileID)) {
          byGOFileID.set(cloneNode.fileID, cloneNode);
        }
      }
      for (const [xformFileID, origGO] of sourcePrefab.byTransformFileID.entries()) {
        if (byTransformFileID.has(xformFileID)) continue;
        const idx = srcOrder.indexOf(origGO);
        if (idx >= 0 && idx < cloneOrder.length) {
          byTransformFileID.set(xformFileID, cloneOrder[idx]);
        }
      }
      // Same drill for component fileIDs. The scene / outer prefab targets
      // nested MeshFilters/MeshRenderers by the fileID they had inside the
      // source prefab, so projecting that namespace through the cloned tree
      // lets `applyPrefabModifications` resolve every mod.
      for (const [compFileID, origGO] of sourcePrefab.byComponentFileID.entries()) {
        if (byComponentFileID.has(compFileID)) continue;
        const idx = srcOrder.indexOf(origGO);
        if (idx >= 0 && idx < cloneOrder.length) {
          byComponentFileID.set(compFileID, cloneOrder[idx]);
        }
      }
    }
    // Register the stripped-alias fileIDs that the outer prefab / scene use
    // to refer to this nested instance's root. Without these, outer overrides
    // on the instance's own transform (e.g. `m_LocalPosition.x = -6`
    // targeting `{fileID: 9165011913175360982, guid: Blue}`) would miss
    // entirely. These aliases ARE authoritative and safe to always overwrite
    // with — they encode the outer prefab's chosen identity for the nested
    // instance.
    const aliasXformId = strippedXformByInstanceId.get(d.header.fileID);
    if (aliasXformId) byTransformFileID.set(aliasXformId, prefabNode);
    const aliasGoId = strippedGoByInstanceId.get(d.header.fileID);
    if (aliasGoId) byGOFileID.set(aliasGoId, prefabNode);
  }

  return { roots, byTransformFileID, byGOFileID, byComponentFileID };
}

export async function parseScene(absPath: string, relPath: string): Promise<SceneJson> {
  const docs = await loadDocs(absPath);
  const stats: TreeStats = {
    totalGameObjects: 0,
    renderedMeshes: 0,
    lights: 0,
    cameras: 0,
    prefabInstances: 0,
    inlineMeshes: 0,
    materials: 0,
  };
  const referencedInlineMeshes = new Set<string>();
  const { roots } = await buildGameObjectTree(docs, {
    prefabStack: new Set<string>(),
    stats,
    referencedInlineMeshes,
  });

  // Resolve submesh display names for any renderer whose mesh was overridden
  // by a prefab or scene modification. `synthesizeModelPrefab` eagerly caches
  // the submesh name of the FBX's default mesh (fileID 4300000), but thin-
  // wrapper prefabs frequently redirect m_Mesh to a different fileID or a
  // different FBX altogether. Without this pass the client would fall back
  // to `gameObject.name` (which never matches) and pick the first FBX
  // geometry — e.g. rendering StreetWall_SM for every GeneralWall_Pillar_SM.
  await resolveOverriddenMeshNames(roots);

  // Flag collider-only sub-trees so the viewer can hide them by default.
  // Runs once, after prefab expansion + scene modifications have settled,
  // so nested prefabs placed under a `collider/` hierarchy inherit the
  // flag cleanly.
  markColliderTrees(roots);

  // Resolve inline-mesh overrides that arrived via PrefabInstance
  // modifications. These flow through `applyModification.case 'm_Mesh'`
  // which knows how to set `meshFileID` but CAN'T register the mesh for
  // decoding (the modification pipeline doesn't have access to the
  // scene's doc index). We do that here, now that every prefab has been
  // expanded and the tree is final.
  const byFileID = new Map<string, RawDoc>();
  for (const d of docs) byFileID.set(d.header.fileID, d);
  migrateInlineMeshOverrides(roots, byFileID, referencedInlineMeshes);

  // Decode each referenced inline Mesh exactly once. A single ProBuilder
  // mesh is commonly instanced across many GameObjects, so deduping here
  // keeps the JSON payload linear in unique meshes, not MeshFilters.
  const inlineMeshes: Record<string, InlineMeshData> = {};
  for (const fid of referencedInlineMeshes) {
    const doc = byFileID.get(fid);
    if (!doc || doc.header.classId !== CLASS_MESH) continue;
    const parsed = parseInlineMesh(doc);
    if (parsed) {
      inlineMeshes[fid] = parsed;
      stats.inlineMeshes += 1;
    }
  }

  // Collect every material guid referenced by any renderer in the tree
  // (including expanded prefabs) plus every FBX mesh guid, so we can
  //   (a) resolve the explicit scene/prefab `m_Materials` refs into the
  //       `materials` dictionary, and
  //   (b) pull each referenced FBX's externalObjects name→guid remap so
  //       the client can fill slots the scene left empty by matching
  //       FBX-internal material names.
  const materialGuids = new Set<string>();
  const fbxMeshGuids = new Set<string>();
  collectRendererRefs(roots, materialGuids, fbxMeshGuids);

  const fbxExternalMaterials: Record<string, Record<string, string>> = {};
  for (const guid of fbxMeshGuids) {
    try {
      const info = await getFbxMeshInfo(guid);
      if (!info || info.materialByName.size === 0) continue;
      const remap: Record<string, string> = {};
      for (const [name, g] of info.materialByName) {
        remap[name] = g;
        materialGuids.add(g); // ensure externalObjects targets land in dict
      }
      fbxExternalMaterials[guid] = remap;
    } catch {
      // best-effort; a missing .meta just means this FBX gets fallback colours.
    }
  }

  // Build a project-wide name→guid lookup for every `.mat` asset so the
  // client can reproduce Unity's `MaterialSearch.RecursiveUp` behaviour.
  // We also eagerly add every indexed .mat GUID to `materialGuids` so the
  // client doesn't have to chase missing dict entries via follow-up fetches
  // whenever an FBX surfaces a previously-unseen embedded material name.
  const materialNameIndex: Record<string, string> = {};
  for (const rec of assetIndex.allByExt('.mat')) {
    const slash = rec.absPath.lastIndexOf('/');
    const backslash = rec.absPath.lastIndexOf('\\');
    const sepIdx = Math.max(slash, backslash);
    const base = rec.absPath.slice(sepIdx + 1, -'.mat'.length);
    // First-writer wins: iteration order mirrors the assetIndex's
    // Assets→Packages→PackageCache scan priority, which matches Unity.
    if (base && !materialNameIndex[base]) {
      materialNameIndex[base] = rec.guid;
    }
    materialGuids.add(rec.guid);
  }

  // Parse every referenced material + every indexed .mat concurrently. The
  // per-GUID LRU inside `parseMaterialByGuid` keeps this cheap on warm
  // reloads; on a cold start it dominates scene-load time but we only pay
  // it once.
  const materials: Record<string, MaterialJson> = {};
  await Promise.all(
    Array.from(materialGuids).map(async (guid) => {
      const parsed = await parseMaterialByGuid(guid);
      if (parsed) {
        materials[guid] = toMaterialJson(parsed);
      }
    }),
  );
  stats.materials = Object.keys(materials).length;

  const { settings: renderSettings } = extractRenderSettings(docs);

  // TEMP DEBUG: dump the first few scene roots' transforms and their first
  // level of children so we can cross-reference against Unity's Hierarchy
  // and Inspector values. Useful to confirm whether
  //   (a) PrefabInstance root overrides actually landed on the cloned root,
  //   (b) m_Children composition preserves local-vs-world distinction, and
  //   (c) sparse model-prefabs aren't silently losing position overrides.
  const fmt3 = (v: number[]): string => `(${v[0].toFixed(2)},${v[1].toFixed(2)},${v[2].toFixed(2)})`;
  const fmt4 = (v: number[]): string =>
    `(${v[0].toFixed(2)},${v[1].toFixed(2)},${v[2].toFixed(2)},${v[3].toFixed(2)})`;
  // eslint-disable-next-line no-console
  console.log(`[sceneDump] ${path.basename(absPath)} totalRoots=${roots.length}`);
  for (let i = 0; i < roots.length; i += 1) {
    const r = roots[i];
    // eslint-disable-next-line no-console
    console.log(
      `[sceneDump] root#${i} '${r.name}' pos=${fmt3(r.transform.position)} rot=${fmt4(r.transform.quaternion)} scale=${fmt3(r.transform.scale)} children=${r.children.length}`,
    );
  }

  return {
    name: path.basename(absPath, '.unity'),
    relPath,
    roots,
    stats,
    inlineMeshes,
    materials,
    fbxExternalMaterials,
    materialNameIndex,
    renderSettings,
  };
}

function collectRendererRefs(
  nodes: GameObjectNode[],
  matGuids: Set<string>,
  fbxGuids: Set<string>,
): void {
  for (const n of nodes) {
    if (n.renderer) {
      // Skip empty slots (padding left over from m_Materials array-index mods
      // that targeted a higher slot than the source prefab exposed).
      for (const g of n.renderer.materialGuids) if (g) matGuids.add(g);
      const mesh = n.renderer.meshGuid;
      const meshName = n.renderer.meshName?.toLowerCase() ?? '';
      if (mesh && (meshName.endsWith('.fbx') || meshName.endsWith('.obj'))) {
        fbxGuids.add(mesh);
      }
    }
    if (n.children.length > 0) collectRendererRefs(n.children, matGuids, fbxGuids);
  }
}

function extractTransform(t: RawDoc): GameObjectNode['transform'] {
  const body = t.body;
  const pos = body['m_LocalPosition'] as Record<string, number> | undefined;
  const rot = body['m_LocalRotation'] as Record<string, number> | undefined;
  const scale = body['m_LocalScale'] as Record<string, number> | undefined;
  const eulerHint = body['m_LocalEulerAnglesHint'] as Record<string, number> | undefined;

  return {
    position: unityPositionToThree(pos),
    quaternion: unityQuaternionToThree(rot),
    eulerHint: unityEulerDegToThreeRad(eulerHint),
    scale: unityScaleToThree(scale),
    // Native (non-stripped) Transform docs always carry an authoritative
    // m_LocalRotation — whether identity or not, the scene author has
    // committed to that value. Prefab-instance transforms start with the
    // source prefab's default and get flipped to true only when a scene
    // modification actually touches m_LocalRotation.* (see applyModification).
    hasRotationOverride: rot !== undefined,
  };
}

function extractLight(c: RawDoc): GameObjectNode['light'] {
  const body = c.body;
  const rawType = num(body['m_Type'], 1);
  const typeMap: Record<number, NonNullable<GameObjectNode['light']>['type']> = {
    0: 'Spot',
    1: 'Directional',
    2: 'Point',
    3: 'Area',
  };
  const type = typeMap[rawType] ?? 'Unknown';
  const color = unityColorToRgba(
    body['m_Color'] as { r?: number; g?: number; b?: number; a?: number } | undefined,
  );
  const intensity = num(body['m_Intensity'], 1);
  const range = num(body['m_Range'], 10);
  const spotAngle = num(body['m_SpotAngle'], 30);
  return { type, color, intensity, range, spotAngle };
}

function extractCamera(c: RawDoc): GameObjectNode['camera'] {
  const body = c.body;
  return {
    fov: num(body['field of view'], 60),
    near: num(body['near clip plane'], 0.3),
    far: num(body['far clip plane'], 1000),
  };
}

// Unity built-in primitive mesh fileIDs. These live in the "Default Resources"
// pseudo-asset whose GUID is all zeros with an 'e' at position 16.
// Source: Unity forum/docs knowledge; verified empirically in project scenes.
const BUILTIN_RESOURCES_GUID_PREFIX = /^0{16}[ef]0{15}$/;
const BUILTIN_MESH_BY_FILEID: Record<string, NonNullable<GameObjectNode['renderer']>['builtinMesh']> = {
  '10202': 'Cube',
  '10206': 'Cylinder',
  '10207': 'Sphere',
  '10208': 'Capsule',
  '10209': 'Plane',
  '10210': 'Quad',
};

function detectBuiltinMesh(
  meshRef: unknown,
): NonNullable<GameObjectNode['renderer']>['builtinMesh'] | undefined {
  if (!meshRef || typeof meshRef !== 'object') return undefined;
  const r = meshRef as UnityRef;
  if (r.fileID === undefined || r.fileID === null) return undefined;
  const guid = typeof r.guid === 'string' ? r.guid.trim().toLowerCase() : '';
  if (!BUILTIN_RESOURCES_GUID_PREFIX.test(guid)) return undefined;
  const fid = String(r.fileID);
  return BUILTIN_MESH_BY_FILEID[fid];
}

async function extractRenderer(
  renderer: RawDoc,
  filter: RawDoc | undefined,
  ctx?: {
    /** Doc-local fileID → RawDoc, used to detect inline Mesh references. */
    byFileID: Map<string, RawDoc>;
    /** Accumulator: inline mesh fileIDs referenced by any MeshFilter. The
     *  caller decodes these once and stores them on the SceneJson. */
    referencedInlineMeshes: Set<string>;
  },
): Promise<GameObjectNode['renderer'] | undefined> {
  const matsRaw = Array.isArray(renderer.body['m_Materials'])
    ? (renderer.body['m_Materials'] as unknown[])
    : [];

  // Preserve slot order even for empty (fileID:0) entries — see below.
  // Unity's m_Materials is a positional array: slot N -> submesh N of the
  // mesh. Prefabs / scene YAML frequently leave slots empty because Unity
  // resolves them at edit-time via the ModelImporter's externalObjects
  // remap. If we squash those empties, we lose the "this slot needs a
  // fallback from the model" signal and the roof / trim submeshes render
  // as a flat white.
  const materialGuids: string[] = [];
  let sawEmpty = false;
  for (const m of matsRaw) {
    const g = guidOf(m);
    if (g) {
      materialGuids.push(g);
    } else {
      materialGuids.push('');
      sawEmpty = true;
    }
  }

  let meshGuid: string | undefined;
  let meshName: string | undefined;
  let meshFileID: string | undefined;
  let meshSubmeshName: string | undefined;
  let builtinMesh: NonNullable<GameObjectNode['renderer']>['builtinMesh'];
  let inlineMeshFileID: string | undefined;
  if (filter) {
    const meshRef = filter.body['m_Mesh'];
    builtinMesh = detectBuiltinMesh(meshRef);
    if (!builtinMesh) {
      const candidateGuid = guidOf(meshRef);
      if (candidateGuid) {
        const rec = assetIndex.get(candidateGuid);
        if (rec) {
          // Only surface a meshGuid the client can actually fetch + render.
          // Anything else (animation-only FBX is fine since it uses .fbx too,
          // but .controller, .mat etc aren't meshes at all) gets dropped so
          // the client falls back to the placeholder cube.
          const ext = rec.ext;
          if (ext === '.fbx' || ext === '.obj' || ext === '.asset' || ext === '.mesh') {
            meshGuid = candidateGuid;
            meshName = rec.relPath.split('/').pop();
            meshFileID = fileIdOf(meshRef);
            if (meshFileID && (ext === '.fbx' || ext === '.obj')) {
              try {
                meshSubmeshName = await resolveFbxMeshName(meshGuid, meshFileID);
              } catch {
                // best-effort; the client can still try to load the FBX and
                // pick the first mesh it finds.
              }
            }
          }
        }
      } else if (ctx) {
        // No guid → this is a scene-local reference. If the target doc is a
        // `!u!43 Mesh` (inline mesh, e.g. ProBuilder), record its fileID so
        // the scene-level pass can decode and ship it to the client.
        const internalFid = fileIdOf(meshRef);
        if (internalFid) {
          const target = ctx.byFileID.get(internalFid);
          if (target && target.header.classId === CLASS_MESH) {
            inlineMeshFileID = internalFid;
            ctx.referencedInlineMeshes.add(internalFid);
          }
        }
      }
    }
  }

  // For single-submesh FBXs we can safely fill an empty `m_Materials` from
  // the source FBX's `ModelImporter.externalObjects`: with exactly one
  // embedded material there's no submesh-ordering ambiguity. Multi-submesh
  // FBXs are resolved on the client instead — the `.meta`'s declaration
  // order has no correlation with the FBX binary's internal material-index
  // order, so the scene-level `fbxExternalMaterials` map is emitted below
  // and the client pairs it with names it reads from FBXLoader to bind the
  // right `.mat` per submesh group.
  const hasAnyExplicit = materialGuids.some((g) => g);
  if (
    !hasAnyExplicit &&
    meshGuid &&
    (meshName?.toLowerCase().endsWith('.fbx') || meshName?.toLowerCase().endsWith('.obj'))
  ) {
    try {
      const info = await getFbxMeshInfo(meshGuid);
      const fallback = info?.materialGuidsInOrder ?? [];
      if (fallback.length === 1) {
        if (materialGuids.length === 0) materialGuids.push(fallback[0]);
        else materialGuids[0] = fallback[0];
      }
    } catch {
      // externalObjects is a best-effort enrichment; silent skip on failure.
    }
  }

  // Resolve the *first* material eagerly so we can surface a legacy-style
  // colour/mainTex pair for clients that haven't adopted the new PBR
  // pipeline yet. The full materials dictionary is populated later at the
  // scene level once we know every referenced guid.
  let primary: ParsedMaterial | undefined;
  const firstExplicitGuid = materialGuids.find((g) => g);
  if (firstExplicitGuid) {
    primary = await parseMaterialByGuid(firstExplicitGuid);
  }

  const color = primary?.color ?? [0.7, 0.7, 0.7, 1];
  const mainTexGuid = primary?.baseMap?.guid;

  // `m_Enabled` is the renderer's Unity checkbox; absent in YAML means the
  // default value, which is `1` (enabled). Only an explicit `0` suppresses
  // rendering, matching how Unity writes disabled components.
  const enabledRaw = renderer.body['m_Enabled'];
  const enabled = enabledRaw === undefined || enabledRaw === null ? true : Number(enabledRaw) !== 0;

  return {
    enabled,
    color,
    mainTexGuid,
    materialGuids,
    meshGuid,
    meshName,
    meshFileID,
    meshSubmeshName,
    builtinMesh,
    inlineMeshFileID,
  };
}

// --- Prefab tree helpers (used by the PrefabInstance expansion pass) ---

function clonePrefabTree(node: GameObjectNode): GameObjectNode {
  return {
    name: node.name,
    active: node.active,
    fileID: node.fileID,
    isCollider: node.isCollider,
    transform: {
      position: [...node.transform.position] as Vec3,
      quaternion: [...node.transform.quaternion] as Quat,
      eulerHint: [...node.transform.eulerHint] as Vec3,
      scale: [...node.transform.scale] as Vec3,
      hasRotationOverride: node.transform.hasRotationOverride,
    },
    renderer: node.renderer
      ? {
          enabled: node.renderer.enabled,
          color: [...node.renderer.color] as [number, number, number, number],
          mainTexGuid: node.renderer.mainTexGuid,
          materialGuids: [...node.renderer.materialGuids],
          meshGuid: node.renderer.meshGuid,
          meshName: node.renderer.meshName,
          meshFileID: node.renderer.meshFileID,
          meshSubmeshName: node.renderer.meshSubmeshName,
          builtinMesh: node.renderer.builtinMesh,
          inlineMeshFileID: node.renderer.inlineMeshFileID,
        }
      : undefined,
    light: node.light ? { ...node.light, color: [...node.light.color] as [number, number, number, number] } : undefined,
    camera: node.camera ? { ...node.camera } : undefined,
    children: node.children.map(clonePrefabTree),
  };
}

interface PrefabTreeInfo {
  byGOFileID: Map<string, GameObjectNode>;
  byTransformFileID: Map<string, GameObjectNode>;
  byComponentFileID: Map<string, GameObjectNode>;
  root: GameObjectNode;
}

/**
 * Re-index a freshly-cloned prefab tree so we can resolve modification targets
 * by fileID without the maps leaking state between instances.
 */
function indexClonedPrefab(root: GameObjectNode): PrefabTreeInfo {
  const byGOFileID = new Map<string, GameObjectNode>();
  const byTransformFileID = new Map<string, GameObjectNode>();
  const byComponentFileID = new Map<string, GameObjectNode>();
  const walk = (n: GameObjectNode) => {
    byGOFileID.set(n.fileID, n);
    // We don't store transform fileIDs on the cloned node; they live on the
    // original prefab's map. But in practice modifications target either the
    // GO or the Transform; Unity allows both. For simplicity we target GO
    // only here — `m_LocalPosition`/`m_LocalRotation` paths map to the Trans-
    // form that lives on the same GO, which we can reach via the GO node.
    for (const c of n.children) walk(c);
  };
  walk(root);
  return { byGOFileID, byTransformFileID, byComponentFileID, root };
}

/**
 * Apply m_Modification.m_Modifications from a PrefabInstance to the cloned
 * prefab tree. We support the subset of property paths that materially affect
 * the rendered scene:
 *
 *   m_LocalPosition.{x|y|z}
 *   m_LocalRotation.{x|y|z|w}
 *   m_LocalScale.{x|y|z}
 *   m_Name
 *   m_IsActive
 *   m_LocalEulerAnglesHint.{x|y|z}
 *
 * Modification targets reference a fileID in the source prefab's namespace,
 * which equals the fileID stored on GameObjectNode (we carry it forward from
 * the original scan). Modifications whose target is a Transform are mapped
 * to the GameObject on the same GO by way of prefab.byTransformFileID.
 */
function applyPrefabModifications(
  clonedRoot: GameObjectNode,
  prefabInfo: {
    byGOFileID: Map<string, GameObjectNode>;
    byTransformFileID: Map<string, GameObjectNode>;
    byComponentFileID: Map<string, GameObjectNode>;
    root: GameObjectNode;
    isModelPrefab: boolean;
  },
  modBlock: UnityObj,
): void {
  const mods = Array.isArray(modBlock['m_Modifications']) ? (modBlock['m_Modifications'] as unknown[]) : [];
  if (mods.length === 0) return;

  // Re-index cloned tree so GO fileIDs resolve on OUR copy (not the cached original).
  const cloned = indexClonedPrefab(clonedRoot);

  // Mirror the original prefab's transform -> GO mapping onto our clone by
  // pairing fileIDs in scan order (the tree layout is identical).
  // Quick approach: pair by traversal order.
  const origOrder: GameObjectNode[] = [];
  const cloneOrder: GameObjectNode[] = [];
  const pushAll = (n: GameObjectNode, arr: GameObjectNode[]) => { arr.push(n); for (const c of n.children) pushAll(c, arr); };
  pushAll(prefabInfo.root, origOrder);
  pushAll(clonedRoot, cloneOrder);
  // Map original transform fileID -> cloned GO
  const clonedByTransformFileID = new Map<string, GameObjectNode>();
  for (const [transformFileID, origGONode] of prefabInfo.byTransformFileID.entries()) {
    const idx = origOrder.indexOf(origGONode);
    if (idx >= 0 && idx < cloneOrder.length) {
      clonedByTransformFileID.set(transformFileID, cloneOrder[idx]);
    }
  }
  // Same pairing trick for components. Outer overrides on `m_Mesh`,
  // `m_Materials.Array.data[N]`, and `m_Enabled` target the component
  // directly (MeshFilter, MeshRenderer, …), not the GameObject. Without
  // this map those mods miss for every nested prefab instance — which is
  // how Test_0323.unity's 2200+ ProBuilder swaps silently collapsed into
  // "render the FBX fallback".
  const clonedByComponentFileID = new Map<string, GameObjectNode>();
  for (const [compFileID, origGONode] of prefabInfo.byComponentFileID.entries()) {
    const idx = origOrder.indexOf(origGONode);
    if (idx >= 0 && idx < cloneOrder.length) {
      clonedByComponentFileID.set(compFileID, cloneOrder[idx]);
    }
  }

  let hitGo = 0;
  let hitXform = 0;
  let hitComp = 0;
  let hitFallback = 0;
  let missed = 0;

  for (const rawMod of mods) {
    if (!rawMod || typeof rawMod !== 'object') continue;
    const m = rawMod as Record<string, unknown>;
    const target = m.target;
    const targetFileID = fileIdOf(target);
    if (!targetFileID) continue;
    const propertyPath = typeof m.propertyPath === 'string' ? m.propertyPath : '';
    const value = m.value;
    const objectReference = m.objectReference;
    if (!propertyPath) continue;

    // Find the target node. The fileID might reference a Transform or a GameObject.
    //
    // Model prefabs (synthesized from .fbx / .obj) have a single synthetic
    // root whose GameObject/Transform fileIDs don't match the hashed IDs that
    // Unity uses internally for FBX sub-nodes. For those, scene-level mods
    // almost always target the top-level GO, so routing unresolved mods to
    // the cloned root is the right thing.
    //
    // Regular .prefab trees, in contrast, have every GameObject and Transform
    // addressable by its fileID (directly, or via nested PrefabInstance
    // expansion). If we fall back to root for an unresolved mod there, we
    // end up clobbering the prefab root's own pos/rot/scale with values
    // intended for a nested child — e.g. a wall chunk's x offset of -6 will
    // overwrite the scene-level -69 override on the prefab root. We simply
    // skip unresolved mods for regular prefabs; nested-prefab overrides
    // targeting a sub-prefab's namespace require chained resolution which is
    // not yet implemented, but dropping them is strictly better than
    // smearing them across the root.
    let node =
      cloned.byGOFileID.get(targetFileID) ??
      clonedByTransformFileID.get(targetFileID) ??
      clonedByComponentFileID.get(targetFileID);
    let hitSource: 'go' | 'xform' | 'comp' | null = null;
    if (node) {
      if (cloned.byGOFileID.has(targetFileID)) hitSource = 'go';
      else if (clonedByTransformFileID.has(targetFileID)) hitSource = 'xform';
      else hitSource = 'comp';
      if (hitSource === 'go') hitGo += 1;
      else if (hitSource === 'xform') hitXform += 1;
      else hitComp += 1;
    }
    if (!node && prefabInfo.isModelPrefab && isRootApplicableProperty(propertyPath)) {
      node = clonedRoot;
      hitFallback += 1;
    }
    if (!node) {
      missed += 1;
      continue;
    }

    applyModification(node, propertyPath, value, objectReference);
  }

  // Log only when most mods miss — that points at a prefab where the stripped
  // alias pass didn't catch enough nested references. Healthy expansions go
  // silent.
  if (missed >= 5 && missed > hitGo + hitXform + hitComp + hitFallback) {
    console.log(
      `[prefabMod] root='${clonedRoot.name}' mods=${mods.length} hitGo=${hitGo} hitXform=${hitXform} hitComp=${hitComp} fallback=${hitFallback} miss=${missed}`,
    );
  }
}

/**
 * Property paths that make sense to apply to the prefab root when we can't
 * resolve the exact target fileID. These all target the top-level GameObject
 * or its Transform / MeshRenderer — the most common modification surface for
 * scene-placed prefabs.
 */
function isRootApplicableProperty(propertyPath: string): boolean {
  if (propertyPath.startsWith('m_LocalPosition')) return true;
  if (propertyPath.startsWith('m_LocalRotation')) return true;
  if (propertyPath.startsWith('m_LocalScale')) return true;
  if (propertyPath.startsWith('m_LocalEulerAnglesHint')) return true;
  if (propertyPath === 'm_Name') return true;
  if (propertyPath === 'm_IsActive') return true;
  if (propertyPath === 'm_Mesh') return true;
  if (propertyPath.startsWith('m_Materials.Array.data[')) return true;
  if (propertyPath === 'm_Materials.Array.size') return true;
  return false;
}

function applyModification(
  node: GameObjectNode,
  propertyPath: string,
  value: unknown,
  objectReference?: unknown,
): void {
  const numVal = (): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };

  // Dotted property paths map to Unity vector/quaternion components.
  const [base, comp] = propertyPath.split('.');
  switch (base) {
    case 'm_LocalPosition': {
      const v = numVal();
      if (v === undefined) return;
      // Unity position → Three: flip x. Apply in Three-space by flipping x-mod.
      if (comp === 'x') node.transform.position[0] = -v;
      else if (comp === 'y') node.transform.position[1] = v;
      else if (comp === 'z') node.transform.position[2] = v;
      break;
    }
    case 'm_LocalRotation': {
      const v = numVal();
      if (v === undefined) return;
      // Unity quaternion (x, y, z, w) → Three: (x, -y, -z, w)
      if (comp === 'x') node.transform.quaternion[0] = v;
      else if (comp === 'y') node.transform.quaternion[1] = -v;
      else if (comp === 'z') node.transform.quaternion[2] = -v;
      else if (comp === 'w') node.transform.quaternion[3] = v;
      // Unity scenes that override m_LocalRotation always store the full
      // quaternion — that value already folds in whatever PreRotation the
      // source FBX contributed (e.g. Sky_Default's -90° X for Z→Y-up axis
      // conversion, plus the user's authored Y spin). Flagging the node
      // tells the client to skip its own PreRotation fallback for this
      // instance — otherwise we'd double-apply the -90° X and the sky dome
      // would tip onto its side.
      node.transform.hasRotationOverride = true;
      break;
    }
    case 'm_LocalScale': {
      const v = numVal();
      if (v === undefined) return;
      if (comp === 'x') node.transform.scale[0] = v;
      else if (comp === 'y') node.transform.scale[1] = v;
      else if (comp === 'z') node.transform.scale[2] = v;
      break;
    }
    case 'm_LocalEulerAnglesHint': {
      const v = numVal();
      if (v === undefined) return;
      const DEG2RAD = Math.PI / 180;
      if (comp === 'x') node.transform.eulerHint[0] = v * DEG2RAD;
      else if (comp === 'y') node.transform.eulerHint[1] = -v * DEG2RAD;
      else if (comp === 'z') node.transform.eulerHint[2] = -v * DEG2RAD;
      break;
    }
    case 'm_Name': {
      if (typeof value === 'string') node.name = value;
      break;
    }
    case 'm_IsActive': {
      const v = numVal();
      if (v !== undefined) node.active = v !== 0;
      break;
    }
    case 'm_Mesh': {
      // Two override styles land in this branch:
      //
      //   (1) Cross-FBX redirect. Thin-wrapper prefabs (e.g.
      //       GeneralWall_Pillar_SM.prefab) take a generic FBX as their
      //       PrefabInstance source and then redirect `m_Mesh` to a sub-mesh
      //       inside a different FBX via `{fileID, guid, type:3}`. Without
      //       honouring the override we'd render the source FBX's default
      //       geometry — e.g. StreetWall_SM in place of GeneralWall_Pillar_SM.
      //
      //   (2) Scene-local inline-mesh swap. Editor-authored prefabs
      //       (ProBuilder layout kits, Mirama's Wall_4m_* series) ship an
      //       FBX-shaped MeshFilter and then have every scene instance
      //       override `m_Mesh` with `{fileID: <scene-local !u!43 Mesh>}`
      //       — no guid, because the inline mesh lives inside the .unity
      //       file itself. If we kept the original FBX guid we'd render
      //       the prefab's fallback geometry for every Wall_4m_*, and
      //       the scene's actual ProBuilder shape would never hit the wire.
      //
      // For (1) we update `meshGuid` + `meshFileID`. For (2) we MUST clear
      // the stale FBX guid/name so `migrateInlineMeshOverrides` (post-pass)
      // can recognise the renderer as inline-bound and register the scene-
      // local !u!43 Mesh for decoding.
      if (!node.renderer) break;
      const meshGuid = guidOf(objectReference);
      const meshFileID = fileIdOf(objectReference);
      if (meshGuid) {
        node.renderer.meshGuid = meshGuid;
      } else {
        // Scene-local inline override: drop the prefab's default FBX
        // binding entirely. Leaving `meshGuid` around would make the
        // client FBXLoader fetch/display the original asset and ignore
        // the inline geometry completely.
        node.renderer.meshGuid = undefined;
        node.renderer.meshName = undefined;
      }
      if (meshFileID) node.renderer.meshFileID = meshFileID;
      // The submesh name cached from the original FBX no longer applies to
      // the overridden mesh — drop it so the post-pass (or the client's
      // name-based fallback) picks the right geometry.
      node.renderer.meshSubmeshName = undefined;
      break;
    }
    default: {
      // m_Materials.Array.size = N: Unity prefab variants routinely TRUNCATE
      // the source FBX/prefab's m_Materials array (e.g. FBX import creates
      // 4 slots, the instance only needs 1). Without honouring this we carry
      // the source's phantom slots forward, which is harmless for a
      // single-submesh mesh (only slot 0 is sampled) but DEADLY when combined
      // with `m_Materials.Array.data[N]` mods targeting the resized array:
      // Unity's semantics evaluate size first, so data[0] after size=1 means
      // "overwrite the one-and-only slot", but if we kept the old 4 entries
      // the user's intended material ends up competing with stale defaults
      // and the rendering looks nothing like Unity's.
      if (propertyPath === 'm_Materials.Array.size' && node.renderer) {
        const n = numVal();
        if (n !== undefined && n >= 0) {
          const target = Math.floor(n);
          if (target < node.renderer.materialGuids.length) {
            node.renderer.materialGuids.length = target;
          } else {
            while (node.renderer.materialGuids.length < target) {
              node.renderer.materialGuids.push('');
            }
          }
        }
        break;
      }

      // m_Materials.Array.data[N]: prefab variants (especially those built on
      // top of imported models) routinely override the source prefab's
      // MeshRenderer.materials slots. The new material's guid lives on the
      // modification's `objectReference` pointer, not on `value`.
      const matArrayMatch = /^m_Materials\.Array\.data\[(\d+)\]$/.exec(propertyPath);
      if (matArrayMatch && node.renderer) {
        const index = Number(matArrayMatch[1]);
        const newGuid = guidOf(objectReference);
        if (Number.isFinite(index) && index >= 0 && newGuid) {
          // Pad the array with empty slots if the mod targets a higher index
          // than what the source prefab surfaced; keeps ordering stable so
          // the client's "first valid material" lookup stays predictable.
          while (node.renderer.materialGuids.length <= index) {
            node.renderer.materialGuids.push('');
          }
          node.renderer.materialGuids[index] = newGuid;
        }
      }
      break;
    }
  }
}

async function resolveOverriddenMeshNames(roots: GameObjectNode[]): Promise<void> {
  // Gather (node, meshGuid, meshFileID) tuples once so we batch the meta
  // lookups — the same FBX is usually referenced by many renderers.
  const pending: { node: GameObjectNode; guid: string; fileID: string }[] = [];
  const walk = (n: GameObjectNode) => {
    if (n.renderer && n.renderer.meshGuid && n.renderer.meshFileID) {
      pending.push({ node: n, guid: n.renderer.meshGuid, fileID: n.renderer.meshFileID });
    }
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  if (pending.length === 0) return;

  // getFbxMeshInfo is cached per-guid so hitting it N times for N instances
  // is effectively one lookup per unique FBX.
  for (const p of pending) {
    try {
      const info = await getFbxMeshInfo(p.guid);
      const name = info?.meshNames.get(p.fileID);
      if (name) {
        p.node.renderer!.meshSubmeshName = name;
      }
    } catch {
      // best-effort; leaving submeshName undefined lets the client fall back
      // to its own name matching, which is strictly no worse than before.
    }
    // Keep the displayed FBX filename aligned with the (possibly overridden)
    // meshGuid so the inspector reports `GeneralWall_Pillar_SM.fbx` instead
    // of the source prefab's original `StreetWall_SM.fbx`.
    const rec = assetIndex.get(p.guid);
    if (rec?.absPath) {
      const slash = rec.absPath.lastIndexOf('/');
      const backslash = rec.absPath.lastIndexOf('\\');
      const sepIdx = Math.max(slash, backslash);
      const base = sepIdx >= 0 ? rec.absPath.slice(sepIdx + 1) : rec.absPath;
      if (base) p.node.renderer!.meshName = base;
    }
  }
}

/**
 * Flag collider-only subtrees so the viewer can suppress them by default.
 * Two orthogonal signals feed the heuristic:
 *
 *   1. A GameObject whose OWN name normalises to a collider-style token
 *      (`_col`, `_Col`, `_collider`, or the bare name `Collider` / `colliders`).
 *      These are the duplicate visual meshes level designers place alongside
 *      the real prop so PhysX has watertight geometry (e.g. `DM_SPWall_A_col`).
 *
 *   2. A GameObject whose ANCESTOR path contains a pure-collider group
 *      (e.g. `ENV_DesertMine/collider/DM_SPWall_A_col`). Anything under such
 *      a group inherits the flag — useful for scenes that nest an entire
 *      sub-hierarchy of collider proxies without annotating each leaf.
 *
 * The function is intentionally conservative: we only match names that
 * SURROUND the `col`/`collider` token with a separator (`_`, end-of-name, or
 * a digit), so genuine props like `Column_04` or `Colonnade` are NOT treated
 * as colliders. A false negative just leaves a collider visible; a false
 * positive would silently hide a real prop, which is much more confusing.
 */
function markColliderTrees(roots: GameObjectNode[]): void {
  // Matches names that identify the GO itself as a collider instance.
  //   Accepts:  DM_Foo_col, DM_Foo_Col, Foo_collider, Foo_Collider
  //   Accepts:  Collider, colliders (standalone group names)
  // Rejects:   Column, Colonnade, Color_Chart (substrings that share letters)
  const COLLIDER_NAME = /(?:^|_)(?:col|Col|collider|Collider)(?:$|_|\d)/;
  const GROUP_NAME = /^(?:collider|Collider|Colliders|colliders)$/;

  const visit = (node: GameObjectNode, ancestorFlagged: boolean): void => {
    const selfMatch =
      COLLIDER_NAME.test(node.name) || GROUP_NAME.test(node.name);
    const flagged = ancestorFlagged || selfMatch;
    if (flagged) node.isCollider = true;
    for (const c of node.children) visit(c, flagged);
  };
  for (const r of roots) visit(r, false);
}

/**
 * Walk the expanded scene tree and, for every renderer whose `meshFileID`
 * resolves to a scene-local `!u!43 Mesh` doc (ProBuilder / editor-authored
 * inline geometry), migrate the reference from the cross-FBX shape
 * (`meshGuid`+`meshFileID`) to the inline shape (`inlineMeshFileID`) and
 * register the doc for decoding.
 *
 * This fixes ProBuilder-heavy scenes like `Test_0323.unity` (Mirama_01):
 * the scene authors ~2200 inline Mesh docs, but Unity doesn't reference them
 * from top-level MeshFilters — instead every instance is a PrefabInstance
 * whose `m_Modification.m_Mesh` override points at a scene-local fileID.
 * Without this pass, `extractRenderer`'s inline-mesh detector only fires on
 * the handful of top-level MeshFilters (~7 in that scene) and we ship a
 * tree whose renderers all still point at the prefab's fallback FBX guid,
 * so the client renders every Wall_4m_* as the prefab's default geometry
 * instead of the authored ProBuilder shape.
 */
function migrateInlineMeshOverrides(
  roots: GameObjectNode[],
  byFileID: Map<string, RawDoc>,
  referencedInlineMeshes: Set<string>,
): void {
  const visit = (n: GameObjectNode): void => {
    const r = n.renderer;
    if (r && !r.meshGuid && r.meshFileID) {
      const doc = byFileID.get(r.meshFileID);
      if (doc && doc.header.classId === CLASS_MESH) {
        // Promote the scene-local fileID into the dedicated inline slot so
        // the client treats it as ProBuilder geometry, and flag it for the
        // decode pass that ships inline meshes to the wire.
        r.inlineMeshFileID = r.meshFileID;
        r.meshFileID = undefined;
        r.meshSubmeshName = undefined;
        referencedInlineMeshes.add(r.inlineMeshFileID);
      }
    }
    for (const c of n.children) visit(c);
  };
  for (const r of roots) visit(r);
}

function countGameObjects(n: GameObjectNode): number {
  let c = 1;
  for (const ch of n.children) c += countGameObjects(ch);
  return c;
}
function countRenderers(n: GameObjectNode): number {
  let c = n.renderer ? 1 : 0;
  for (const ch of n.children) c += countRenderers(ch);
  return c;
}
function countLights(n: GameObjectNode): number {
  let c = n.light ? 1 : 0;
  for (const ch of n.children) c += countLights(ch);
  return c;
}
function countCameras(n: GameObjectNode): number {
  let c = n.camera ? 1 : 0;
  for (const ch of n.children) c += countCameras(ch);
  return c;
}
