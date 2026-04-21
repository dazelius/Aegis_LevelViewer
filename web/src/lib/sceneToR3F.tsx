import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import type {
  GameObjectNode,
  InlineMeshData,
  MaterialJson,
  SceneJson,
  SceneRenderSettings,
} from './api';
import { textureUrl } from './api';
import { loadFbx, loadFbxGeometry, type FbxEntry } from './fbxCache';

// ---------------------------------------------------------------- Selection ----
//
// Click-to-select → external Inspector panel. Picking is done in r3f's onClick
// on the SceneNode `<group>`; the innermost node with a mesh captures the
// event (stopPropagation) so the selected GameObject is the one whose renderer
// the user actually sees under the cursor. We expose both the selected node
// and a live `groupRef` so the Inspector can read `matrixWorld` on demand
// without re-rendering the tree.

/** Snapshot of the live three.js Mesh/BufferGeometry sitting under the
 *  selected GameObject. Captured at pick time so the Inspector can show
 *  UV-channel count, submesh-group layout, and the actually-used material
 *  array — information that only exists once the FBX has been parsed and
 *  bound, and isn't serialisable in the server-side scene JSON.
 *
 *  Useful for diagnosing:
 *    - UV0/UV1 swap (a 3ds Max export might have lightmap UV on ch0)
 *    - submesh-count / material-count mismatch (repeat-fill kicking in)
 *    - whether a given material-slot even has an albedo map bound. */
export interface MeshInfoSnapshot {
  uvChannelCount: number;
  vertexCount: number;
  groupCount: number;
  /** In `geometry.groups` order: `[start, count, materialIndex]` each. */
  groups: Array<[number, number, number]>;
  /**
   * UV0 bounding box per group, aligned 1:1 with `groups`.
   * Each entry is `[uMin, vMin, uMax, vMax]`, or `null` when the group
   * has no UV data (pure vertex colour meshes, or a group we truncated
   * from the snapshot). Lets the Inspector show exactly which atlas tile
   * a submesh samples from — critical for trim-sheet materials where
   * "which texture you see" is purely a function of UV range.
   */
  groupUvBounds: Array<[number, number, number, number] | null>;
  /**
   * Number of material slots actually referenced by the submesh groups —
   * i.e. `max(group.materialIndex) + 1`. Slots above this index in the
   * renderer's `materialGuids` array are dead weight (authored by the
   * scene / prefab but never sampled, usually because the prefab padded
   * to match the FBX's embedded material count). The Inspector uses this
   * to hide phantom `DM_PropSet*`-style bindings so the materials list
   * matches what Unity would actually draw.
   */
  usedSlotCount: number;
  /**
   * Resolved binding for each material slot (index = materialIndex that
   * submesh groups reference). Populated when the mesh is rendered through
   * `RendererProxy` by writing a snapshot to `mesh.userData.levelViewer`.
   * Lets the Inspector render each submesh group as "group i → matName
   * (fbx: fbxEmbeddedName)" so discrepancies like "Unity binds Wall at
   * slot 2 but FBX group 0 ends up painted with slot 2's material" become
   * visible without having to dig through console logs.
   */
  slotBindings?: Array<{
    /** The materialIndex the group references. Equivalent to the slot index. */
    slot: number;
    /** Resolved .mat guid (32 hex) that ended up bound to this slot. Empty
     *  string when the slot fell through to the fallback/debug material. */
    guid: string;
    /** `MaterialJson.name` of the resolved material. Empty when fallback. */
    matName: string;
    /** First 8 chars of the resolved material's albedo/base map GUID, or
     *  empty if the material has no base map. Useful to tell apart two
     *  variants that share a name but ship different textures. */
    baseMapGuid: string;
    /** The FBX-embedded material name (if any) that sat at this slot in
     *  the FBX's own material list. When Unity's explicit slot assignment
     *  agrees with the FBX embed, this matches `matName` modulo the
     *  `_M` suffix; when they diverge, the mismatch is the bug. */
    fbxEmbeddedName: string;
  }>;
}

export interface SceneSelection {
  node: GameObjectNode;
  /** Per-instance Object3D uuid of the picked group. Scene GameObjects
   *  share `fileID` across instances when the scene references the same
   *  prefab/FBX many times (synthesized model-prefab roots all use the
   *  canonical fileID `100100000`), so we key selection by the actual r3f
   *  Object3D uuid — guaranteed unique for every group instance. */
  groupUuid: string;
  /** Path names from scene root → selected node, inclusive. */
  path: string[];
  /** World-space decomposition captured at pick time. */
  worldPosition: [number, number, number];
  worldQuaternion: [number, number, number, number];
  worldEulerDeg: [number, number, number];
  worldScale: [number, number, number];
  /** Present when the picked GameObject has at least one descendant mesh
   *  with a live BufferGeometry. Absent for pure transform nodes / lights /
   *  cameras / nodes whose FBX is still loading. */
  meshInfo?: MeshInfoSnapshot;
  /**
   * UV0 at the exact ray-intersection point on the picked triangle.
   * This is the coordinate the shader would actually sample at that pixel,
   * post wrap-mode application (we report the raw value, [u, v] BEFORE any
   * wrap wrapping). Critical for trim-sheet diagnostics: click the billboard
   * face and read off which atlas tile its surface samples.
   */
  pickUv?: [number, number];
  /** UV0 bounding box of the three vertices of the picked triangle.
   *  Always a sub-range of the enclosing group's bbox. */
  pickFaceUvBounds?: [number, number, number, number];
  /** `materialIndex` of the picked triangle's submesh group (= slot index). */
  pickMaterialIndex?: number;
}

interface SelectionBridge {
  selectedGroupUuid: string | null;
  setSelection: (sel: SceneSelection | null) => void;
}

const SelectionContext = createContext<SelectionBridge>({
  selectedGroupUuid: null,
  setSelection: () => {},
});

export function SelectionProvider({
  selectedGroupUuid,
  setSelection,
  children,
}: {
  selectedGroupUuid: string | null;
  setSelection: (sel: SceneSelection | null) => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ selectedGroupUuid, setSelection }),
    [selectedGroupUuid, setSelection],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** Cap on simultaneous non-directional lights to stay under typical WebGL
 *  driver sampler/uniform limits. DesertMine, for instance, reports ~275
 *  light components (mostly decorative FX / PathGuide lights inside baked
 *  prefabs) — passing them all to three.js would exceed the driver uniform
 *  budget and fail to link the shader. Spot + point lights beyond the cap
 *  are silently skipped. Directional lights are capped separately below. */
const MAX_POINT_SPOT_LIGHTS = 8;
/** Ceiling on directional lights. Unity scenes typically have 1 sun; the
 *  extras from ambient rigs / prefabs would just stack irrelevant uniforms. */
const MAX_DIRECTIONAL_LIGHTS = 2;

// ===========================================================================
// YAML-pipeline renderer (Tier 1 PBR)
//
// Inputs:
//   - GameObjectNode tree parsed from Unity .unity / .prefab YAML
//   - MaterialJson table resolved from referenced .mat files
//   - SceneRenderSettings (ambient + fog) parsed from the RenderSettings doc
//
// What Tier 1 covers:
//   - THREE.MeshStandardMaterial for lit shaders (URP Lit / Standard)
//   - THREE.MeshBasicMaterial for unlit shaders
//   - Base color, base map, normal map, metallic / smoothness, emission,
//     occlusion, tiling/offset
//   - Directional / point / spot lights from Light components
//   - Linear / exponential fog from RenderSettings
//   - Flat / skybox ambient (approximated via ambient + hemisphere lights)
//
// What Tier 2 would add: baked lightmaps, reflection probes, realtime shadows,
// skybox rendering, HDR tone-mapping options, Shader Graph/URP-custom shaders.
// ===========================================================================

// ---------------------------------------------------------------- Scene ctx ----

interface YamlSceneContext {
  materials: Record<string, MaterialJson>;
  inlineMeshes: Record<string, InlineMeshData>;
  /** Per-FBX `ModelImporter.externalObjects` remap (name -> .mat GUID),
   *  keyed by FBX asset GUID. Used by `RendererProxy` to fill empty
   *  `m_Materials` slots by matching FBX-internal material names. */
  fbxExternalMaterials: Record<string, Record<string, string>>;
  /** Project-wide `.mat` name→guid table. Reproduces Unity's
   *  `MaterialSearch.RecursiveUp` fallback. */
  materialNameIndex: Record<string, string>;
  /** Set of GameObject fileIDs whose Light components are allowed to emit
   *  a three.js light. Pre-computed by `pickVisibleLights` to stay under
   *  the MAX_*_LIGHTS budget. When a GameObject isn't in the set, its
   *  `NodeLight` returns null. */
  enabledLightFileIds: Set<string>;
  /**
   * When true, collider-only sub-trees (server flag `isCollider`) and
   * renderers authored with `m_Enabled: 0` are drawn. Defaults to false so
   * the viewer matches what Unity actually shoots in the Game view — the
   * designer puts duplicate geometry under a `collider/` root so PhysX has
   * a bakeable hull, and letting those render produces obvious z-fighting
   * / double-shadow artifacts (and also misleads the "Meshes:" count in
   * the HUD). The HUD exposes a toggle for debugging physics hulls.
   */
  showColliders: boolean;
  /**
   * Diagnostic: when true, every mesh is drawn with per-slot solid colors
   * instead of its resolved `.mat` material. Slot 0 → red, 1 → green,
   * 2 → blue, 3 → yellow, … cycling through a fixed 8-color palette. This
   * isolates the "which geometry references which submesh slot" question
   * from every other variable (texture binding, UV mapping, tiling) and
   * lets us tell at a glance whether Unity's submesh ordering and
   * FBXLoader's `geometry.groups[].materialIndex` ordering agree. If the
   * wall panels come out blue (slot 2) and `m_Materials[2]` is Wall, the
   * mapping is correct and any remaining discrepancy is a material/UV
   * issue. If the wall panels come out red (slot 0, Metal), we've found
   * a submesh-order mismatch that needs a name-based or index-remap
   * correction.
   */
  debugSubmeshColors: boolean;
  /**
   * Diagnostic: when true, every mesh is drawn with a checkerboard UV-
   * diagnostic texture (see `getDebugUvTexture`) in place of its real
   * albedo. Square checkers = UVs are uniform; rectangular = stretched;
   * mirrored "A" glyph = UV horizontally flipped; axis arrows reveal
   * rotation. `debugSubmeshColors` wins if both are on — the two are
   * mutually exclusive by nature.
   */
  debugUvCheckerboard: boolean;
  /**
   * Diagnostic: when true, every lit material is rebuilt as a
   * `MeshBasicMaterial` with JUST the base map bound — no tone mapping
   * from lights, no emission, no PBR shading. Isolates "does the atlas
   * texture actually paint the expected pixels on this face" from every
   * lighting/shading variable. If BATTLE ARENA appears in unlit preview
   * but not in the real render, the bug is in lighting/emission config.
   * If it's missing in both, the bug is in UV sampling or texture load.
   */
  debugUnlitPreview: boolean;
  /**
   * Diagnostic: when true, every texture is created with `flipY = false`
   * instead of the default `true`. Use this to detect double-flip bugs
   * where a server-side decoder (e.g. our PSD pipeline) already emits
   * the image in GL orientation and three.js's default `flipY=true`
   * inverts it again. If toggling this ON suddenly makes a misplaced
   * atlas glyph (BATTLE ARENA etc.) snap into its correct position, the
   * PSD decoder has a Y-axis convention mismatch we need to fix server
   * side.
   */
  debugFlipYOff: boolean;
  /**
   * Per-FBX slot-permutation overrides, keyed by lowercased mesh GUID.
   * `perm[i] = j` means "the i-th submesh group should bind the
   * material currently authored at `m_Materials[j]` instead of
   * `m_Materials[i]`". Identity permutation (`[0,1,2,3,…]`) matches
   * Unity's default, which is what we apply when no override is
   * registered.
   *
   * Exists purely as a diagnostic knob: when Unity's submesh ordering
   * and FBXLoader's group.materialIndex ordering disagree for a given
   * FBX, the user can empirically discover the right permutation in the
   * Inspector, and we can later bake that remapping into the server's
   * parsing. Keyed by GUID so every instance of the same FBX
   * (e.g. all 120 `DM_BLDG_ATeam_A` placements) share the same fix —
   * anything finer would fragment the experiment.
   */
  slotPermutations: Record<string, number[]>;
}

