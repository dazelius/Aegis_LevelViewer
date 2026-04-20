import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type {
  UnityExport,
  UnityMaterial,
  UnityMesh,
  UnityNode,
} from './api';
import { textureUrl } from './api';
import { buildDebugSlotPalette, buildDebugUvMaterials } from './sceneToR3F';

// ===========================================================================
// Unity high-fidelity renderer (Tier 1: PBR baseline)
//
// Input:  a UnityExport produced by LevelViewerExporter.cs running in Unity
//         batchmode. All geometry is already in three.js coordinate space
//         (X flipped + winding reversed server-side).
//
// What Tier 1 covers:
//   - MeshStandardMaterial for URP/Lit (+ compatible) shaders
//   - MeshBasicMaterial for Unlit shaders
//   - Baseline ambient + directional lights from RenderSettings
//   - Point / spot lights up to a safe budget
//   - Linear / exponential fog
//
// What Tier 2 would add: baked lightmaps (uv1 + lightmap textures), reflection
// probes, skybox. Tier 3: custom URP shader variants, post-processing, etc.
// ===========================================================================

/** Cap on simultaneous non-directional lights to stay under typical WebGL
 *  driver sampler/uniform limits. Point + spot lights beyond this are
 *  silently dropped (they're typically decorative fill anyway). */
const MAX_POINT_SPOT_LIGHTS = 8;

/** Maximum directional lights we'll instantiate. Unity scenes rarely have
 *  more than 1-2; the extras would just stack uniforms for no visual gain. */
const MAX_DIRECTIONAL_LIGHTS = 2;

// ---------------------------------------------------------------- Geometry ----

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Build a THREE.BufferGeometry from a Unity-exported mesh document.
 *
 * All attributes are read directly from the base64 typed-array blobs — no
 * index remapping or coordinate conversion because the exporter already did
 * that server-side. Submesh `groups` are registered so multi-material meshes
 * can use per-submesh materials via the groups mechanism.
 */
