/**
 * Matches `SceneCategory` on the server:
 * - `production` — shipping scene under `GameContents/...`
 * - `dev-only`  — sandbox scene under `DevAssets(not packed)/_DevArt/...`
 */
export type SceneCategory = 'production' | 'dev-only';

export interface SceneListItem {
  name: string;
  relPath: string;
  category: SceneCategory;
}

export interface InlineMeshData {
  /** Base64-encoded Float32Array of XYZ positions (already in Three.js space:
   *  X is flipped server-side so the client can use the buffer as-is). */
  positionsB64: string;
  /** Base64-encoded Uint32Array of triangle indices (winding reversed). */
  indicesB64: string;
  vertexCount: number;
  indexCount: number;
  aabb?: {
    min: [number, number, number];
    max: [number, number, number];
  };
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
  /** Scene-embedded Mesh documents (ProBuilder, procedural, …), keyed by
   *  Unity fileID. `renderer.inlineMeshFileID` points into this map. */
  inlineMeshes: Record<string, InlineMeshData>;
  /** Resolved PBR materials by GUID. `renderer.materialGuids[i]` looks up
   *  a MaterialJson entry here. May be empty when the scene references only
   *  materials that don't exist in the repo. */
  materials: Record<string, MaterialJson>;
  /**
   * Per-FBX `ModelImporter.externalObjects` material remap:
   * `fbxExternalMaterials[fbxGuid][embeddedMaterialName] = matGuid`. Used
   * by the renderer to fill MeshRenderer slots the scene left empty — by
   * pairing these with the FBX-internal material names the FBXLoader reads
   * out of the binary, we reproduce what Unity does at edit time.
   */
  fbxExternalMaterials: Record<string, Record<string, string>>;
  /**
   * Project-wide `.mat` name→guid lookup. Reproduces Unity's
   * `MaterialSearch.RecursiveUp` — when an FBX embeds a material name that
   * isn't in `externalObjects`, the renderer looks up the matching
   * `<name>.mat` asset by this index.
   */
  materialNameIndex: Record<string, string>;
  /** Scene-level render settings — ambient, fog, skybox reference. */
  renderSettings: SceneRenderSettings;
}

export interface MaterialJson {
  guid: string;
  name: string;
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
  /** When true the smoothness value lives in `_BaseMap.a` (URP's
   *  `_SmoothnessTextureChannel=1`), otherwise in
   *  `_MetallicGlossMap.a` (URP default). */
  smoothnessFromAlbedoAlpha: boolean;

  occlusionMapGuid: string | null;
  occlusionStrength: number;

  emissionColor: [number, number, number];
  emissionMapGuid: string | null;

  /** URP detail overlay maps and their associated intensity scalars.
   *  Applied via `onBeforeCompile` patch on `MeshStandardMaterial`. */
  detailAlbedoMapGuid: string | null;
  detailNormalMapGuid: string | null;
  heightMapGuid: string | null;
  detailAlbedoScale: number;
  detailNormalScale: number;
  heightScale: number;

  renderMode: 'Opaque' | 'Cutout' | 'Transparent' | 'Fade';
  alphaCutoff: number;
  doubleSided: boolean;

  /** Per-material reflection cubemap GUID. When non-null, the client
   *  loads this texture (EXR / HDR equirect or cubemap), PMREM-filters
   *  it, and binds it as `material.envMap`. This is how Aegis/BasicLit's
   *  `_EnvCubemap` slot survives the URP -> three.js translation. */
  reflectionCubemapGuid: string | null;
  /** Scalar multiplier bound to `material.envMapIntensity`. From
   *  `_ReflectionIntensity`. */
  reflectionIntensity: number;
  /** Additional roughness bias for env-map sampling. Bigger = softer
   *  reflections. Maps onto `material.userData.roughnessDistortion`
   *  which the URP patch applies when sampling the reflection LOD. */
  roughnessDistortion: number;
  /** True iff the source material explicitly turned reflections on. */
  useReflection: boolean;
}

export interface SceneRenderSettings {
  ambientMode: 'Skybox' | 'Trilight' | 'Flat' | 'Custom';
  ambientSkyColor: [number, number, number, number];
  ambientEquatorColor: [number, number, number, number];
  ambientGroundColor: [number, number, number, number];
  ambientLight: [number, number, number, number];
  ambientIntensity: number;