const SceneContext = createContext<YamlSceneContext>({
  materials: {},
  inlineMeshes: {},
  fbxExternalMaterials: {},
  materialNameIndex: {},
  enabledLightFileIds: new Set<string>(),
  showColliders: false,
  debugSubmeshColors: false,
  debugUvCheckerboard: false,
  debugUnlitPreview: false,
  debugFlipYOff: false,
  slotPermutations: {},
});

export function SceneRoots({
  roots,
  inlineMeshes,
  materials,
  fbxExternalMaterials,
  materialNameIndex,
  renderSettings,
  showColliders = false,
  debugSubmeshColors = false,
  debugUvCheckerboard = false,
  debugUnlitPreview = false,
  debugFlipYOff = false,
  slotPermutations,
}: {
  roots: GameObjectNode[];
  inlineMeshes?: Record<string, InlineMeshData>;
  materials?: Record<string, MaterialJson>;
  fbxExternalMaterials?: Record<string, Record<string, string>>;
  materialNameIndex?: Record<string, string>;
  renderSettings?: SceneRenderSettings;
  showColliders?: boolean;
  debugSubmeshColors?: boolean;
  debugUvCheckerboard?: boolean;
  debugUnlitPreview?: boolean;
  debugFlipYOff?: boolean;
  slotPermutations?: Record<string, number[]>;
}) {
  const enabledLightFileIds = useMemo(() => pickVisibleLights(roots), [roots]);
  const ctx = useMemo(
    () => ({
      materials: materials ?? {},
      inlineMeshes: inlineMeshes ?? {},
      fbxExternalMaterials: fbxExternalMaterials ?? {},
      materialNameIndex: materialNameIndex ?? {},
      enabledLightFileIds,
      showColliders,
      debugSubmeshColors,
      debugUvCheckerboard,
      debugUnlitPreview,
      debugFlipYOff,
      slotPermutations: slotPermutations ?? {},
    }),
    [
      materials,
      inlineMeshes,
      fbxExternalMaterials,
      materialNameIndex,
      enabledLightFileIds,
      showColliders,
      debugSubmeshColors,
      debugUvCheckerboard,
      debugUnlitPreview,
      debugFlipYOff,
      slotPermutations,
    ],
  );
  // eslint-disable-next-line no-console
  console.warn(
    `[SceneRoots] materials=${Object.keys(ctx.materials).length} fbxExternalMaterials=${Object.keys(ctx.fbxExternalMaterials).length} materialNameIndex=${Object.keys(ctx.materialNameIndex).length}`,
  );

  return (
    <SceneContext.Provider value={ctx}>
      {renderSettings && <RenderSettingsApply settings={renderSettings} />}
      <BaselineLights settings={renderSettings} />
      {roots.map((root, idx) => (
        <SceneNode key={`${root.fileID}_${idx}`} node={root} />
      ))}
      <GlobalSelectionHighlight />
    </SceneContext.Provider>
  );
}

/** Convenience helper that accepts the whole SceneJson — matches the
 *  Unity-export pipeline's `<UnityExportRoots scene={...} />` ergonomics. */
export function SceneRootsFromScene({ scene }: { scene: SceneJson }) {
  return (
    <SceneRoots
      roots={scene.roots}
      inlineMeshes={scene.inlineMeshes}
      materials={scene.materials}
      fbxExternalMaterials={scene.fbxExternalMaterials}
      materialNameIndex={scene.materialNameIndex}
      renderSettings={scene.renderSettings}
    />
  );
}

// ---------------------------------------------------------------- Lighting ----

/**
 * Apply scene-wide `RenderSettings.fog` to the parent `THREE.Scene`. Three
 * does not have a JSX primitive for scene.fog (it's a scalar prop on Scene),
 * so we imperatively set it via a ref walk when this component mounts.
 */
function RenderSettingsApply({ settings }: { settings: SceneRenderSettings }) {
  const sceneRef = useRef<THREE.Scene | null>(null);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    if (settings.fogEnabled) {
      const c = new THREE.Color(settings.fogColor[0], settings.fogColor[1], settings.fogColor[2]);
      if (settings.fogMode === 'Linear') {
        s.fog = new THREE.Fog(c, settings.fogStart, settings.fogEnd);
      } else {
        // Three.js doesn't distinguish Exponential vs ExponentialSquared —
        // FogExp2 is essentially the Exp2 variant and is visually close enough
        // to Unity's Exponential for scenes that don't push density hard.
        s.fog = new THREE.FogExp2(c, settings.fogDensity);
      }
    } else {
      s.fog = null;
    }
    return () => {
      // Don't clear fog on unmount; the next scene's RenderSettingsApply
      // will overwrite it. Clearing here causes a flash when the viewer
      // navigates between scenes.
    };
  }, [settings]);

  return (
    <group
      ref={(g) => {
        if (g && g.parent) {
          let o: THREE.Object3D | null = g.parent;
          while (o && !(o instanceof THREE.Scene)) o = o.parent;
          if (o instanceof THREE.Scene) sceneRef.current = o;
        }
      }}
    />
  );
}

/**
 * Baseline ambient / hemisphere fill so MeshStandardMaterial surfaces aren't
 * rendered pitch-black when a scene has no Light components (common for
 * static lookdev scenes that rely entirely on baked lighting, which we don't
 * reproduce in Tier 1).
 *
 * When RenderSettings has a concrete ambient colour, we use that; otherwise
 * we fall back to a soft neutral fill that roughly matches Unity's default
 * skybox-ambient sample.
 */
function BaselineLights({ settings }: { settings?: SceneRenderSettings }) {
  const amb = useMemo(() => {
    if (!settings) return { color: new THREE.Color(0x4a556a), intensity: 1.2 };
    const src = settings.ambientMode === 'Flat' ? settings.ambientLight : settings.ambientSkyColor;
    const c = new THREE.Color(src[0], src[1], src[2]);
    // Unity's ambient intensity sits around 1.0 for skybox-mode scenes. We
    // over-scale slightly (1.5x) because Unity also bakes indirect bounce
    // into lightmaps we don't replicate, so a flat ambient needs to stand
    // in for that missing bounce contribution. Keeps close-up surfaces from
    // reading as muddy when the scene's fog would otherwise mask that at
    // distance.
    const intensity = Math.max(0.5, settings.ambientIntensity * 1.5);
    return { color: c, intensity };
  }, [settings]);

  const hemi = useMemo(() => {
    if (!settings) {
      return { sky: new THREE.Color(0x8fa8c8), ground: new THREE.Color(0x2a2520), intensity: 0.6 };
    }
    const skyRaw = settings.ambientSkyColor;
    const groundRaw = settings.ambientGroundColor;
    return {
      sky: new THREE.Color(skyRaw[0], skyRaw[1], skyRaw[2]),
      ground: new THREE.Color(groundRaw[0], groundRaw[1], groundRaw[2]),
      // Only use the Trilight gradient at a higher intensity when the scene
      // actually opted into Trilight mode — for Skybox/Flat modes the flat
      // ambient already covers the sky contribution so only a gentle ground
      // tint remains to prevent undersides from looking pitch-black.
      intensity: settings.ambientMode === 'Trilight' ? 1.0 : 0.3,
    };
  }, [settings]);

  return (
    <>
      <ambientLight color={amb.color} intensity={amb.intensity} />
      <hemisphereLight args={[hemi.sky, hemi.ground, hemi.intensity]} />
    </>
  );
}

// ---------------------------------------------------------------- Node tree ----