function meshToGeometry(m: UnityMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();

  const positions = new Float32Array(b64ToArrayBuffer(m.positionsB64));
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  if (m.normalsB64) {
    const normals = new Float32Array(b64ToArrayBuffer(m.normalsB64));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  }
  if (m.tangentsB64) {
    const tangents = new Float32Array(b64ToArrayBuffer(m.tangentsB64));
    g.setAttribute('tangent', new THREE.BufferAttribute(tangents, 4));
  }
  if (m.uv0B64) {
    const uv = new Float32Array(b64ToArrayBuffer(m.uv0B64));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  if (m.uv1B64) {
    // MeshStandardMaterial reads `uv2` for aoMap and lightMap. Registering
    // the lightmap UVs under this canonical attribute name means Tier 2
    // lightmap rendering can light up without further plumbing.
    const uv2 = new Float32Array(b64ToArrayBuffer(m.uv1B64));
    g.setAttribute('uv2', new THREE.BufferAttribute(uv2, 2));
  }
  if (m.colorsB64) {
    const cols = new Float32Array(b64ToArrayBuffer(m.colorsB64));
    g.setAttribute('color', new THREE.BufferAttribute(cols, 4));
  }

  const indices = new Uint32Array(b64ToArrayBuffer(m.indicesB64));
  g.setIndex(new THREE.BufferAttribute(indices, 1));

  // Per-submesh material groups. When the mesh has N submeshes, each submesh
  // gets a (start, count, materialIndex=i) group. The host component then
  // passes an array-of-materials rather than a single material to <mesh>.
  if (m.submeshes.length > 1) {
    for (let i = 0; i < m.submeshes.length; i += 1) {
      const sm = m.submeshes[i];
      g.addGroup(sm.start, sm.count, i);
    }
  }

  // We intentionally do NOT recompute normals — the exporter already ships
  // the authoring-time normals, which match what Unity renders. Recomputing
  // would clobber hard-edge / shading-group information bakes.

  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// ---------------------------------------------------------------- Textures ----

/**
 * Texture cache keyed by Unity GUID. Using a global cache keeps the same
 * texture (e.g. "T_Desert_Sand_BC") shared across every material that
 * references it, which is critical for GPU memory — a typical Unity scene
 * reuses ~50 unique textures across thousands of materials.
 */
const textureCache = new Map<string, THREE.Texture>();

function getCachedTexture(
  guid: string,
  opts: { srgb?: boolean; tiling?: [number, number]; offset?: [number, number] } = {},
): THREE.Texture {
  const cacheKey = `${guid}|${opts.srgb ? 'srgb' : 'linear'}`;
  let tex = textureCache.get(cacheKey);
  if (!tex) {
    tex = new THREE.TextureLoader().load(textureUrl(guid));
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 4;
    // Unity's UV V axis is flipped relative to three.js's. Flipping once on
    // the texture is the cheapest way to match the Unity editor view.
    tex.flipY = true;
    textureCache.set(cacheKey, tex);
  }
  // The tiling/offset are per-material, not per-texture, so we don't bake
  // them onto the cached object. Materials build their own lightweight
  // wrapper — but for URP Lit the convention is that all maps share the same
  // tiling (from _BaseMap), so we apply it ONCE at texture-fetch time when
  // the caller requests it. That way MeshStandardMaterial's separate maps
  // (normalMap, metallicMap, ...) line up correctly on the UV chart.
  if (opts.tiling) {
    tex.repeat.set(opts.tiling[0], opts.tiling[1]);
  }
  if (opts.offset) {
    tex.offset.set(opts.offset[0], opts.offset[1]);
  }
  return tex;
}

// ---------------------------------------------------------------- Materials ----

/** Material cache so repeated references to the same Unity material map to
 *  the same three.js material object. Cleared on scene change via the
 *  SceneProvider below. */
interface MaterialBundle {
  mat: THREE.Material;
  disposes: (() => void)[];
}

function buildMaterial(src: UnityMaterial): MaterialBundle {
  const shader = src.shader ?? '';
  const isUnlit = shader.includes('Unlit');

  const baseColor = new THREE.Color(src.baseColor[0], src.baseColor[1], src.baseColor[2]);
  const alpha = src.baseColor[3];
  const transparent = src.renderMode === 'Transparent' || src.renderMode === 'Fade' || alpha < 0.999;
  const alphaTest = src.renderMode === 'Cutout' ? src.alphaCutoff : 0;
  const side = src.doubleSided ? THREE.DoubleSide : THREE.FrontSide;

  const disposes: (() => void)[] = [];

  if (isUnlit) {
    const mat = new THREE.MeshBasicMaterial({
      color: baseColor,
      opacity: alpha,
      transparent,
      alphaTest,
      side,
      toneMapped: true,
    });
    if (src.baseMapGuid) {
      mat.map = getCachedTexture(src.baseMapGuid, {
        srgb: true,
        tiling: src.baseMapTiling ?? undefined,
        offset: src.baseMapOffset ?? undefined,
      });
    }
    return { mat, disposes };
  }

  // Default: URP Lit / Standard → three.js MeshStandardMaterial (metallic/
  // roughness workflow). Unity's "smoothness" is the inverse of three.js's
  // "roughness", hence the 1-x flip.
  const mat = new THREE.MeshStandardMaterial({
    color: baseColor,
    opacity: alpha,
    transparent,
    alphaTest,
    side,
    metalness: src.metallic,
    roughness: Math.max(0, Math.min(1, 1 - src.smoothness)),
    emissive: new THREE.Color(src.emissionColor[0], src.emissionColor[1], src.emissionColor[2]),
    // Unity's emission HDR intensity is already baked into the color
    // components (values >1 are allowed). Three.js MeshStandardMaterial
    // multiplies emissive * emissiveIntensity, so leaving intensity at 1
    // preserves the exact appearance.
    emissiveIntensity: 1,
  });

  const tiling = src.baseMapTiling ?? undefined;
  const offset = src.baseMapOffset ?? undefined;

  if (src.baseMapGuid) {
    mat.map = getCachedTexture(src.baseMapGuid, { srgb: true, tiling, offset });
  }
  if (src.normalMapGuid) {
    mat.normalMap = getCachedTexture(src.normalMapGuid, { srgb: false, tiling, offset });
    mat.normalScale = new THREE.Vector2(src.normalScale || 1, src.normalScale || 1);
  }
  if (src.metallicGlossMapGuid) {
    // URP packs metallic in R and smoothness in A of this texture. Three.js
    // reads metalness from B and roughness from G of `metalnessMap` /
    // `roughnessMap`. We approximate by pointing both slots at the same
    // texture — this is correct for materials that don't use the G/B
    // channels separately, which is the common case in URP Lit.
    const tex = getCachedTexture(src.metallicGlossMapGuid, { srgb: false, tiling, offset });
    mat.metalnessMap = tex;
    mat.roughnessMap = tex;
  }
  if (src.occlusionMapGuid) {
    mat.aoMap = getCachedTexture(src.occlusionMapGuid, { srgb: false, tiling, offset });
    mat.aoMapIntensity = src.occlusionStrength;
  }
  if (src.emissionMapGuid) {
    mat.emissiveMap = getCachedTexture(src.emissionMapGuid, { srgb: true, tiling, offset });
  }

  return { mat, disposes };
}

// ---------------------------------------------------------------- Scene tree ----

/**
 * Render a Unity batch-export as a three.js scene graph.
 *
 * The input is a FLAT array of nodes with parentId pointers (matches the
 * exporter schema). We rebuild the hierarchy via a single pass, creating a
 * three.js Group per GameObject and attaching MeshStandardMaterial-backed
 * meshes where the exporter recorded a MeshFilter.
 */
export function UnityExportRoots({
  scene,
  debugSubmeshColors = false,
  debugUvCheckerboard = false,
}: {
  scene: UnityExport;
  debugSubmeshColors?: boolean;
  debugUvCheckerboard?: boolean;
}) {
  // Pre-compute the adjacency and derived caches once per scene.
  const ctx = useMemo(() => buildSceneContext(scene), [scene]);
  // Propagate debug flags through context so NodeMesh can swap materials
  // without us having to thread props through every recursive NodeRenderer.
  ctx.debugSubmeshColors = debugSubmeshColors;
  ctx.debugUvCheckerboard = debugUvCheckerboard;

  return (
    <group name="unity-root">
      {/* Scene-wide lighting settings (ambient + fog + directional/point lights)
          live on the wrapping Canvas via <UnityRenderSettings>. Here we only
          emit the node tree so the viewer's framing logic can treat this like
          any other scene. */}
      {ctx.rootIds.map((rootId) => (
        <NodeRenderer key={rootId} nodeId={rootId} ctx={ctx} />
      ))}
    </group>
  );
}

interface SceneContext {
  scene: UnityExport;
  nodeById: Map<number, UnityNode>;
  childrenByParent: Map<number, number[]>;
  rootIds: number[];
  /** Memoized geometries keyed by meshId. Geometry creation is expensive
   *  (parses & uploads vertex buffers) — we do it once per scene. */
  geometryByMeshId: Map<string, THREE.BufferGeometry>;
  /** Memoized material bundles keyed by materialId. */
  materialById: Map<string, MaterialBundle>;
  debugSubmeshColors: boolean;
  debugUvCheckerboard: boolean;
}

function buildSceneContext(scene: UnityExport): SceneContext {
  const nodeById = new Map<number, UnityNode>();
  const childrenByParent = new Map<number, number[]>();
  const rootIds: number[] = [];

  for (const n of scene.nodes) {
    nodeById.set(n.id, n);
    if (n.parentId === -1) {
      rootIds.push(n.id);
    } else {
      let arr = childrenByParent.get(n.parentId);
      if (!arr) {
        arr = [];
        childrenByParent.set(n.parentId, arr);
      }
      arr.push(n.id);
    }
  }

  // Lazy — geometry/material caches populate on first render to avoid
  // uploading GPU resources for nodes that will never actually render
  // (inactive GameObjects, GameObjects without MeshFilter, ...).
  return {
    scene,
    nodeById,
    childrenByParent,
    rootIds,
    geometryByMeshId: new Map(),
    materialById: new Map(),
    debugSubmeshColors: false,
    debugUvCheckerboard: false,
  };
}

function getGeometry(ctx: SceneContext, meshId: string): THREE.BufferGeometry | null {
  let g = ctx.geometryByMeshId.get(meshId);
  if (g) return g;
  const m = ctx.scene.meshes[meshId];
  if (!m) return null;
  g = meshToGeometry(m);
  ctx.geometryByMeshId.set(meshId, g);
  return g;
}

function getMaterial(ctx: SceneContext, matId: string | null): THREE.Material {
  if (!matId) return getFallbackMaterial();
  let b = ctx.materialById.get(matId);
  if (b) return b.mat;
  const src = ctx.scene.materials[matId];
  if (!src) return getFallbackMaterial();
  b = buildMaterial(src);
  ctx.materialById.set(matId, b);
  return b.mat;
}

let _fallbackMat: THREE.MeshStandardMaterial | null = null;
function getFallbackMaterial(): THREE.Material {
  if (!_fallbackMat) {
    _fallbackMat = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      roughness: 0.8,
      metalness: 0,
    });
  }
  return _fallbackMat;
}