  fogEnabled: boolean;
  fogMode: 'Linear' | 'Exponential' | 'ExponentialSquared';
  fogColor: [number, number, number, number];
  fogDensity: number;
  fogStart: number;
  fogEnd: number;

  indirectIntensity: number;
  skyboxMaterialGuid?: string;
  /** Decoded skybox material (populated by `parseSkyboxByGuid` on the
   *  server). Undefined when the scene has no skybox or when the
   *  referenced `.mat` couldn't be resolved — in that case the client
   *  falls back to a neutral RoomEnvironment IBL probe. */
  skybox?: SkyboxJson;
}

export type SkyboxKind = 'cubemap' | 'sixsided' | 'panoramic' | 'procedural' | 'unknown';

export interface SkyboxJson {
  guid: string;
  shaderName?: string;
  kind: SkyboxKind;

  cubemapGuid?: string;
  panoramicGuid?: string;
  /** Six-sided layout: [front, back, left, right, up, down]. */
  sixSidedGuids?: [
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
  ];

  tint?: [number, number, number];
  exposure?: number;
  rotationDeg?: number;

  sunSize?: number;
  skyTint?: [number, number, number];
  groundColor?: [number, number, number];
  atmosphereThickness?: number;
}

export interface GameObjectNode {
  name: string;
  active: boolean;
  fileID: string;
  /** Server-computed hint: this GameObject lives under a physics-only
   *  hierarchy (name or ancestor matches `_col` / `collider`). The viewer
   *  hides these sub-trees by default; toggled on via the HUD for physics
   *  debugging. See `markColliderTrees` in `sceneParser.ts`. */
  isCollider: boolean;
  transform: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    eulerHint: [number, number, number];
    scale: [number, number, number];
    /** When true, the server's scene YAML authoritatively set this node's
     *  rotation (via a Transform doc or a PrefabInstance `m_LocalRotation.*`
     *  modification). When false, the node inherits whatever rotation its
     *  source prefab exposes — and for synth'd FBX model prefabs that means
     *  we still need to apply the FBX file's own root rotation (typically
     *  a 3ds Max Z→Y-up PreRotation) at render time. */
    hasRotationOverride: boolean;
  };
  renderer?: {
    /** Mirror of Unity's `MeshRenderer.m_Enabled`. When false, the viewer
     *  suppresses the draw unless the "Show colliders / disabled" HUD
     *  toggle is on. */
    enabled: boolean;
    color: [number, number, number, number];
    mainTexGuid?: string;
    materialGuids: string[];
    meshGuid?: string;
    meshName?: string;
    meshFileID?: string;
    meshSubmeshName?: string;
    builtinMesh?: 'Cube' | 'Sphere' | 'Cylinder' | 'Capsule' | 'Plane' | 'Quad';
    /** Key into `SceneJson.inlineMeshes` when the MeshFilter references a
     *  scene-embedded `!u!43 Mesh` document (e.g. ProBuilder geometry). */
    inlineMeshFileID?: string;
    /** When true, the renderer is the synthesized root of a model-prefab
     *  PrefabInstance (an FBX dragged directly into a Unity scene). The
     *  server can't walk the FBX's internal hierarchy itself, so it asks
     *  the client to re-inflate one mesh per FBX node — otherwise levels
     *  authored as a single `.fbx` (e.g. `F_Sample.fbx` in Mirama Factory)
     *  collapse to just the first sub-mesh and everything else disappears.
     *  Cleared server-side when an instance-level `m_Mesh` modification
     *  overrides the binding to a specific sub-mesh. */
    renderAllFbxMeshes?: boolean;
    /** FBX sub-mesh names the server wants the client to skip while
     *  expanding this renderer's FBX. Populated when the scene /
     *  outer-prefab `m_RemovedGameObjects` list prunes Unity-hashed
     *  fileIDs that belong to specific sub-objects inside the FBX
     *  (resolved via the FBX's `.meta` `internalIDToNameTable`). Only
     *  consulted when `renderAllFbxMeshes` is true. */
    removedFbxSubmeshNames?: string[];
    /** Per-sub-object Transform overrides the client should apply in
     *  place of the FBX's own parent-local values when expanding this
     *  FBX (only consulted when `renderAllFbxMeshes` is true). Keyed by
     *  the FBX sub-object name exactly as FBXLoader reports it
     *  (`Object3D.name`). Values are ALREADY in three's coord system
     *  — position x flipped, quaternion y/z negated — so the client
     *  can pass them straight into `<group position quaternion scale>`
     *  without re-converting.
     *
     *  Motivating case: Factory_New_B keeps the full F_Sample.fbx
     *  prefab body and authors per-sub-transform rotations (e.g.
     *  `LT_FactoryCon_A.009` → 90° Z). Without this field every
     *  rotated piece rendered at the FBX-default orientation. */
    subMeshOverrides?: Record<string, {
      position?: [number, number, number];
      quaternion?: [number, number, number, number];
      scale?: [number, number, number];
    }>;
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
  /** Reflection Probe (Unity classId 215). Position is implicit — the
   *  client reads it off the enclosing group's `matrixWorld` after
   *  mount, which is cheaper than recomputing a world transform
   *  server-side just for probes. */
  reflectionProbe?: {
    mode: 'Baked' | 'Custom' | 'Realtime' | 'Unknown';
    boxSize: [number, number, number];
    boxOffset: [number, number, number];
    boxProjection: boolean;
    intensity: number;
    blendDistance: number;
    importance: number;
    customBakedTextureGuid?: string;
  };
  children: GameObjectNode[];
}