function SceneNode({ node }: { node: GameObjectNode }) {
  const groupRef = useRef<THREE.Group>(null);
  const { setSelection } = useContext(SelectionContext);
  const { showColliders } = useContext(SceneContext);

  // Targeted diagnostic: log once per mount for any node flagged for the
  // multi-mesh FBX expansion path, or for the F_Sample root specifically. This
  // tells us whether the tree even visits that GameObject — if this log is
  // silent but other RendererProxy logs fire, the node is being filtered out
  // by an active/collider short-circuit above the renderer dispatch.
  if (node.renderer?.renderAllFbxMeshes || node.name === 'F_Sample') {
    const tq = node.transform.quaternion;
    const tp = node.transform.position;
    const ts = node.transform.scale;
    // eslint-disable-next-line no-console
    console.log(
      `[scene-node] ${node.name} active=${node.active} isCollider=${node.isCollider} ` +
        `hasRenderer=${!!node.renderer} renderAllFbxMeshes=${node.renderer?.renderAllFbxMeshes} ` +
        `meshGuid=${node.renderer?.meshGuid?.slice(0, 8)} enabled=${node.renderer?.enabled} ` +
        `hasRotOverride=${node.transform.hasRotationOverride} ` +
        `pos=(${tp[0].toFixed(3)},${tp[1].toFixed(3)},${tp[2].toFixed(3)}) ` +
        `quat=(${tq[0].toFixed(3)},${tq[1].toFixed(3)},${tq[2].toFixed(3)},${tq[3].toFixed(3)}) ` +
        `scale=(${ts[0].toFixed(3)},${ts[1].toFixed(3)},${ts[2].toFixed(3)})`,
    );
  }

  if (!node.active) return null;

  // Collider sub-trees are physics-only proxies — duplicate geometry the
  // designer kept under a `collider/` root so PhysX has bakeable hulls.
  // Rendering them produces z-fighting with the visual mesh and misleads
  // draw counts, so we skip the entire subtree by default. `markColliderTrees`
  // on the server propagates the flag down, so skipping here is sufficient;
  // no visual descendant of a collider root will ever have isCollider=false.
  if (node.isCollider && !showColliders) return null;

  // Authored-disabled MeshRenderers (m_Enabled: 0) are treated similarly —
  // Unity doesn't draw them unless a script flips the flag at runtime. We
  // still traverse children though: `enabled` is a per-renderer toggle, so
  // a disabled parent doesn't imply its children are hidden.
  const rendererHidden = node.renderer?.enabled === false && !showColliders;

  const { position, quaternion, scale } = node.transform;
  const q = isValidQuaternion(quaternion) ? quaternion : ([0, 0, 0, 1] as const);

  // Click handling: the innermost SceneNode under the cursor captures the
  // event (stopPropagation) so the selection targets the GameObject whose
  // renderer is visible at the pick point, not an ancestor group. Groups
  // without any mesh descendants don't raycast, so empty transforms stay
  // unclickable — which matches the "pick what you see" expectation.
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    // Only left-click selects. Right-click / middle-click keep bubbling so
    // OrbitControls can still pan / rotate the view when the cursor starts
    // over geometry.
    if (e.nativeEvent.button !== 0) return;
    // Play mode owns left-click (hitscan fire). Pointer lock is our
    // authoritative "are we currently playing?" signal because
    // `enterPlay` requests it unconditionally and the escape key
    // releases it via the browser's own pointerlockchange path — so
    // we don't need to thread React state down into the scene graph
    // just for this guard. Without this check, picking would re-open
    // the Inspector on every shot.
    if (document.pointerLockElement) return;
    e.stopPropagation();
    // Capture pick-point UV diagnostics BEFORE we reset any state. `e.uv`
    // is the barycentric-interpolated UV0 at the ray hit, and `e.face.a/b/c`
    // index into the geometry's position attribute — same indexing the UV
    // attribute uses, so we can read the three vertex UVs directly to get
    // the face's exact UV range.
    let pickUv: [number, number] | undefined;
    let pickFaceUvBounds: [number, number, number, number] | undefined;
    let pickMaterialIndex: number | undefined;
    if (e.uv) pickUv = [e.uv.x, e.uv.y];
    const hitObj = e.object as THREE.Mesh | undefined;
    const hitGeom = hitObj?.geometry as THREE.BufferGeometry | undefined;
    const face = e.face;
    if (hitGeom && face) {
      const uvAttr = hitGeom.getAttribute('uv') as THREE.BufferAttribute | undefined;
      if (uvAttr) {
        const us = [uvAttr.getX(face.a), uvAttr.getX(face.b), uvAttr.getX(face.c)];
        const vs = [uvAttr.getY(face.a), uvAttr.getY(face.b), uvAttr.getY(face.c)];
        pickFaceUvBounds = [
          Math.min(...us),
          Math.min(...vs),
          Math.max(...us),
          Math.max(...vs),
        ];
      }
      if (typeof face.materialIndex === 'number') {
        pickMaterialIndex = face.materialIndex;
      }
    }
    const group = groupRef.current;
    if (!group) return;
    group.updateMatrixWorld(true);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    group.matrixWorld.decompose(pos, quat, scl);
    const euler = new THREE.Euler().setFromQuaternion(quat, 'YXZ');
    const RAD2DEG = 180 / Math.PI;
    // Walk back up to the scene root collecting names so the Inspector can
    // show a breadcrumb matching Unity's Hierarchy panel ordering.
    const path: string[] = [];
    let p: THREE.Object3D | null = group;
    while (p && p.type !== 'Scene') {
      if (p.name) path.unshift(p.name);
      p = p.parent;
    }
    // Capture a snapshot of the first live Mesh under this group so the
    // Inspector can show UV-channel layout / submesh grouping without
    // having to plumb a ref through RendererProxy. We only need the
    // first mesh because our renderer emits exactly one mesh per
    // GameObject (possibly wrapped in an unbake-group).
    let meshInfo: MeshInfoSnapshot | undefined;
    group.traverse((child) => {
      if (meshInfo) return;
      if ((child as THREE.Mesh).isMesh) {
        const g = (child as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (!g) return;
        let uvChannelCount = 0;
        for (const name of ['uv', 'uv1', 'uv2', 'uv3']) {
          if (g.getAttribute(name)) uvChannelCount += 1;
        }
        const pos = g.getAttribute('position');
        const ud = (child as THREE.Mesh).userData as {
          slotBindings?: MeshInfoSnapshot['slotBindings'];
        };
        const groupsSlice = g.groups.slice(0, 16);
        // UV0 bbox per group. For indexed geometry, group.start/count refer
        // to the index buffer — we dereference each index to find the vertex
        // before reading UVs. For non-indexed geometry they refer directly
        // to vertices. A single pass over the (typically small) group range
        // is cheap enough to do on click.
        const uvAttr = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
        const indexAttr = g.getIndex();
        const groupUvBounds: Array<[number, number, number, number] | null> = groupsSlice.map(
          (gr) => {
            if (!uvAttr) return null;
            let uMin = Infinity;
            let vMin = Infinity;
            let uMax = -Infinity;
            let vMax = -Infinity;
            const end = gr.start + gr.count;
            for (let i = gr.start; i < end; i += 1) {
              const vi = indexAttr ? indexAttr.getX(i) : i;
              const u = uvAttr.getX(vi);
              const v = uvAttr.getY(vi);
              if (u < uMin) uMin = u;
              if (v < vMin) vMin = v;
              if (u > uMax) uMax = u;
              if (v > vMax) vMax = v;
            }
            if (!isFinite(uMin)) return null;
            return [uMin, vMin, uMax, vMax];
          },
        );
        meshInfo = {
          uvChannelCount,
          vertexCount: pos ? pos.count : 0,
          groupCount: g.groups.length,
          groups: groupsSlice.map(
            (gr) => [gr.start, gr.count, gr.materialIndex ?? 0] as [number, number, number],
          ),
          groupUvBounds,
          usedSlotCount: computeUsedMaterialSlotCount(g),
          slotBindings: ud.slotBindings,
        };
      }
    });
    setSelection({
      node,
      groupUuid: group.uuid,
      path,
      worldPosition: [pos.x, pos.y, pos.z],
      worldQuaternion: [quat.x, quat.y, quat.z, quat.w],
      worldEulerDeg: [euler.x * RAD2DEG, euler.y * RAD2DEG, euler.z * RAD2DEG],
      worldScale: [scl.x, scl.y, scl.z],
      meshInfo,
      pickUv,
      pickFaceUvBounds,
      pickMaterialIndex,
    });
  };

  return (
    <group
      ref={groupRef}
      position={position}
      quaternion={q as [number, number, number, number]}
      scale={scale}
      name={node.name}
      userData={{ fileID: node.fileID }}
      onClick={onClick}
    >
      {node.renderer && !rendererHidden && (
        node.renderer.renderAllFbxMeshes && node.renderer.meshGuid ? (
          // "Whole FBX dragged into the scene" path. The server synthesised
          // a single-root proxy for a PrefabInstance whose source is a
          // model prefab (.fbx / .obj); the client fetches the FBX and
          // re-inflates one mesh per node, preserving each node's FBX-
          // local transform. Without this, a level authored as a single
          // `.fbx` (Mirama's `F_Sample.fbx`) collapses to whichever
          // sub-mesh FBXLoader visited first and the rest of the geometry
          // is missing from the scene entirely.
          <MultiMeshRendererProxy
            renderer={node.renderer}
            gameObjectName={node.name}
            hasRotationOverride={node.transform.hasRotationOverride}
          />
        ) : (
          <RendererProxy
            renderer={node.renderer}
            gameObjectName={node.name}
            hasRotationOverride={node.transform.hasRotationOverride}
          />
        )
      )}
      {node.light && <NodeLight light={node.light} fileID={node.fileID} />}
      {node.children.map((child, idx) => (
        <SceneNode key={`${child.fileID}_${idx}`} node={child} />
      ))}
    </group>
  );
}

/**
 * Scene-root BoxHelper that follows the selected GameObject.
 *
 * This component is mounted at the SCENE ROOT (not inside any transformed
 * group) for a subtle reason: `THREE.BoxHelper.update()` writes world-space
 * vertices straight into the helper's line geometry, computed from the
 * target's `matrixWorld`. If the helper itself is parented under the clicked
 * group, the group's transforms get applied on top of the already-world-
 * space box, displacing it into empty space. Keeping the helper at the
 * scene root avoids that double transform.
 *
 * The target Object3D is located by `uuid` each frame (scene is static; the
 * lookup is trivial relative to r3f render cost) so we don't need to hold
 * a React ref across the tree. We also re-run `.update()` every frame so
 * async FBX loads that arrive after click still produce tight bounds.
 */
function GlobalSelectionHighlight() {
  const { selectedGroupUuid } = useContext(SelectionContext);
  const { scene } = useThree();

  const helperRef = useRef<THREE.BoxHelper | null>(null);
  const targetRef = useRef<THREE.Object3D | null>(null);

  useEffect(() => {
    if (!selectedGroupUuid) {
      targetRef.current = null;
      return;
    }
    // Find the Object3D whose uuid matches the current selection.
    let found: THREE.Object3D | null = null;
    scene.traverse((obj) => {
      if (!found && obj.uuid === selectedGroupUuid) found = obj;
    });
    targetRef.current = found;

    if (!found) return;

    const helper = new THREE.BoxHelper(found, 0xffd84d);
    const mat = helper.material as THREE.LineBasicMaterial;
    mat.depthTest = false;
    mat.transparent = true;
    helper.renderOrder = 999;
    scene.add(helper);
    helperRef.current = helper;
    helper.update();

    return () => {
      scene.remove(helper);
      helper.geometry.dispose();
      mat.dispose();
      helperRef.current = null;
    };
  }, [selectedGroupUuid, scene]);

  useFrame(() => {
    const helper = helperRef.current;
    const target = targetRef.current;
    if (helper && target) helper.update();
  });

  return null;
}

/**
 * Count how many material slots the mesh's submesh groups actually reference.
 *
 * Returns `max(group.materialIndex) + 1` across all submesh groups, or `0`
 * when the geometry is absent / has no groups (in which case callers should
 * treat it as "unknown, don't clamp"). A return of `1` is valid — it means
 * the mesh is single-material.
 *
 * Exported for the Inspector so it can filter the raw `materialGuids` array
 * to just the slots Unity would actually sample, matching what the renderer
 * builds. Keeping both consumers on the same function prevents drift where
 * the Inspector promises N slots but the renderer only emits M.
 */
export function computeUsedMaterialSlotCount(
  geom: THREE.BufferGeometry | null | undefined,
): number {
  if (!geom) return 0;
  const groups = geom.groups;
  if (!groups || groups.length === 0) {
    // A BufferGeometry without groups is implicitly single-material (the
    // whole index buffer is drawn in one draw call against material slot 0).
    return 1;
  }
  let maxIdx = -1;
  for (const g of groups) {
    const mi = g.materialIndex ?? 0;
    if (mi > maxIdx) maxIdx = mi;
  }
  return maxIdx >= 0 ? maxIdx + 1 : 0;
}

function isValidQuaternion(q: [number, number, number, number]): boolean {
  if (q.some((v) => !Number.isFinite(v))) return false;
  const lenSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  return lenSq > 1e-6;
}

// ---------------------------------------------------------------- Lights ----