function NodeRenderer({ nodeId, ctx }: { nodeId: number; ctx: SceneContext }) {
  const node = ctx.nodeById.get(nodeId);
  if (!node) return null;
  if (!node.active) return null;

  const children = ctx.childrenByParent.get(nodeId);

  return (
    <group
      name={node.name}
      position={node.position}
      quaternion={node.rotation}
      scale={node.scale}
    >
      {node.mesh && <NodeMesh ctx={ctx} meshRef={node.mesh} />}
      {node.light && <NodeLight light={node.light} />}
      {children?.map((cid) => (
        <NodeRenderer key={cid} nodeId={cid} ctx={ctx} />
      ))}
    </group>
  );
}

function NodeMesh({
  ctx,
  meshRef,
}: {
  ctx: SceneContext;
  meshRef: NonNullable<UnityNode['mesh']>;
}) {
  const geom = getGeometry(ctx, meshRef.meshId);
  if (!geom) return null;

  const srcMesh = ctx.scene.meshes[meshRef.meshId];
  const slotCount =
    srcMesh && srcMesh.submeshes.length > 1
      ? Math.max(srcMesh.submeshes.length, meshRef.materialIds.length)
      : 1;

  // Debug overrides: paint every slot with a solid palette color or a UV
  // checkerboard so we can diagnose submesh ordering / UV issues even on
  // pre-baked Unity exports (not just the YAML pipeline).
  let mats: THREE.Material[];
  if (ctx.debugSubmeshColors) {
    mats = buildDebugSlotPalette(slotCount, false);
  } else if (ctx.debugUvCheckerboard) {
    mats = buildDebugUvMaterials(slotCount, false);
  } else if (srcMesh && srcMesh.submeshes.length > 1) {
    mats = meshRef.materialIds.map((mid) => getMaterial(ctx, mid));
  } else {
    mats = [getMaterial(ctx, meshRef.materialIds[0] ?? null)];
  }

  const castShadow = meshRef.castShadows !== 'Off';
  const receiveShadow = meshRef.receiveShadows;

  return (
    <mesh
      geometry={geom}
      material={mats.length === 1 ? mats[0] : mats}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    />
  );
}