// ---------------------------------------------------------------------
// Base-URL plumbing for reverse-proxied deploys
// ---------------------------------------------------------------------
//
// When Aegisgram is embedded in a platform that mounts us under a
// sub-path (e.g. `/api/v1/ai-tools/21/proxy/` on UAAutoTool), every
// absolute path like `/api/health` otherwise resolves to the host root
// and misses the proxy. Vite's `import.meta.env.BASE_URL` carries the
// mount prefix determined at build time via `AEGISGRAM_APP_BASE`
// (defaults to `/`). These helpers join that prefix to any
// leading-slash path the caller hands us, and also build the ws URL.
const RAW_BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

/** Resolve an API path (e.g. `/api/health`) against the deploy base. */
export function apiUrl(path: string): string {
  if (!path.startsWith('/')) path = `/${path}`;
  return `${RAW_BASE}${path}`;
}

/** Resolve a WebSocket path (e.g. `/ws/multiplayer`) against the deploy
 *  base, using the current page scheme/host. */
export function wsUrl(path: string): string {
  if (!path.startsWith('/')) path = `/${path}`;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}${RAW_BASE}${path}`;
}

/** Public read-only accessor so the router can mirror the deploy base. */
export const APP_BASE: string = RAW_BASE || '/';

/** Resolve an asset that lives in `web/public/` (served as-is by Vite
 *  under the configured `base`). Vite rewrites absolute `/foo.png` in
 *  `index.html` at build time, but JSX string literals like
 *  `<img src="/foo.png">` are not processed — they stay absolute and
 *  miss the reverse-proxy mount. Use `publicAsset('/foo.png')` in JSX
 *  (or anywhere the URL is constructed at runtime) to prepend the
 *  deploy base. Leading slash optional. */
export function publicAsset(name: string): string {
  const trimmed = name.replace(/^\/+/, '');
  // import.meta.env.BASE_URL always ends with '/' per Vite's contract,
  // so we can concatenate safely.
  return `${import.meta.env.BASE_URL}${trimmed}`;
}

export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export function textureUrl(guid: string): string {
  return apiUrl(`/api/assets/texture?guid=${encodeURIComponent(guid)}`);
}

export async function fetchLevels(): Promise<SceneListItem[]> {
  return apiGet<SceneListItem[]>('/api/levels');
}

/**
 * Hint to the server that the user is about to open a scene — typically
 * fired on hover / focus of a thumbnail in the list view. The server
 * starts streaming the scene YAML + its LFS-tracked dependencies into
 * cache in the background so the actual click lands against warm data.
 *
 * Best-effort: aborts silently on any network / server error, never
 * retries, and is deliberately a fire-and-forget `fetch` (we throw
 * away the promise instead of awaiting). Multiple hover events for
 * the same scene collapse to one batch inside the server's lazyLfs
 * deduplication layer.
 */
export function warmLevel(relPath: string): void {
  if (!relPath) return;
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  const url = apiUrl(`/api/levels/${encoded}/warm`);
  // We don't `await` and don't `.catch()` because `fetch`'s rejection
  // is already unhandled — browsers will log it but not break UX.
  try {
    void fetch(url, { method: 'POST', keepalive: true });
  } catch {
    // Ignore; warming is purely an optimisation
  }
}

/**
 * Progress update emitted by `fetchScene` while the server is still
 * pulling the scene's LFS blob. `phase` is 'requesting' while the HTTP
 * call is in flight and 'waiting' during the inter-attempt sleep.
 * UI uses these to animate a determinate-looking overlay on top of an
 * inherently indeterminate LFS fetch.
 */
export interface SceneLoadProgress {
  attempt: number;
  maxAttempts: number;
  /** Total fetchScene retry budget, in ms (for rendering a progress bar). */
  totalBudgetMs: number;
  elapsedMs: number;
  /** Human-readable hint from the server's 409 body (`hint` field), if any. */
  hint?: string;
  phase: 'requesting' | 'waiting';
}

export async function fetchScene(
  relPath: string,
  onProgress?: (p: SceneLoadProgress) => void,
): Promise<SceneJson | UnityExport> {
  // relPath can contain slashes; each segment must be encoded individually so
  // express sees `/api/levels/<relPath>` correctly.
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  const url = apiUrl(`/api/levels/${encoded}`);

  // Retry on the server's `status:'pending'` signal. The server holds
  // the request for up to ~12 s while it pulls the scene's LFS blob
  // synchronously; if it still isn't on disk it returns 200 with
  // `{status:'pending', hint, ...}` and we retry — each attempt
  // typically lands within another cycle because the underlying
  // git-lfs fetch is still running in the background and subsequent
  // attempts just join the in-flight promise.
  //
  // We use 200 + JSON sentinel rather than the older 409 status so
  // platform reverse proxies (e.g. UAAutoTool) don't count cold-open
  // retry loops as errors in their dashboards.
  //
  // Budget tuning: 12 attempts × ~50 s (45 s server wait + 5 s
  // inter-attempt sleep) ≈ 10 min of total patience. That covers
  // pathological cold loads (huge scene on cold cache + concurrent
  // sync holding the repo lock) while keeping each cycle long enough
  // that retries are rare — typical cold load finishes on attempt 1.
  const MAX_ATTEMPTS = 12;
  const RETRY_DELAY_MS = 5_000;
  const TOTAL_BUDGET_MS = MAX_ATTEMPTS * RETRY_DELAY_MS;
  const startedAt = Date.now();
  let lastHint: string | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    onProgress?.({
      attempt: attempt + 1,
      maxAttempts: MAX_ATTEMPTS,
      totalBudgetMs: TOTAL_BUDGET_MS,
      elapsedMs: Date.now() - startedAt,
      hint: lastHint,
      phase: 'requesting',
    });
    const res = await fetch(url);
    // Legacy 409 path is kept for back-compat with older server
    // builds — newer servers respond 200 + `status:'pending'` JSON,
    // which we handle below by inspecting the body.
    if (!res.ok && res.status !== 409) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      // non-JSON: definitely not a pending sentinel, fall through.
    }
    const pending =
      res.status === 409 ||
      (body !== null &&
        typeof body === 'object' &&
        (body as { status?: unknown }).status === 'pending');
    if (!pending) {
      return (await res.json()) as SceneJson | UnityExport;
    }
    if (body && typeof body === 'object') {
      const h = (body as { hint?: unknown }).hint;
      if (typeof h === 'string') lastHint = h;
    }
    if (attempt === MAX_ATTEMPTS - 1) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Scene still not available after ${MAX_ATTEMPTS} attempts (LFS fetch did not complete): ${text}`,
      );
    }
    onProgress?.({
      attempt: attempt + 1,
      maxAttempts: MAX_ATTEMPTS,
      totalBudgetMs: TOTAL_BUDGET_MS,
      elapsedMs: Date.now() - startedAt,
      hint: lastHint,
      phase: 'waiting',
    });
    await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  throw new Error('unreachable');
}

