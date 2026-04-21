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

  occlusionMapGuid: string | null;
  occlusionStrength: number;

  emissionColor: [number, number, number];
  emissionMapGuid: string | null;

  renderMode: 'Opaque' | 'Cutout' | 'Transparent' | 'Fade';
  alphaCutoff: number;
  doubleSided: boolean;
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

  // Retry on 409 `lfs-pointer`. The server returns 409 immediately when
  // the scene `.unity` is still a Git LFS pointer and a background fetch
  // is in flight; polling gives it time to land on disk without blowing
  // the platform's reverse-proxy timeout (~30 s) that would otherwise
  // surface as a 502 to the user. Budget is generous (~75 s total) so
  // the very first request after a cold deploy — which may need to
  // wait for a fresh LFS download AND for the repo-level URL-rewrite
  // config to get applied — still has a chance to finish on the
  // user's first click instead of bouncing them to an error page.
  const MAX_ATTEMPTS = 30;
  const RETRY_DELAY_MS = 2500;
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
    if (res.status !== 409) {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}: ${text}`);
      }
      return (await res.json()) as SceneJson | UnityExport;
    }
    // 409 → peek at the server's hint so the UI can surface "LFS fetch
    // in progress" (or whatever lazyLfs decided to say) instead of a
    // generic spinner.
    try {
      const body = (await res.clone().json()) as { hint?: string };
      if (body && typeof body.hint === 'string') lastHint = body.hint;
    } catch {
      // body wasn't JSON — ignore, keep the previous hint.
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