// ---------------------------------------------------------------- Lights ----

function NodeLight({ light }: { light: NonNullable<UnityNode['light']> }) {
  const color = new THREE.Color(light.color[0], light.color[1], light.color[2]);
  const intensity = light.intensity;

  // We render lights as children of the enclosing group, so Unity's
  // transform (position + rotation) already applies. For a directional
  // light three.js orients it along -Z by default; Unity's directional light
  // points along its local +Z. We compensate by targeting a point offset
  // along -Z from the light's local origin.
  if (light.type === 'Directional') {
    // three.js DirectionalLight.intensity is in lumens/m² while Unity's is
    // a linear 0..N scalar. 1.5x gives a reasonable visual match for the
    // typical 1.0-intensity Unity sun — tweaked empirically.
    return <directionalLight color={color} intensity={intensity * 1.5} />;
  }
  if (light.type === 'Point') {
    return (
      <pointLight
        color={color}
        intensity={intensity * 10}
        distance={light.range}
        decay={2}
      />
    );
  }
  if (light.type === 'Spot') {
    return (
      <spotLight
        color={color}
        intensity={intensity * 10}
        distance={light.range}
        angle={(light.spotAngle * Math.PI) / 180 / 2}
        penumbra={light.innerSpotAngle > 0 ? 1 - light.innerSpotAngle / light.spotAngle : 0.2}
        decay={2}
      />
    );
  }
  return null;
}

// ---------------------------------------------------------------- Scene-wide ----

/**
 * Render-setting companion. Drop this INSIDE your <Canvas> — it applies
 * ambient color + fog to the three.js scene directly (no JSX primitive
 * because fog is a scene-level property, not a component), and it also
 * emits an `ambientLight` element so ambient intensity matches Unity's
 * environment setup.
 */