// ===========================================================================
// Unity batch export — high-fidelity renderer format
// ===========================================================================
//
// Produced by the Unity Editor script (LevelViewerExporter.cs) running in
// batchmode. Coordinate system already matches three.js (X flipped, indices
// winding-reversed) so clients can construct BufferGeometries directly from
// the base64 buffers without further transform.

export interface UnityExport {
  format: 'unity-export@1';
  generator: string;
  exportedAt: string;
  scenePath: string;
  sceneName: string;
  render: UnityRenderSettings;
  nodes: UnityNode[];
  meshes: Record<string, UnityMesh>;
  materials: Record<string, UnityMaterial>;
  textureGuids: string[];
}

export interface UnityRenderSettings {
  ambientMode: string;
  ambientSkyColor: [number, number, number, number] | null;
  ambientEquatorColor: [number, number, number, number] | null;
  ambientGroundColor: [number, number, number, number] | null;
  ambientLight: [number, number, number, number] | null;
  ambientIntensity: number;
  fogEnabled: boolean;
  fogColor: [number, number, number, number] | null;
  /** "Linear" | "Exponential" | "ExponentialSquared" */
  fogMode: string;
  fogDensity: number;
  fogStart: number;
  fogEnd: number;
  skyboxMaterialGuid: string | null;
  skyboxShaderName: string | null;
}