function NodeLight({
  light,
  fileID,
}: {
  light: NonNullable<GameObjectNode['light']>;
  fileID: string;
}) {
  const { enabledLightFileIds } = useContext(SceneContext);
  const color = useMemo(
    () => new THREE.Color(light.color[0], light.color[1], light.color[2]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [light.color[0], light.color[1], light.color[2]],
  );

  if (!enabledLightFileIds.has(fileID)) return null;

  switch (light.type) {
    case 'Directional':
      // Unity's Directional intensity sits around 1.0-1.5 for a sun; three.js
      // directional lights follow the same linear scale. The 1.2x nudge
      // compensates for the lack of bounce lighting so the lit side of
      // objects reads as well-lit in single-light scenes.
      //
      // A three.js `DirectionalLight` shines from its world position toward
      // its `target` object's world position. We want it to shine along the
      // parent GameObject's *forward* vector (Unity convention) instead of
      // whatever happens to be at world origin. We achieve that with a
      // `<DirectionalTarget>` helper that attaches an Object3D to the
      // scene at the parent group's +Z and wires it up as the light's
      // target. Without this the light direction is effectively random
      // and close-up surfaces look unlit.
      return <DirectionalLightWithTarget color={color} intensity={light.intensity * 1.2} />;
    case 'Point':
      // Unity's Point intensity is a linear multiplier; three.js's follows
      // inverse-square (decay=2) and expects a larger raw value to reach
      // equivalent brightness. 10x matches Unity within reasonable error.
      return (
        <pointLight
          color={color}
          intensity={light.intensity * 10}
          distance={light.range ?? 10}
          decay={2}
        />
      );
    case 'Spot':
      return (
        <spotLight
          color={color}
          intensity={light.intensity * 10}
          distance={light.range ?? 10}
          angle={((light.spotAngle ?? 30) * Math.PI) / 180 / 2}
          penumbra={0.25}
          decay={2}
        />
      );
    case 'Area':
    case 'Unknown':
    default:
      // Area lights baked / not supported in Tier 1 — drop silently.
      return null;
  }
}

/**
 * `<directionalLight>` that actually respects its parent group's orientation.
 *
 * `THREE.DirectionalLight` computes its shading direction as
 * `target.worldPosition - light.worldPosition`. When the target is the default
 * (an unattached `Object3D` at world origin), the direction degenerates to
 * "point roughly toward origin" — which is coincidentally correct only when
 * the light itself sits at some elevation. Unity instead shines along the
 * GameObject's local `+Z` (forward) regardless of world position.
 *
 * We reproduce Unity's convention by placing a dedicated target Object3D
 * one unit forward of the light and adding it to the underlying three.js
 * scene so its world matrix updates each frame (the default target isn't
 * part of the scene graph and wouldn't follow the parent group).
 */
function DirectionalLightWithTarget({
  color,
  intensity,
}: {
  color: THREE.Color;
  intensity: number;
}) {
  const lightRef = useRef<THREE.DirectionalLight | null>(null);
  const targetRef = useRef<THREE.Object3D | null>(null);

  useEffect(() => {
    const light = lightRef.current;
    const target = targetRef.current;
    if (!light || !target) return;
    light.target = target;
    // The target must live in the scene so THREE can update its world matrix
    // every frame. It already does because we render it as a child of the
    // same parent group, so we just hook the reference here.
  }, []);

  return (
    <>
      <directionalLight ref={lightRef} color={color} intensity={intensity} />
      {/* Local +Z relative to the parent GameObject = Unity's `transform.forward`.
          Our coord transform preserves Z sign (only X is flipped for positions,
          Y/Z are flipped for quaternion components), so placing the target at
          local (0,0,1) causes the light to shine along the Unity-authored
          forward direction once the parent group's quaternion is applied. */}
      <object3D ref={targetRef} position={[0, 0, 1]} />
    </>
  );
}

// ---------------------------------------------------------------- Renderer ----

/**
 * Hook: load an entire FBX entry (all meshes, not just one sub-mesh). Mirrors
 * `useFbxGeometry`'s lifecycle — returns `{ entry, status }` with React state
 * transitions so the caller can render a loading placeholder or an error
 * marker without resorting to `Suspense`.
 */
function useFbxEntry(guid: string | undefined): {
  entry: FbxEntry | null;
  status: FbxLoadStatus;
} {
  const [state, setState] = useState<{
    entry: FbxEntry | null;
    status: FbxLoadStatus;
  }>({ entry: null, status: guid ? 'pending' : 'idle' });

  useEffect(() => {
    if (!guid) {
      setState({ entry: null, status: 'idle' });
      return;
    }
    setState({ entry: null, status: 'pending' });
    let cancelled = false;
    loadFbx(guid)
      .then((e) => {
        if (cancelled) return;
        if (e.status === 'ready') {
          setState({ entry: e, status: 'ready' });
        } else {
          console.warn(
            `[fbx-multi] failed guid=${guid} status=${e.status}${e.reason ? ' reason=' + e.reason : ''}`,
          );
          setState({ entry: null, status: 'failed' });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(
          `[fbx-multi] threw guid=${guid} err=${err instanceof Error ? err.message : String(err)}`,
        );
        setState({ entry: null, status: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [guid]);

  return state;
}

/**
 * Renderer for a "whole FBX as PrefabInstance" node. The server synthesises
 * a single `GameObjectNode` for these (it can't walk the FBX's binary
 * hierarchy itself), then flags it with `renderAllFbxMeshes=true`. Here on
 * the client we have FBXLoader's parsed scene available, so we expand the
 * proxy into one `<mesh>` per FBX node, each at its FBX-local transform.
 *
 * Material resolution is name-based per sub-mesh — Rule B from the
 * single-mesh renderer:
 *   1. `fbxExternalMaterials[meshGuid][fbxName]` (from the FBX's
 *      `ModelImporter.externalObjects` remap in the .meta)
 *   2. `materialNameIndex[fbxName]` (project-wide `.mat` RecursiveUp
 *      search fallback — reproduces Unity's default material search when
 *      the .meta doesn't explicitly remap a name)
 *
 * `renderer.materialGuids` is intentionally ignored here: the server
 * leaves it empty for model-prefab roots because a flat array can't
 * correctly map to an N-node hierarchy where each node exposes its own
 * MeshRenderer with its own m_Materials. Scene-level per-sub-node
 * overrides would require hashed FBX-internal fileIDs (Unity 2022+) which
 * we don't reverse; see prefabParser's `synthesizeModelPrefab` comment.
 *
 * Rotation handling (differs from the single-mesh `RendererProxy`):
 *
 * For a multi-mesh model prefab, `Q_scene` is the FINAL rotation of the
 * expanded root in Unity — whatever m_LocalRotation the scene YAML stored
 * for this PrefabInstance's root transform. It is applied ON TOP of the
 * vertex-baked geometry, period. We do NOT use `hasRotationOverride` to
 * decide whether to unbake here.
 *
 * Why: Unity's PrefabInstance `m_Modifications` ALWAYS snapshots the
 * instance's current m_LocalRotation even when the designer never
 * touched rotation (it's just how serialization works). Our server
 * interprets any such entry as `hasRotationOverride=true`, which was
 * intended to mean "the scene quaternion REPLACES the prefab's default
 * PreRotation" — but for Unity model prefabs with
 * `bakeAxisConversion=0`, the prefab-root's default rotation is
 * ALREADY identity (Unity's ModelImporter put the Z→Y axis conversion
 * inside the FBX hierarchy / mesh asset level, not on the root
 * transform). A scene override to identity is therefore a no-op, not a
 * replacement of anything. Inserting `inv(P)` in that case cancels the
 * only rotation we applied (the FBX hierarchy bake) and tips the whole
 * prefab onto its side — exactly what Factory_New_B → F_Sample hit.
 *
 * So: render `Q_scene * (scale * (localPos + baked_vertex))` uniformly.
 * Single-mesh props (`RendererProxy` below) still need the unbake path
 * because for those the scene-authored quaternion Unity writes DOES
 * already include the PreRotation contribution — a product of how the
 * non-expanded MeshRenderer is attached directly to the scene's
 * GameObject. Keep that path unchanged until we have a concrete
 * multi-mesh case that proves otherwise.
 */
function MultiMeshRendererProxy({
  renderer,
  gameObjectName,
  hasRotationOverride,
}: {
  renderer: NonNullable<GameObjectNode['renderer']>;
  gameObjectName: string;
  hasRotationOverride: boolean;
}) {
  // Render-phase mount trace. Runs EVERY render including the initial
  // "pending FBX load" one — lets us confirm the dispatch path in
  // SceneNode reaches here even when `entry` never resolves. The
  // `[fbx-multi]` useEffect below fires only after `entry` becomes ready,
  // so a scene that renders silently (Factory_New_B → F_Sample) without
  // any `[fbx-multi-mount]` line means the component itself is never
  // being instantiated — i.e. the problem is upstream in SceneNode's
  // dispatch condition, not in the FBX pipeline.
  // eslint-disable-next-line no-console
  console.log(`[fbx-multi-mount] ${gameObjectName} guid=${renderer.meshGuid?.slice(0, 8)}`);

  const {
    materials,
    fbxExternalMaterials,
    materialNameIndex,
    debugSubmeshColors,
    debugUvCheckerboard,
    debugUnlitPreview,
    debugFlipYOff,
  } = useContext(SceneContext);

  const { entry, status } = useFbxEntry(renderer.meshGuid);

  const fbxRemap = renderer.meshGuid
    ? fbxExternalMaterials[renderer.meshGuid]
    : undefined;

  // Positional explicit material list from the scene/prefab's m_Materials
  // overrides (after `applyModification` collected `m_Materials.Array.data[N]`
  // mods into `renderer.materialGuids`). For synth'd model-prefab roots
  // this is often populated by "root-fallback" mods the prefab system
  // couldn't route to a real nested GO — for real scene MeshRenderers on
  // single-mesh FBX props (DesertMine barrels, rocks, buildings) these
  // ARE the authoritative bindings (Unity's positional submesh → m_Material
  // mapping). We use them first (Rule A) and fall back to name-based
  // resolution (Rule B) only when the slot is empty or the GUID isn't in
  // the materials dict — same priority order as `RendererProxy`.
  const explicitGuids = renderer.materialGuids ?? [];
  let lastExplicitGuid = '';
  for (const g of explicitGuids) if (g && materials[g]) lastExplicitGuid = g;

  // Material resolution for a single FBX-embedded name. Identical to Rule B
  // in RendererProxy. Extracted here so we can call it per-sub-mesh across
  // every record in `entry.allMeshes` without rebuilding the closure N times.
  const resolveMatGuidForName = (fbxName: string): string | undefined => {
    if (!fbxName) return undefined;
    const fromRemap = fbxRemap?.[fbxName];
    if (fromRemap && materials[fromRemap]) return fromRemap;
    const fromIndex = materialNameIndex[fbxName];
    if (fromIndex && materials[fromIndex]) return fromIndex;
    return undefined;
  };

  // Material resolution strategy depends on whether the FBX has one mesh
  // or many, because `renderer.materialGuids` only binds authoritatively
  // to the ROOT's MeshRenderer:
  //
  // - Single-mesh FBX (DesertMine barrels, rocks, buildings): the sole
  //   FBX node IS the root MeshRenderer, so `materialGuids[i]` maps
  //   directly to submesh `i` of that mesh. Use Rule A (explicit wins)
  //   then Rule B (FBX name lookup), exactly like `RendererProxy`.
  //
  // - Multi-mesh FBX (F_Sample level): Unity creates one child GO per
  //   FBX node, each with its OWN MeshRenderer and its OWN m_Materials.
  //   The scene's overrides land on the synth'd root (6 entries for
  //   F_Sample from our prefab's root-fallback bucket), but those can't
  //   map positionally to N sibling meshes' M slots each. Name-based
  //   resolution per submesh is the only consistent binding, with
  //   `lastExplicitGuid` as a last-resort fallback to avoid magenta.
  const isMultiMeshEntry = (entry?.allMeshes.length ?? 0) > 1;
  const resolveGuidForSlot = (submeshIdx: number, fbxName: string): string | undefined => {
    if (isMultiMeshEntry) {
      return resolveMatGuidForName(fbxName) ?? (lastExplicitGuid || undefined);
    }
    if (explicitGuids.length === 0) return resolveMatGuidForName(fbxName);
    if (submeshIdx < explicitGuids.length) {
      const e = explicitGuids[submeshIdx];
      if (e && materials[e]) return e;
      return resolveMatGuidForName(fbxName) ?? (lastExplicitGuid || undefined);
    }
    return lastExplicitGuid || undefined;
  };

  // Build (and later dispose) every material we instantiate across all
  // sub-meshes. We key the list by (meshIndex, slot) so React's strict
  // dependency check fires a cleanup the moment the FBX guid or any
  // diagnostic toggle changes. Materials are not shared across sub-meshes
  // because MeshStandardMaterial / MeshBasicMaterial keep per-texture
  // state (repeat, offset) that differs from one .mat to another — even
  // when two sub-meshes happen to bind the same GUID, their tiling may
  // differ after Unity's material inheritance resolves.
  const builtMaterials = useMemo<THREE.Material[][]>(() => {
    if (!entry) return [];
    const matOpts = {
      unlitPreview: debugUnlitPreview,
      flipY: debugFlipYOff ? false : true,
    };
    const out: THREE.Material[][] = [];
    for (const record of entry.allMeshes) {
      const usedByGeometry = computeUsedMaterialSlotCount(record.geometry);
      const slotCount =
        usedByGeometry > 0
          ? usedByGeometry
          : Math.max(record.materialNames.length, 1);

      if (debugSubmeshColors) {
        out.push(buildDebugSlotPalette(slotCount, false));
        continue;
      }
      if (debugUvCheckerboard) {
        out.push(buildDebugUvMaterials(slotCount, false));
        continue;
      }

      const row: THREE.Material[] = [];
      for (let i = 0; i < slotCount; i += 1) {
        const fbxName = record.materialNames[i] ?? '';
        const guid = resolveGuidForSlot(i, fbxName);
        if (guid) {
          row.push(buildMaterial(materials[guid], false, matOpts));
        } else {
          row.push(buildFallbackMaterial(renderer.color, renderer.mainTexGuid, false));
        }
      }
      out.push(row);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entry,
    fbxRemap,
    materialNameIndex,
    materials,
    debugSubmeshColors,
    debugUvCheckerboard,
    debugUnlitPreview,
    debugFlipYOff,
    renderer.color[0],
    renderer.color[1],
    renderer.color[2],
    renderer.color[3],
    renderer.mainTexGuid,
    // Spread explicit list so any change to the scene's m_Materials
    // overrides re-runs material resolution. Joining keeps the dep as a
    // single stable string — array identity can flip per render even when
    // contents are unchanged if the server object is re-created.
    explicitGuids.join('|'),
  ]);

  // Mirror RendererProxy's slot-binding snapshot so the Inspector can show
  // which `.mat` landed on each sub-mesh slot. For multi-mesh we surface
  // the FIRST mesh's bindings — the Inspector only inspects one mesh per
  // selected GameObject, and the pick-ray would hit one of these meshes
  // directly in any case (click handling stays at the SceneNode level).
  const firstRecordBindings = useMemo<NonNullable<MeshInfoSnapshot['slotBindings']>>(() => {
    if (!entry || entry.allMeshes.length === 0) return [];
    const record = entry.allMeshes[0];
    const out: NonNullable<MeshInfoSnapshot['slotBindings']> = [];
    for (let i = 0; i < record.materialNames.length; i += 1) {
      const fbxName = record.materialNames[i] ?? '';
      const guid = resolveGuidForSlot(i, fbxName) ?? '';
      const mat = guid ? materials[guid] : undefined;
      out.push({
        slot: i,
        guid,
        matName: mat?.name ?? '',
        baseMapGuid: mat?.baseMapGuid ? mat.baseMapGuid.slice(0, 8) : '',
        fbxEmbeddedName: fbxName,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, fbxRemap, materialNameIndex, materials, explicitGuids.join('|')]);

  useEffect(() => {
    return () => {
      for (const row of builtMaterials) {
        for (const m of row) m.dispose();
      }
    };
  }, [builtMaterials]);

  // Diagnostic log (fired whenever the entry resolves to a new FBX). MUST
  // sit BEFORE any early return so React sees a stable number of hooks
  // between the "pending" render and the "ready" render — otherwise we hit
  //   "Rendered more hooks than during the previous render"
  // when FBX load finishes and the component promotes from the pending
  // placeholder path to the full mesh list path.
  //
  // `hasRotationOverride` is logged for visibility but no longer gates any
  // unbake behaviour (see the component docstring).
  useEffect(() => {
    if (!entry) return;
    const g0 = entry.allMeshes[0]?.geometry;
    const bb = g0?.boundingBox;
    const firstHasBakeLog = entry.allMeshes[0]?.hasBakedRotation ?? false;
    // eslint-disable-next-line no-console
    console.log(
      `[fbx-multi] ${gameObjectName} guid=${renderer.meshGuid?.slice(0, 8)} ` +
        `meshes=${entry.allMeshes.length} unitScale=${entry.unitScale} ` +
        `rotOverride=${hasRotationOverride} firstHasBake=${firstHasBakeLog} ` +
        `bbox=${bb ? `(${bb.min.x.toFixed(1)},${bb.min.y.toFixed(1)},${bb.min.z.toFixed(1)})..(${bb.max.x.toFixed(1)},${bb.max.y.toFixed(1)},${bb.max.z.toFixed(1)})` : 'n/a'}`,
    );
  }, [entry, gameObjectName, renderer.meshGuid, hasRotationOverride]);

  if (!renderer.meshGuid) return null;
  if (status === 'pending') return null;
  if (status === 'failed' || !entry) {
    // Permanent failure — draw a small magenta wireframe cube so the
    // object isn't silently absent. Matches the marker RendererProxy
    // uses for the single-mesh failure case.
    return (
      <mesh key="fbx-multi-failed">
        <boxGeometry args={[0.2, 0.2, 0.2]} />
        <meshBasicMaterial color={0xff00ff} wireframe />
      </mesh>
    );
  }

  const unitScale = entry.unitScale;
  // Filter out sub-meshes the server asked us to skip. Unity's
  // `m_RemovedGameObjects` at the scene / outer-prefab level is how a
  // level author prunes specific children of a nested prefab without
  // unpacking it (e.g. DesertMine::DM_EV_A drops four decorative cliff
  // sub-objects so only the tower mesh remains). The server resolves
  // those fileIDs against the FBX's `.meta` `internalIDToNameTable`
  // and sends the resulting names in `renderer.removedFbxSubmeshNames`.
  // Matching is done on the raw FBX-embedded name here (same string
  // FBXLoader reports as `Object3D.name`) — no fuzzy suffix stripping,
  // since Unity's remove-list always uses exact fileIDs.
  const removedNameSet = renderer.removedFbxSubmeshNames && renderer.removedFbxSubmeshNames.length > 0
    ? new Set(renderer.removedFbxSubmeshNames)
    : undefined;
  // Keep the original index alongside the record so we can still
  // index into `builtMaterials` (which is keyed by the pre-filter
  // position in `entry.allMeshes`).
  const visibleMeshes = entry.allMeshes
    .map((rec, origIdx) => ({ rec, origIdx }))
    .filter(({ rec }) => !removedNameSet || !removedNameSet.has(rec.meshName));
  if (removedNameSet && visibleMeshes.length !== entry.allMeshes.length) {
    // eslint-disable-next-line no-console
    console.log(
      `[fbx-multi-remove] ${gameObjectName} dropped=${entry.allMeshes.length - visibleMeshes.length}/${entry.allMeshes.length} names=${[...removedNameSet].join(',')}`,
    );
  }
  const isSingleMesh = visibleMeshes.length === 1;

  // Mesh list rendered uniformly inside whatever outer wrappers the
  // rotation-override branch picks. Materials / slot-bindings attach to
  // the first record (only one Inspector picks per selected GameObject).
  //
  // `isSingleMesh` case: skip the per-mesh `localPosition`/`localScale`
  // wrapper entirely and render the mesh at the `unitScale`-scaled group
  // origin. This reproduces the OLD single-mesh path exactly — the one
  // every scene prop (barrels, rocks, props in DesertMine) was working
  // under before we introduced the multi-mesh expansion. Unity's model
  // importer, when an FBX has a single mesh, already places that mesh's
  // transform at the synthesized GameObject's origin, so any non-zero
  // `matrixWorld.position` from FBXLoader comes from an intermediate
  // "Null" parent node that Unity itself collapses. Applying those
  // offsets would visibly displace single-mesh props from the scene
  // position authored in Unity. Only when the FBX has genuinely multiple
  // meshes (F_Sample) do we need per-sub-mesh placement.
  const meshes = visibleMeshes.map(({ rec: record, origIdx }, visibleIdx) => {
    const row = builtMaterials[origIdx];
    if (!row || row.length === 0) return null;
    const materialProp: THREE.Material | THREE.Material[] =
      row.length === 1 ? row[0] : row;
    // Slot-bindings are meant for the FIRST mesh actually rendered (the
    // one the Inspector can pick). After filtering we anchor them to the
    // first VISIBLE record so the Inspector keeps working even when the
    // original `allMeshes[0]` was pruned.
    const slotBindings = visibleIdx === 0 ? firstRecordBindings : undefined;
    if (isSingleMesh) {
      // No localPosition/localScale wrapper; matches the single-mesh
      // RendererProxy's output structure modulo material-source.
      return (
        <mesh
          key={`fbx-sub-${origIdx}`}
          geometry={record.geometry}
          material={materialProp}
          name={record.meshName || `submesh_${origIdx}`}
          userData={slotBindings ? { slotBindings } : undefined}
        />
      );
    }
    return (
      <group
        // Records are stable-by-reference across renders (fbxCache
        // returns the same FbxEntry for a given guid), so we key by the
        // original index to keep React's reconciliation stable across
        // filter changes.
        key={`fbx-sub-${origIdx}`}
        position={record.localPosition}
        scale={record.localScale}
        name={record.meshName || `submesh_${origIdx}`}
      >
        <mesh
          geometry={record.geometry}
          material={materialProp}
          userData={slotBindings ? { slotBindings } : undefined}
        />
      </group>
    );
  });

  return (
    <group scale={[unitScale, unitScale, unitScale]} name={`${gameObjectName}__fbxRoot`}>
      {meshes}
    </group>
  );
}

function RendererProxy({
  renderer,
  gameObjectName,
  hasRotationOverride,
}: {
  renderer: NonNullable<GameObjectNode['renderer']>;
  /** Name of the GameObject that owns this MeshFilter/MeshRenderer. Used as
   *  a fallback when the server's `meshSubmeshName` couldn't be resolved
   *  (typical for Unity 2022+ FBX imports with `fileIdsGeneration: 2`,
   *  whose `.meta` omits the internalID→name table). Unity's default import
   *  assigns the mesh name to the owning GameObject, so this hits the
   *  right sub-mesh in virtually every real-world scene. */
  gameObjectName: string;
  /** True when the owning GameObject's `m_LocalRotation` was authoritatively
   *  set in the scene/prefab YAML. When true, Unity's stored quaternion
   *  already incorporates any FBX `PreRotation` (3ds Max Z→Y-up convention),
   *  so we must cancel the `PreRotation` we baked into the geometry —
   *  otherwise the object rotates twice (e.g. `Sky_Default` tilting over). */
  hasRotationOverride: boolean;
}) {
  const {
    materials,
    inlineMeshes,
    fbxExternalMaterials,
    materialNameIndex,
    debugSubmeshColors,
    debugUvCheckerboard,
    debugUnlitPreview,
    debugFlipYOff,
    slotPermutations,
  } = useContext(SceneContext);

  // Apply per-FBX slot-permutation override (diagnostic knob). When the
  // user registers `[3,2,1,0]` for this FBX via the Inspector, slot 0 of
  // the mesh now samples whatever was authored at `m_Materials[3]`, etc.
  // Entries past the original array length fall through to empty so the
  // repeat-last-material rule still works naturally. Done here so BOTH
  // `materialList` AND `slotBindings` (the Inspector snapshot) see the
  // same permuted array — otherwise the two would disagree and the
  // panel would lie about what's on screen.
  const effectiveMaterialGuids = useMemo<string[]>(() => {
    const original = renderer.materialGuids ?? [];
    if (!renderer.meshGuid) return original;
    const perm = slotPermutations[renderer.meshGuid.toLowerCase()];
    if (!perm || perm.length === 0) return original;
    // Pre-size to max(perm.length, original.length) so permutations that
    // explicitly extend the slot count (rare, but legal) still take effect.
    const out: string[] = [];
    const cap = Math.max(perm.length, original.length);
    for (let i = 0; i < cap; i += 1) {
      const src = perm[i];
      if (typeof src === 'number' && src >= 0 && src < original.length) {
        out.push(original[src] ?? '');
      } else {
        // Index unchanged for slots beyond the authored permutation.
        out.push(original[i] ?? '');
      }
    }
    return out;
  }, [renderer.materialGuids, renderer.meshGuid, slotPermutations]);

  const {
    geometry: fbxGeometry,
    materialNames: fbxMaterialNames,
    unitScale: fbxUnitScale,
    bakedRotation: fbxBakedRotation,
    hasBakedRotation: fbxHasBakedRotation,
    status: fbxStatus,
  } = useFbxGeometry(renderer.meshGuid, renderer.meshSubmeshName, gameObjectName);

  const inlineGeom = useInlineMeshGeometry(
    renderer.inlineMeshFileID ? inlineMeshes[renderer.inlineMeshFileID] : undefined,
  );

  // FBX vertices come out at the file's native units. FBXLoader parks the
  // conversion-to-metres factor on the root Group's scale, which we capture
  // in `fbxUnitScale`: 0.01 for cm-native exports, 1 for metre-native. We
  // reproduce that here as a per-mesh scale so the geometry lands in the
  // same coordinate space Unity's `useFileScale=true` importer produces.
  // Inline (ProBuilder) meshes are already in Unity world units, so they
  // don't need any extra scaling.
  const resolvedGeom = inlineGeom ?? fbxGeometry;
  const meshScale: [number, number, number] | undefined =
    fbxGeometry && !inlineGeom
      ? [fbxUnitScale, fbxUnitScale, fbxUnitScale]
      : undefined;

  // Build a three.js Material array in submesh-slot order.
  //
  // Unity's MeshRenderer maps `m_Materials[i]` onto the mesh's submesh `i`.
  // FBXLoader preserves this: `geometry.groups[i].materialIndex = i`, and
  // it hands us the embedded material NAME for slot `i` via the parsed
  // Mesh.material array (which we snapshot as `fbxMaterialNames` before
  // disposal).
  //
  // Unity's Material-resolution rules (MeshRenderer.sharedMaterials):
  //
  //   A. `m_Materials` is NON-EMPTY (common case — the scene / prefab has
  //      authored material overrides). For each submesh `i`:
  //        • If `i < m_Materials.length`, use `m_Materials[i]`. When that
  //          entry is `null` / unresolved, fall back to the FBX's own
  //          import-time binding for that slot (external-objects remap or
  //          project-wide `.mat` name lookup).
  //        • If `i >= m_Materials.length`, Unity REPEATS the last entry:
  //          > "If the Mesh has more sub-meshes than there are Materials,
  //          >  the last Material is used for the extra sub-meshes."
  //          (Unity docs, MeshRenderer.materials). Critically, Unity does
  //          NOT consult the FBX-embedded material names for these
  //          trailing slots — consulting them causes the viewer to paint
  //          extra slots with FBX-private materials (e.g. `DM_PropSetA_M`)
  //          that Unity itself never uses, which looks to the user like
  //          wrong UVs.
  //
  //   B. `m_Materials` is EMPTY. Unity relies entirely on the FBX-import
  //      material binding for every slot:
  //        1. `fbxExternalMaterials[meshGuid][fbxName]` (external-objects
  //           remap, authored in the FBX .meta).
  //        2. `materialNameIndex[fbxName]` (project-wide `.mat` search —
  //           reproduces Unity's `MaterialSearch.RecursiveUp`).
  //
  // Anything that falls through lands on a tinted fallback so the mesh is
  // still visible; `buildFallbackMaterial` emits bright magenta in the
  // diagnostic build so missing bindings are obvious in the viewport.
  const doubleSidedHint = Boolean(inlineGeom);
  const fbxRemap = renderer.meshGuid ? fbxExternalMaterials[renderer.meshGuid] : undefined;
  const materialList = useMemo<THREE.Material[]>(() => {
    const explicit = effectiveMaterialGuids;

    // Diagnostic short-circuits: both bypass the texture/material
    // pipeline entirely. `debugSubmeshColors` reveals the submesh-
    // index → geometry mapping (see buildDebugSlotPalette). `debugUv-
    // Checkerboard` reveals UV layout (see buildDebugUvMaterials).
    // Exposing them as independent toggles lets the user isolate one
    // axis at a time; `debugSubmeshColors` takes precedence when both
    // are on since the two visualisations would fight for the same
    // surface otherwise.
    if (debugSubmeshColors || debugUvCheckerboard) {
      const usedByGeometry = computeUsedMaterialSlotCount(resolvedGeom);
      const slotCount =
        usedByGeometry > 0
          ? usedByGeometry
          : Math.max(fbxMaterialNames.length, explicit.length, 1);
      if (debugSubmeshColors) return buildDebugSlotPalette(slotCount, doubleSidedHint);
      return buildDebugUvMaterials(slotCount, doubleSidedHint);
    }

    // Last resolvable entry in the explicit array — used to repeat-fill
    // trailing slots (rule A, second bullet).
    let lastExplicitGuid = '';
    for (const g of explicit) if (g && materials[g]) lastExplicitGuid = g;

    // Determine how many material slots the mesh ACTUALLY references.
    //
    // Prior versions used `max(fbxMaterialNames.length, explicit.length, 1)`,
    // which faithfully reproduced every slot authored in the scene YAML and
    // every material embedded in the FBX binary. That works when both
    // arrays agree, but for buildings like `DM_BLDG_ATeam_A` the scene
    // declares 7 m_Materials (inherited from a prefab variant that padded
    // to match the FBX's 7 embedded materials) while the mesh's submesh
    // groups only reference indices 0..3. Slots 4..6 then build full
    // THREE.Material instances (uploading textures, compiling shaders)
    // that nothing ever samples — and worse, the Inspector surfaces them
    // as phantom `DM_PropSet*` bindings that Unity never actually uses,
    // which reads as a viewer bug.
    //
    // The submesh groups are authoritative: Unity's renderer will only
    // dereference `sharedMaterials[groups[i].materialIndex]`, so slots
    // above `max(materialIndex) + 1` are provably dead. We clamp to that
    // ceiling when the geometry is available, and fall back to the old
    // permissive cap only while the FBX is still loading (so the dummy
    // cube placeholder still gets a single material).
    const usedByGeometry = computeUsedMaterialSlotCount(resolvedGeom);
    const slotCount =
      usedByGeometry > 0
        ? usedByGeometry
        : Math.max(fbxMaterialNames.length, explicit.length, 1);

    const resolveFromFbxName = (i: number): string | undefined => {
      const fbxName = fbxMaterialNames[i];
      if (!fbxName) return undefined;
      const fromRemap = fbxRemap?.[fbxName];
      if (fromRemap && materials[fromRemap]) return fromRemap;
      const fromIndex = materialNameIndex[fbxName];
      if (fromIndex && materials[fromIndex]) return fromIndex;
      return undefined;
    };

    const resolveGuid = (i: number): string | undefined => {
      if (explicit.length === 0) {
        // Rule B: no authored overrides — rely entirely on FBX import.
        return resolveFromFbxName(i);
      }
      if (i < explicit.length) {
        // Rule A, in-range slot: explicit wins, fall back to FBX name.
        const e = explicit[i];
        if (e && materials[e]) return e;
        return resolveFromFbxName(i) ?? (lastExplicitGuid || undefined);
      }
      // Rule A, out-of-range slot: Unity repeats the LAST explicit entry
      // verbatim and ignores whatever FBX-private material name sits in
      // that slot. Emulating this exactly is what prevents `DM_PropSetA_M`
      // (or other unused FBX-embedded materials) from leaking onto
      // trailing submeshes and producing misread-as-UV errors.
      return lastExplicitGuid || undefined;
    };

    const out: THREE.Material[] = [];
    const dbg: string[] = [];
    const matOpts = {
      unlitPreview: debugUnlitPreview,
      flipY: debugFlipYOff ? false : true,
    };
    for (let i = 0; i < slotCount; i += 1) {
      const g = resolveGuid(i);
      if (g) {
        const mat = materials[g];
        out.push(buildMaterial(mat, doubleSidedHint, matOpts));
        dbg.push(`${mat.name}${mat.baseMapGuid ? '+tex' : '-notex'}`);
      } else {
        out.push(buildFallbackMaterial(renderer.color, renderer.mainTexGuid, doubleSidedHint));
        dbg.push('FALLBACK');
      }
    }
    // eslint-disable-next-line no-console
    if (renderer.meshGuid && fbxMaterialNames.length > 1) {
      const g = fbxGeometry;
      const groupsInfo = g?.groups
        ? g.groups.map((gr) => `[s=${gr.start},c=${gr.count},m=${gr.materialIndex}]`).join('')
        : 'null';
      console.warn(
        `[mat3] ${renderer.meshGuid.slice(0, 8)} fbxNames=[${fbxMaterialNames.join(
          '|',
        )}] mats=[${dbg.join(',')}] groups=${g?.groups?.length ?? 0} ${groupsInfo}`,
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    effectiveMaterialGuids,
    renderer.meshGuid,
    fbxMaterialNames,
    fbxRemap,
    materialNameIndex,
    materials,
    renderer.color[0],
    renderer.color[1],
    renderer.color[2],
    renderer.color[3],
    renderer.mainTexGuid,
    doubleSidedHint,
    debugSubmeshColors,
    debugUvCheckerboard,
    debugUnlitPreview,
    debugFlipYOff,
    // Resolving the "used slot count" depends on the BufferGeometry, which
    // arrives asynchronously from fbxCache. Adding the geometry reference
    // here forces the material array to shrink from the permissive (7-slot)
    // bootstrap to the authoritative (n-slot) count the moment the FBX
    // finishes loading, so phantom trailing materials never reach a draw.
    resolvedGeom,
  ]);

  useEffect(() => {
    return () => {
      for (const m of materialList) m.dispose();
    };
  }, [materialList]);

  // Diagnostic snapshot of what each material slot ACTUALLY ended up bound
  // to. Mirrors the binding logic in `materialList` above, but produces plain
  // metadata instead of THREE.Material instances so the Inspector (which
  // reads this from `mesh.userData`) can render a "slot i → matName
  // (fbx: embeddedName, tex: <guid>)" table. This is the single most useful
  // diagnostic for "materials look right in Inspector but drawing is wrong"
  // bugs — the common cause is a mismatch between Unity's submesh order and
  // FBXLoader's group.materialIndex order, and this table makes that
  // mismatch visible in-viewport.
  const slotBindings = useMemo<NonNullable<MeshInfoSnapshot['slotBindings']>>(() => {
    const explicit = effectiveMaterialGuids;
    let lastExplicitGuid = '';
    for (const g of explicit) if (g && materials[g]) lastExplicitGuid = g;

    const usedByGeometry = computeUsedMaterialSlotCount(resolvedGeom);
    const slotCount =
      usedByGeometry > 0
        ? usedByGeometry
        : Math.max(fbxMaterialNames.length, explicit.length, 1);

    const resolveFromFbxName = (i: number): string | undefined => {
      const fbxName = fbxMaterialNames[i];
      if (!fbxName) return undefined;
      const fromRemap = fbxRemap?.[fbxName];
      if (fromRemap && materials[fromRemap]) return fromRemap;
      const fromIndex = materialNameIndex[fbxName];
      if (fromIndex && materials[fromIndex]) return fromIndex;
      return undefined;
    };
    const resolveGuid = (i: number): string | undefined => {
      if (explicit.length === 0) return resolveFromFbxName(i);
      if (i < explicit.length) {
        const e = explicit[i];
        if (e && materials[e]) return e;
        return resolveFromFbxName(i) ?? (lastExplicitGuid || undefined);
      }
      return lastExplicitGuid || undefined;
    };

    const out: NonNullable<MeshInfoSnapshot['slotBindings']> = [];
    for (let i = 0; i < slotCount; i += 1) {
      const guid = resolveGuid(i) ?? '';
      const mat = guid ? materials[guid] : undefined;
      out.push({
        slot: i,
        guid,
        matName: mat?.name ?? '',
        baseMapGuid: mat?.baseMapGuid ? mat.baseMapGuid.slice(0, 8) : '',
        fbxEmbeddedName: fbxMaterialNames[i] ?? '',
      });
    }
    return out;
  }, [
    effectiveMaterialGuids,
    fbxMaterialNames,
    fbxRemap,
    materialNameIndex,
    materials,
    resolvedGeom,
  ]);

  const materialProp: THREE.Material | THREE.Material[] =
    materialList.length === 1 ? materialList[0] : materialList;

  // Render as mutually-exclusive branches so React unmounts/remounts the
  // mesh when the FBX finishes loading. Mixing `geometry=` prop with a child
  // `<boxGeometry>` fallback on the same mesh caused the primitive cube to
  // persist on the GPU even after the FBX geometry was ready.
  if (resolvedGeom) {
    // fbxCache bakes the FBX root's `matrixWorld` rotation into the vertices
    // (typically a -90°X PreRotation for 3ds Max Z-up → Unity Y-up). Unity
    // does this differently: it leaves vertices untouched and puts the
    // PreRotation on the prefab's root Transform. When the scene YAML
    // authoritatively overrides rotation (`hasRotationOverride=true`), the
    // quaternion Unity wrote *already includes* the PreRotation, so applying
    // that quaternion on top of our pre-rotated geometry doubles the tilt.
    // Cancel the bake in that case by wrapping the mesh in an inverse-
    // PreRotation group, so the net mesh-local rotation becomes identity
    // and the scene quaternion applied by the parent group is the whole
    // and only source of rotation.
    const needsUnbake =
      hasRotationOverride && fbxHasBakedRotation && !inlineGeom;
    if (needsUnbake) {
      const invQ = new THREE.Quaternion(
        fbxBakedRotation[0],
        fbxBakedRotation[1],
        fbxBakedRotation[2],
        fbxBakedRotation[3],
      ).invert();
      return (
        <group
          key="geom-unbake"
          quaternion={[invQ.x, invQ.y, invQ.z, invQ.w]}
        >
          <mesh
            geometry={resolvedGeom}
            material={materialProp}
            scale={meshScale}
            userData={{ slotBindings }}
          />
        </group>
      );
    }
    return (
      <mesh
        key="geom"
        geometry={resolvedGeom}
        material={materialProp}
        scale={meshScale}
        userData={{ slotBindings }}
      />
    );
  }

  // If this renderer is waiting on an FBX that's still being fetched/parsed,
  // don't draw anything — showing a 1x1x1 cube fallback is actively
  // misleading ("that brick is not a cube!"). Once the FBX resolves the
  // proper geometry will swap in. On permanent failure we still draw a
  // diagnostic marker so the object isn't completely invisible.
  if (renderer.meshGuid) {
    if (fbxStatus === 'pending') return null;
    if (fbxStatus === 'failed') {
      return (
        <mesh key="fbx-failed">
          <boxGeometry args={[0.2, 0.2, 0.2]} />
          <meshBasicMaterial color={0xff00ff} wireframe />
        </mesh>
      );
    }
  }

  // Unity built-in primitive (Cube/Sphere/…) — only render if the server
  // actually classified the mesh as one. `builtinMesh=undefined` on a
  // non-meshGuid renderer means we have nothing to draw. Primitives only
  // use a single material, so collapse the array.
  if (renderer.builtinMesh) {
    return (
      <mesh key="prim" material={materialList[0]}>
        <PrimitiveGeometry kind={renderer.builtinMesh} />
      </mesh>
    );
  }

  return null;
}

// ---------------------------------------------------------------- Material ----

// ---------------------------------------------------------------- Texture cache ----
//
// Two-layer cache:
//
//   1. `imageCache` — one fetch + decode per unique (guid, colorspace).
//      Shared across all Texture wrappers in the session. This is where
//      the actual bytes/memory live.
//
//   2. `textureCache` — one THREE.Texture per unique (guid, colorspace,
//      tiling, offset) tuple. A THREE.Texture owns the `repeat` / `offset`
//      vectors and the GPU upload; two materials with DIFFERENT tiling
//      MUST have separate Texture objects, otherwise the last
//      `.repeat.set(...)` call wins for all of them — which is how text
//      on the "BATT" banner could end up rendering flipped (Unity stores
//      negative tiling for mirrored UVs, and that value was being
//      clobbered by the next material's default (1,1)).
//
// Memory-wise: the underlying ImageBitmap is shared, so adding more
// Texture wrappers only costs ~one extra GPU upload per unique tiling
// combo (usually a handful — 1:1 tiling dominates, mirrored/scaled is
// rare). JS heap cost is negligible.
interface ImageCacheEntry {
  promise: Promise<ImageBitmap | null>;
  image: ImageBitmap | null;
  /** Texture wrappers created before the image resolved — we need to
   *  flip `needsUpdate` on each once the bytes arrive. */
  pendingTextures: THREE.Texture[];
}
const imageCache = new Map<string, ImageCacheEntry>();
const textureCache = new Map<string, THREE.Texture>();

function loadImage(
  guid: string,
  srgb: boolean,
  flipY: boolean,
): ImageCacheEntry {
  // IMPORTANT: `Texture.flipY` is a NO-OP for ImageBitmap textures (three.js
  // uploads them via a different WebGL path that skips the UNPACK_FLIP_Y
  // pixel-store flag). The flip HAS to happen at bitmap-decode time via
  // `imageOrientation`. Unity's UV convention places V=0 at the bottom of
  // the image, matching default OpenGL sampling; PNGs are top-origin, so
  // we need a physical flip during decode to end up with the right
  // sampling orientation. `from-image` (the old behaviour) yields
  // UV(v=0)=TOP = upside-down vs. Unity, which is why picking a face
  // whose UV pointed at BATTLE ARENA would actually render whatever sits
  // at the V-mirrored position of the atlas.
  //
  // The image cache is keyed by orientation too, so toggling the debug
  // `flipY` HUD button (which flips between `flipY` and `from-image`)
  // spawns independent cache entries per orientation.
  const orientation: ImageOrientation = flipY ? 'flipY' : 'from-image';
  const key = `${guid}|${srgb ? 'srgb' : 'linear'}|${orientation}`;
  let entry = imageCache.get(key);
  if (entry) return entry;

  const pending: THREE.Texture[] = [];
  entry = {
    image: null,
    pendingTextures: pending,
    promise: (async () => {
      try {
        const resp = await fetch(textureUrl(guid));
        if (!resp.ok) {
          let detail = '';
          try {
            const body = await resp.clone().json();
            if (body?.error) {
              detail = ` ${body.error}`;
              if (body.ext) detail += ` (${body.ext})`;
              if (body.message) detail += ` — ${body.message}`;
            }
          } catch {
            try {
              detail = ' ' + (await resp.text()).slice(0, 200);
            } catch {
              // ignore
            }
          }
          // eslint-disable-next-line no-console
          console.warn(`[tex-err] ${guid.slice(0, 8)} HTTP ${resp.status}${detail}`);
          return null;
        }
        const blob = await resp.blob();
        const img = await createImageBitmap(blob, { imageOrientation: orientation });
        return img;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[tex-err] ${guid.slice(0, 8)} ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    })(),
  };
  imageCache.set(key, entry);

  void entry.promise.then((img) => {
    entry!.image = img;
    if (img) {
      for (const t of entry!.pendingTextures) {
        t.image = img;
        t.needsUpdate = true;
      }
    }
    entry!.pendingTextures.length = 0;
  });

  return entry;
}

function getCachedTexture(
  guid: string,
  opts: {
    srgb?: boolean;
    tiling?: [number, number] | null;
    offset?: [number, number] | null;
    flipY?: boolean;
  } = {},
): THREE.Texture {
  const srgb = !!opts.srgb;
  const tx = opts.tiling?.[0] ?? 1;
  const ty = opts.tiling?.[1] ?? 1;
  const ox = opts.offset?.[0] ?? 0;
  const oy = opts.offset?.[1] ?? 0;
  // Default matches pre-debug behaviour: flipY=true is correct for
  // top-origin PNG/JPG sources rendered with Unity UV convention. The
  // `debugFlipYOff` toggle overrides this to detect double-flip bugs.
  const flipY = opts.flipY ?? true;
  // Quantise the float key to 4 decimal places so near-identical values
  // (1.0000001 from FBX rounding) still dedupe to the same Texture.
  const q = (v: number): string => v.toFixed(4);
  const cacheKey = `${guid}|${srgb ? 's' : 'l'}|${q(tx)},${q(ty)}|${q(ox)},${q(oy)}|${flipY ? 'fy1' : 'fy0'}`;
  const cached = textureCache.get(cacheKey);
  if (cached) return cached;

  const t = new THREE.Texture();
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  // The actual V flip is applied inside `loadImage` via createImageBitmap's
  // `imageOrientation: 'flipY'` — this `texture.flipY` value is purely for
  // three.js internal bookkeeping and has no effect on ImageBitmap uploads.
  t.flipY = flipY;
  t.repeat.set(tx, ty);
  t.offset.set(ox, oy);
  textureCache.set(cacheKey, t);

  const entry = loadImage(guid, srgb, flipY);
  if (entry.image) {
    t.image = entry.image;
    t.needsUpdate = true;
  } else {
    entry.pendingTextures.push(t);
  }
  return t;
}

/**
 * Construct a three.js material from the server-side MaterialJson. Lit
 * shaders map onto MeshStandardMaterial; unlit onto MeshBasicMaterial.
 * "unknown" shaderKind defaults to lit — it's safer to over-light than
 * under-light, and most custom Aegis shaders are lit variants anyway.
 */
export function buildMaterial(
  src: MaterialJson,
  doubleSidedHint: boolean,
  opts: { unlitPreview?: boolean; flipY?: boolean } = {},
): THREE.Material {
  const baseColor = new THREE.Color(src.baseColor[0], src.baseColor[1], src.baseColor[2]);
  const alpha = src.baseColor[3];
  const transparent =
    src.renderMode === 'Transparent' || src.renderMode === 'Fade' || alpha < 0.999;
  const alphaTest = src.renderMode === 'Cutout' ? src.alphaCutoff : 0;
  const side = src.doubleSided || doubleSidedHint ? THREE.DoubleSide : THREE.FrontSide;
  const tiling = src.baseMapTiling;
  const offset = src.baseMapOffset;
  const flipY = opts.flipY;

  // Unlit-preview diagnostic: rebuild as MeshBasicMaterial with ONLY the
  // base map. This isolates UV sampling / texture loading from PBR
  // shading — if BATTLE ARENA appears here but not in the full render,
  // the bug is lighting / emission / metalness config. If it's missing
  // in both, the bug is upstream of shading (UV, flipY, PSD decode).
  if (opts.unlitPreview) {
    const m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1, 1, 1),
      opacity: alpha,
      transparent,
      alphaTest,
      side,
      toneMapped: false,
    });
    if (src.baseMapGuid) {
      m.map = getCachedTexture(src.baseMapGuid, { srgb: true, tiling, offset, flipY });
    } else {
      m.color = new THREE.Color(1, 0, 1);
    }
    return m;
  }
  // TEMP DEBUG: log every material that actually gets built so we can cross-
  // reference a "white" mesh in the viewer against the shader path, colour,
  // and base map guid that produced it. Emits once per name (build is called
  // per-instance but materials are cached upstream in materialList useMemo,
  // which dedupes per-scene-render).
  // eslint-disable-next-line no-console
  console.warn(
    `[buildMat] ${src.name} kind=${src.shaderKind} color=(${src.baseColor[0].toFixed(2)},${src.baseColor[1].toFixed(2)},${src.baseColor[2].toFixed(2)},${src.baseColor[3].toFixed(2)}) em=(${src.emissionColor[0].toFixed(2)},${src.emissionColor[1].toFixed(2)},${src.emissionColor[2].toFixed(2)}) baseMap=${src.baseMapGuid?.slice(0, 8) ?? 'none'} tile=${tiling ? `(${tiling[0]},${tiling[1]})` : '1,1'} off=${offset ? `(${offset[0]},${offset[1]})` : '0,0'}`,
  );

  if (src.shaderKind === 'unlit') {
    const m = new THREE.MeshBasicMaterial({
      color: baseColor,
      opacity: alpha,
      transparent,
      alphaTest,
      side,
      toneMapped: true,
    });
    if (src.baseMapGuid) {
      m.map = getCachedTexture(src.baseMapGuid, { srgb: true, tiling, offset, flipY });
    }
    return m;
  }

  const m = new THREE.MeshStandardMaterial({
    color: baseColor,
    opacity: alpha,
    transparent,
    alphaTest,
    side,
    metalness: src.metallic,
    roughness: 1 - src.smoothness,
    emissive: new THREE.Color(
      src.emissionColor[0],
      src.emissionColor[1],
      src.emissionColor[2],
    ),
    emissiveIntensity: 1,
  });

  if (src.baseMapGuid) {
    m.map = getCachedTexture(src.baseMapGuid, { srgb: true, tiling, offset, flipY });
  } else {
    // TEMP DEBUG: materials that reach lit-path without a base map render
    // with a tinted warning colour so we can distinguish "resolved but
    // textureless" from "texture failed to bind". Uses a cool cyan.
    m.color = new THREE.Color(0, 1, 1);
  }
  if (src.normalMapGuid) {
    m.normalMap = getCachedTexture(src.normalMapGuid, { srgb: false, tiling, offset, flipY });
    const s = src.normalScale || 1;
    m.normalScale = new THREE.Vector2(s, s);
  }
  if (src.metallicGlossMapGuid) {
    // URP packs metallic/smoothness into a single RGBA texture. Three reads
    // metalness from B and roughness from G; we assign to both slots so the
    // usual URP Lit authoring (metallic in R, smoothness in A) approximates
    // correctly on the final pixel.
    const tex = getCachedTexture(src.metallicGlossMapGuid, { srgb: false, tiling, offset, flipY });
    m.metalnessMap = tex;
    m.roughnessMap = tex;
  }
  if (src.occlusionMapGuid) {
    m.aoMap = getCachedTexture(src.occlusionMapGuid, { srgb: false, tiling, offset, flipY });
    m.aoMapIntensity = src.occlusionStrength;
  }
  if (src.emissionMapGuid) {
    m.emissiveMap = getCachedTexture(src.emissionMapGuid, { srgb: true, tiling, offset, flipY });
  }

  return m;
}

/**
 * Fallback material used when sceneParser couldn't resolve the GUID into a
 * MaterialJson (sparse-checkout missing the .mat, or the material file is
 * malformed). Uses `MeshStandardMaterial` so it still responds to scene
 * lights, but with a fixed roughness=0.8/metalness=0 "plastic" look.
 */
/**
 * Fixed 8-color palette used by the "debug submesh colors" toggle. Colors
 * are picked to be easy to name out loud in a bug report ("the wall is
 * blue", "the floor is yellow") and sufficiently distinct under typical
 * ambient lighting. We use `MeshBasicMaterial` so the palette is unaffected
 * by scene lights / shadows / fog — the whole point is to ISOLATE the
 * submesh-index → geometry question from every other rendering variable.
 */
export const DEBUG_SLOT_PALETTE: readonly string[] = [
  '#ff3b30', // slot 0 — red
  '#34c759', // slot 1 — green
  '#007aff', // slot 2 — blue
  '#ffcc00', // slot 3 — yellow
  '#af52de', // slot 4 — purple
  '#ff9500', // slot 5 — orange
  '#00c7be', // slot 6 — teal
  '#ff2d55', // slot 7 — pink
];

export function buildDebugSlotPalette(slotCount: number, doubleSidedHint: boolean): THREE.Material[] {
  const out: THREE.Material[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    out.push(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(DEBUG_SLOT_PALETTE[i % DEBUG_SLOT_PALETTE.length]),
        side: doubleSidedHint ? THREE.DoubleSide : THREE.FrontSide,
      }),
    );
  }
  return out;
}

/**
 * Procedural UV-diagnostic texture.
 *
 * Rendered as a 512×512 canvas with:
 *   - Checkerboard grid (8×8 squares) so stretching/rotation is obvious at
 *     a glance — a flat wall with an undistorted texture shows perfectly
 *     square tiles, while a wall whose UVs are squashed ends up with
 *     rectangular tiles.
 *   - Red arrow pointing along +U, green arrow along +V, starting at
 *     (u=0, v=0). Gives absolute orientation so we can tell "flipped
 *     horizontally" from "flipped vertically" from "rotated 90°" from
 *     "UV channel swapped".
 *   - A big "A" letter in the (u=0..0.5, v=0..0.5) quadrant; mirrored
 *     UVs show it back-to-front, so the "BATTLE ARENA reads reversed"
 *     symptom class is immediately decidable.
 *
 * We build it on an HTMLCanvasElement so we can use CanvasRenderingContext2D
 * text primitives without having to pack a glyph atlas into a shader.
 * The texture gets generated once and cached for the rest of the session.
 */
let _debugUvTexture: THREE.CanvasTexture | null = null;
function getDebugUvTexture(): THREE.CanvasTexture {
  if (_debugUvTexture) return _debugUvTexture;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // Should never hit in a modern browser, but fall back to a plain
    // CanvasTexture with an empty canvas rather than throwing — the
    // viewport will show solid black, which is itself a useful signal.
    _debugUvTexture = new THREE.CanvasTexture(canvas);
    return _debugUvTexture;
  }

  // Checker: 8×8 grid, alternating dark/light. Dark cells slightly tinted
  // magenta so the pattern is distinguishable from any genuine albedo
  // that happens to be monochrome.
  const cells = 8;
  const cellPx = size / cells;
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const even = (x + y) % 2 === 0;
      ctx.fillStyle = even ? '#2a1a2a' : '#e8e8e8';
      ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
    }
  }

  // Big "A" in the (u:0..0.5, v:0..0.5) quadrant. We draw the canvas in
  // standard top-left origin; since texture.flipY=true (three.js default),
  // the canvas's top row ends up at v=1 and bottom row at v=0. Bottom-left
  // of the canvas thus corresponds to UV origin, which is where we want
  // the "A" — so draw the glyph in the bottom-left canvas quadrant.
  ctx.fillStyle = '#111';
  ctx.font = `bold ${Math.floor(size * 0.42)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('A', size * 0.25, size * 0.75);

  // UV-axis arrows, originating at canvas bottom-left (= UV 0,0). Red=+U
  // going right; green=+V going up (canvas-up = texture-v-up once flipY
  // is applied).
  const origin: [number, number] = [size * 0.06, size * 0.94];
  const arrowLen = size * 0.38;
  const drawArrow = (to: [number, number], color: string, label: string) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(4, size / 96);
    ctx.beginPath();
    ctx.moveTo(origin[0], origin[1]);
    ctx.lineTo(to[0], to[1]);
    ctx.stroke();
    // Arrow head (simple triangle).
    const dx = to[0] - origin[0];
    const dy = to[1] - origin[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const head = size / 26;
    ctx.beginPath();
    ctx.moveTo(to[0], to[1]);
    ctx.lineTo(to[0] - ux * head - uy * head * 0.6, to[1] - uy * head + ux * head * 0.6);
    ctx.lineTo(to[0] - ux * head + uy * head * 0.6, to[1] - uy * head - ux * head * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.font = `bold ${Math.floor(size * 0.06)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, to[0] + ux * head * 1.4, to[1] + uy * head * 1.4);
  };
  drawArrow([origin[0] + arrowLen, origin[1]], '#e53935', '+U');
  drawArrow([origin[0], origin[1] - arrowLen], '#43a047', '+V');

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.flipY = true;
  tex.needsUpdate = true;
  _debugUvTexture = tex;
  return tex;
}

/**
 * Build a list of materials sharing the single cached UV-diagnostic
 * texture. Slot count matches the mesh so `geometry.groups[i].materialIndex`
 * still resolves, but every slot uses the same checkerboard so the
 * viewport only communicates UV layout / orientation — any remaining
 * variance is attributable to UVs alone.
 */
export function buildDebugUvMaterials(slotCount: number, doubleSidedHint: boolean): THREE.Material[] {
  const tex = getDebugUvTexture();
  const out: THREE.Material[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    out.push(
      new THREE.MeshBasicMaterial({
        map: tex,
        side: doubleSidedHint ? THREE.DoubleSide : THREE.FrontSide,
      }),
    );
  }
  return out;
}

function buildFallbackMaterial(
  _color: [number, number, number, number],
  _textureGuid: string | undefined,
  doubleSidedHint: boolean,
): THREE.Material {
  // TEMP DEBUG: bright magenta fallback. If the scene looks magenta-heavy
  // we know the name-based resolver is failing to bind submeshes; if the
  // scene looks right, the new code path is live and we can restore the
  // original tinted fallback.
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(1, 0, 1),
    roughness: 0.8,
    metalness: 0,
    side: doubleSidedHint ? THREE.DoubleSide : THREE.FrontSide,
  });
}

// ---------------------------------------------------------------- Geometry ----

function useInlineMeshGeometry(data: InlineMeshData | undefined): THREE.BufferGeometry | null {
  return useMemo(() => {
    if (!data) return null;
    const positions = new Float32Array(base64ToArrayBuffer(data.positionsB64));
    const indices = new Uint32Array(base64ToArrayBuffer(data.indicesB64));
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    // Inline ProBuilder meshes don't ship normals. MeshStandardMaterial needs
    // them to compute lighting — compute flat-ish per-vertex normals here
    // once. (Three.js averages adjacent-face normals automatically, which
    // gives reasonable smoothing for organic shapes and only mildly rounds
    // off hard edges on boxy ProBuilder geometry.)
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    return geom;
  }, [data]);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Status returned to `RendererProxy` so it can distinguish:
 *  - 'idle'    : this renderer has no `meshGuid` — use `builtinMesh` / inline.
 *  - 'pending' : FBX fetch/parse is still in flight; don't render anything
 *                yet (showing a cube fallback would be misleading).
 *  - 'ready'   : geometry is available.
 *  - 'failed'  : FBX is permanently unavailable; caller may render a
 *                diagnostic marker.
 */
export type FbxLoadStatus = 'idle' | 'pending' | 'ready' | 'failed';

function useFbxGeometry(
  guid: string | undefined,
  submeshName: string | undefined,
  fallbackName: string | undefined,
): {
  geometry: THREE.BufferGeometry | null;
  /** FBX-internal material names in submesh-index order, captured by the
   *  FBX parser before the embedded material objects are disposed. Empty
   *  when the mesh has no material slots (or FBXLoader couldn't see any). */
  materialNames: string[];
  unitScale: number;
  /** Quaternion baked into this geometry by fbxCache (typically the
   *  3ds Max Z→Y-up PreRotation). Surfaced so the renderer can cancel the
   *  bake on nodes whose scene YAML authoritatively specifies rotation —
   *  otherwise we'd double-apply the PreRotation. Identity by default. */
  bakedRotation: [number, number, number, number];
  hasBakedRotation: boolean;
  status: FbxLoadStatus;
  /** Which lookup hit for this geometry. Primarily for debug surfaces
   *  (the Inspector shows this so we can tell when the server-side
   *  submesh name lookup failed and we silently fell back to the
   *  GameObject name or the FBX's first mesh). */
  resolvedBy: 'submesh' | 'fallback' | 'first' | 'none';
} {
  const [state, setState] = useState<{
    geometry: THREE.BufferGeometry | null;
    materialNames: string[];
    unitScale: number;
    bakedRotation: [number, number, number, number];
    hasBakedRotation: boolean;
    status: FbxLoadStatus;
    resolvedBy: 'submesh' | 'fallback' | 'first' | 'none';
  }>({
    geometry: null,
    materialNames: [],
    unitScale: 1,
    bakedRotation: [0, 0, 0, 1],
    hasBakedRotation: false,
    status: guid ? 'pending' : 'idle',
    resolvedBy: 'none',
  });

  useEffect(() => {
    if (!guid) {
      setState({
        geometry: null,
        materialNames: [],
        unitScale: 1,
        bakedRotation: [0, 0, 0, 1],
        hasBakedRotation: false,
        status: 'idle',
        resolvedBy: 'none',
      });
      return;
    }
    setState({
      geometry: null,
      materialNames: [],
      unitScale: 1,
      bakedRotation: [0, 0, 0, 1],
      hasBakedRotation: false,
      status: 'pending',
      resolvedBy: 'none',
    });
    let cancelled = false;
    loadFbxGeometry(guid, submeshName, fallbackName)
      .then((result) => {
        if (cancelled) return;
        if (result.status === 'ready' && result.geometry) {
          setState({
            geometry: result.geometry,
            materialNames: result.materialNames,
            unitScale: result.unitScale,
            bakedRotation: result.bakedRotation,
            hasBakedRotation: result.hasBakedRotation,
            status: 'ready',
            resolvedBy: result.resolvedBy,
          });
        } else {
          console.warn(
            `[fbx] failed guid=${guid}${submeshName ? ' submesh=' + submeshName : ''}${fallbackName ? ' fallback=' + fallbackName : ''} status=${result.status}${result.reason ? ' reason=' + result.reason : ''}`,
          );
          setState({
            geometry: null,
            materialNames: [],
            unitScale: 1,
            bakedRotation: [0, 0, 0, 1],
            hasBakedRotation: false,
            status: 'failed',
            resolvedBy: 'none',
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(`[fbx] threw guid=${guid}: ${(err as Error).message}`);
        setState({
          geometry: null,
          materialNames: [],
          unitScale: 1,
          bakedRotation: [0, 0, 0, 1],
          hasBakedRotation: false,
          status: 'failed',
          resolvedBy: 'none',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [guid, submeshName, fallbackName]);

  return state;
}

// ---------------------------------------------------------------- Light budget ----

/**
 * Pick the subset of scene lights that should actually be instantiated in
 * three.js, staying under MAX_DIRECTIONAL_LIGHTS and MAX_POINT_SPOT_LIGHTS.
 *
 * We rank candidates by `intensity` within each category — brighter lights
 * survive the cap. This heuristic preserves the "key light" (the sun) and
 * the brightest local fills while silently dropping fill-density decorative
 * lights (e.g. fake path-guide point lights) that would otherwise blow the
 * WebGL uniform budget.
 *
 * Returns a Set of GameObject fileIDs whose lights are allowed to render.
 */
function pickVisibleLights(roots: GameObjectNode[]): Set<string> {
  interface LightEntry {
    fileID: string;
    intensity: number;
    type: GameObjectNode['light'] extends infer L
      ? L extends { type: infer T }
        ? T
        : never
      : never;
  }

  const directional: LightEntry[] = [];
  const pointSpot: LightEntry[] = [];

  const visit = (n: GameObjectNode): void => {
    if (!n.active) return;
    if (n.light) {
      const entry: LightEntry = {
        fileID: n.fileID,
        intensity: n.light.intensity,
        type: n.light.type,
      };
      if (n.light.type === 'Directional') directional.push(entry);
      else if (n.light.type === 'Point' || n.light.type === 'Spot') pointSpot.push(entry);
      // Area / Unknown are dropped regardless — they wouldn't render anyway.
    }
    for (const c of n.children) visit(c);
  };
  for (const r of roots) visit(r);

  directional.sort((a, b) => b.intensity - a.intensity);
  pointSpot.sort((a, b) => b.intensity - a.intensity);

  const allowed = new Set<string>();
  for (const l of directional.slice(0, MAX_DIRECTIONAL_LIGHTS)) allowed.add(l.fileID);
  for (const l of pointSpot.slice(0, MAX_POINT_SPOT_LIGHTS)) allowed.add(l.fileID);
  return allowed;
}

// ---------------------------------------------------------------- Primitives ----

function PrimitiveGeometry({
  kind,
}: {
  kind: NonNullable<GameObjectNode['renderer']>['builtinMesh'];
}) {
  switch (kind) {
    case 'Sphere':
      return <sphereGeometry args={[0.5, 24, 16]} />;
    case 'Cylinder':
      return <cylinderGeometry args={[0.5, 0.5, 2, 24]} />;
    case 'Capsule':
      return <capsuleGeometry args={[0.5, 1, 8, 16]} />;
    case 'Plane':
      return <planeGeometry args={[10, 10]} />;
    case 'Quad':
      return <planeGeometry args={[1, 1]} />;
    case 'Cube':
    default:
      return <boxGeometry args={[1, 1, 1]} />;
  }
}