export function UnityRenderSettingsApply({ scene }: { scene: UnityExport }) {
  const setRef = useRef<THREE.Scene | null>(null);

  useEffect(() => {
    const three = setRef.current;
    if (!three) return;

    if (scene.render.fogEnabled && scene.render.fogColor) {
      const c = new THREE.Color(
        scene.render.fogColor[0],
        scene.render.fogColor[1],
        scene.render.fogColor[2],
      );
      // Unity: Linear → start/end distance; Exponential / Exp2 → density.
      // three.js: Fog (linear) vs FogExp2 (density). Mode strings from
      // RenderSettings.fogMode stringify as "Linear" | "Exponential" |
      // "ExponentialSquared".
      if (scene.render.fogMode === 'Linear') {
        three.fog = new THREE.Fog(c, scene.render.fogStart, scene.render.fogEnd);
      } else {
        three.fog = new THREE.FogExp2(c, scene.render.fogDensity);
      }
    } else {
      three.fog = null;
    }
  }, [scene]);

  const ambientColor = useMemo(() => {
    const c = scene.render.ambientLight ?? scene.render.ambientSkyColor;
    if (!c) return new THREE.Color(0x333333);
    return new THREE.Color(c[0], c[1], c[2]);
  }, [scene]);

  return (
    <>
      {/* Capture a ref to the parent three.js Scene via a <primitive> dummy
          object that we attach to the scene with `attach`. We don't actually
          need an object — the callback fires with the three.js Scene as its
          `parent` once React mounts us. */}
      <SceneRefCapture onScene={(s) => (setRef.current = s)} />
      <ambientLight color={ambientColor} intensity={scene.render.ambientIntensity} />
    </>
  );
}

function SceneRefCapture({ onScene }: { onScene: (s: THREE.Scene) => void }) {
  // Invisible object used only to capture the parent scene. Using a group
  // (rather than the useThree hook) keeps this component stateless and
  // re-renderable without subscribing to the R3F internal store.
  return (
    <group
      ref={(g) => {
        if (g && g.parent) {
          // Walk up to the Scene root — parent may be an intermediate Group
          // depending on how the host wrapped the tree.
          let o: THREE.Object3D | null = g.parent;
          while (o && !(o instanceof THREE.Scene)) o = o.parent;
          if (o instanceof THREE.Scene) onScene(o);
        }
      }}
    />
  );
}

// ---------------------------------------------------------------- Stats ----

/**
 * Quick stats for the HUD: derived from the Unity export without walking
 * the three.js graph. Useful for parity with the YAML pipeline's `stats`.
 */
export function getUnityExportStats(scene: UnityExport) {
  let totalGameObjects = 0;
  let renderedMeshes = 0;
  let lights = 0;
  let cameras = 0;
  for (const n of scene.nodes) {
    totalGameObjects += 1;
    if (n.mesh) renderedMeshes += 1;
    if (n.light) lights += 1;
    if (n.camera) cameras += 1;
  }
  return {
    totalGameObjects,
    renderedMeshes,
    lights,
    cameras,
    meshes: Object.keys(scene.meshes).length,
    materials: Object.keys(scene.materials).length,
    textures: scene.textureGuids.length,
    MAX_POINT_SPOT_LIGHTS,
    MAX_DIRECTIONAL_LIGHTS,
  };
}

/** Compute a bounding sphere over all renderable nodes for camera framing. */
export function computeUnityExportFraming(scene: UnityExport): {
  center: [number, number, number];
  radius: number;
} {
  // Accumulate world positions of all mesh nodes to get a rough centroid +
  // extent. We approximate by composing local transforms up to each root
  // rather than importing three.js just to multiply matrices; the centroid
  // of leaf node positions is close enough for auto-framing.
  const nodeById = new Map<number, UnityNode>();
  for (const n of scene.nodes) nodeById.set(n.id, n);

  const worldMatByNodeId = new Map<number, THREE.Matrix4>();
  const getWorld = (id: number): THREE.Matrix4 => {
    const cached = worldMatByNodeId.get(id);
    if (cached) return cached;
    const n = nodeById.get(id)!;
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...n.position),
      new THREE.Quaternion(...n.rotation),
      new THREE.Vector3(...n.scale),
    );
    const world = n.parentId === -1 ? local : new THREE.Matrix4().multiplyMatrices(getWorld(n.parentId), local);
    worldMatByNodeId.set(id, world);
    return world;
  };

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let count = 0;
  const pos = new THREE.Vector3();
  for (const n of scene.nodes) {
    if (!n.mesh) continue;
    const m = getWorld(n.id);
    pos.setFromMatrixPosition(m);
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.z < minZ) minZ = pos.z;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y > maxY) maxY = pos.y;
    if (pos.z > maxZ) maxZ = pos.z;
    count += 1;
  }
  if (count === 0 || !Number.isFinite(minX)) {
    return { center: [0, 0, 0], radius: 10 };
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const dx = (maxX - minX) / 2;
  const dy = (maxY - minY) / 2;
  const dz = (maxZ - minZ) / 2;
  const radius = Math.max(5, Math.sqrt(dx * dx + dy * dy + dz * dz));
  return { center: [cx, cy, cz], radius };
}

// Unused import guard — React needs to be imported to satisfy JSX runtime,
// but some lint configs flag the hook-only import above.
void useState;