export interface UnityNode {
  id: number;
  parentId: number;
  name: string;
  active: boolean;
  layer: number;
  tag: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  mesh?: UnityMeshRef;
  light?: UnityLight;
  camera?: UnityCamera;
}

export interface UnityMeshRef {
  meshId: string;
  materialIds: (string | null)[];
  castShadows: string;
  receiveShadows: boolean;
  lightmapIndex: number;
  lightmapScaleOffset: [number, number, number, number];
}

export interface UnityLight {
  /** Unity's LightType: "Directional" | "Point" | "Spot" | "Area" | "Disc" */
  type: string;
  color: [number, number, number, number];
  intensity: number;
  range: number;
  spotAngle: number;
  innerSpotAngle: number;
  /** "None" | "Hard" | "Soft" */
  shadows: string;
  shadowStrength: number;
  colorTemperature: number;
  useColorTemperature: boolean;
  bounce: number;
  /** "Realtime" | "Mixed" | "Baked" */
  lightmapBakeType: string;
}

export interface UnityCamera {
  fov: number;
  near: number;
  far: number;
  orthographic: boolean;
  orthoSize: number;
  clearFlags: string;
  backgroundColor: [number, number, number, number];
}

export interface UnityMesh {
  name: string;
  sourceAssetPath: string | null;
  isBaked: boolean;
  vertexCount: number;
  indexCount: number;
  positionsB64: string;
  normalsB64: string | null;
  tangentsB64: string | null;
  uv0B64: string | null;
  uv1B64: string | null;
  colorsB64: string | null;
  indicesB64: string;
  aabbMin: [number, number, number];
  aabbMax: [number, number, number];
  submeshes: UnitySubmesh[];
}

export interface UnitySubmesh {
  start: number;
  count: number;
  topology: string;
}

export interface UnityMaterial {
  name: string;
  guid: string | null;
  shader: string | null;
  renderMode: 'Opaque' | 'Cutout' | 'Transparent' | 'Fade';
  cull: 'Back' | 'Front' | 'Off';
  baseColor: [number, number, number, number];
  baseMapGuid: string | null;
  baseMapTiling: [number, number] | null;
  baseMapOffset: [number, number] | null;
  normalMapGuid: string | null;
  normalScale: number;
  metallic: number;
  smoothness: number;
  metallicGlossMapGuid: string | null;
  smoothnessFromAlbedoAlpha: boolean;
  occlusionMapGuid: string | null;
  occlusionStrength: number;
  emissionColor: [number, number, number, number];
  emissionMapGuid: string | null;
  alphaCutoff: number;
  doubleSided: boolean;
  extra?: Record<string, unknown>;
}

export function isUnityExport(scene: SceneJson | UnityExport): scene is UnityExport {
  return (scene as UnityExport).format === 'unity-export@1';
}

export interface BatchStatus {
  state: 'idle' | 'running' | 'success' | 'failed';
  relPath?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  outPath?: string;
  logPath?: string;
  error?: string;
}

export async function triggerRebake(relPath: string): Promise<{ queued: boolean; status: BatchStatus }> {
  return apiPost(`/api/rebake?relPath=${encodeURIComponent(relPath)}`);
}

export async function fetchRebakeStatus(): Promise<BatchStatus> {
  return apiGet<BatchStatus>('/api/rebake/status');
}
