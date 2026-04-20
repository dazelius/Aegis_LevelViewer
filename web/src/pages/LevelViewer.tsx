import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {
  fetchScene,
  fetchRebakeStatus,
  isUnityExport,
  triggerRebake,
  type BatchStatus,
  type GameObjectNode,
  type SceneJson,
  type UnityExport,
} from '../lib/api';
import {
  DEBUG_SLOT_PALETTE,
  SceneRoots,
  SelectionProvider,
  type SceneSelection,
} from '../lib/sceneToR3F';
import { subscribeFbxCacheStats, type FbxCacheStats } from '../lib/fbxCache';
import {
  UnityExportRoots,
  UnityRenderSettingsApply,
  computeUnityExportFraming,
  getUnityExportStats,
} from '../lib/unityExportToR3F';

export default function LevelViewer() {
  const params = useParams();
  const relPath = decodeSplat(params['*'] ?? '');
  const [scene, setScene] = useState<SceneJson | UnityExport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!relPath) return;
    let cancelled = false;
    setScene(null);
    setError(null);
    (async () => {
      try {
        const data = await fetchScene(relPath);
        if (!cancelled) setScene(data);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relPath]);

  if (error) return <div className="status-banner">Failed to load scene: {error}</div>;
  if (!scene) return <div className="status-banner">Loading scene...</div>;

  if (isUnityExport(scene)) {
    return <UnityExportCanvas scene={scene} relPath={relPath} />;
  }
  return <ViewerCanvas scene={scene} relPath={relPath} />;
}

function ViewerCanvas({ scene, relPath }: { scene: SceneJson; relPath: string }) {
  const framing = useMemo(() => computeFraming(scene.roots), [scene]);
  const fbx = useFbxCacheStats();
  const [selection, setSelection] = useState<SceneSelection | null>(null);
  // Colliders (and disabled renderers) are hidden by default so the viewer
  // matches Unity's Game view. Flipping the HUD toggle shows them for
  // physics-hull debugging — useful when a prop clearly has the wrong
  // collision shape relative to its visual mesh.
  const [showColliders, setShowColliders] = useState(false);

  // Diagnostic: swap every mesh's textured material for a flat per-slot
  // color so the user can see at a glance which geometry references which
  // submesh slot, unmediated by UV or texture binding.
  const [debugSubmeshColors, setDebugSubmeshColors] = useState(false);

  // Diagnostic: swap every mesh's textured material for a checkerboard
  // UV texture with axis markers. Isolates UV-layout problems (mirror /
  // rotation / squash / wrong channel) from slot-binding problems.
  const [debugUvCheckerboard, setDebugUvCheckerboard] = useState(false);

  // Diagnostic: rebuild every lit material as MeshBasicMaterial with only
  // the base map — no PBR shading, no emission, no tone mapping. Isolates
  // "does the atlas texture paint the expected pixels" from every
  // lighting / shading variable.
  const [debugUnlitPreview, setDebugUnlitPreview] = useState(false);

  // Diagnostic: force `flipY = false` on every texture. Detects double-flip
  // bugs where the server-side decoder already emits GL-oriented image data
  // and three.js's default `flipY = true` inverts it a second time.
  const [debugFlipYOff, setDebugFlipYOff] = useState(false);

  // Per-FBX slot-permutation overrides, keyed by lowercased mesh GUID.
  // Edited from the Inspector when the selected object's FBX exhibits
  // slot-ordering mismatch between Unity and FBXLoader. A value of
  // `[2,1,0,3]` means "slot 0 should pull from m_Materials[2], slot 1
  // from [1], slot 2 from [0], slot 3 from [3]". Stored at the Canvas
  // level so all instances of the same FBX update together (matches
  // Unity's own binding granularity — edits to the imported FBX's
  // material remap affect every placement in the scene).
  const [slotPermutations, setSlotPermutations] = useState<Record<string, number[]>>({});
  const setSlotPermutation = (meshGuid: string, perm: number[] | null) => {
    setSlotPermutations((prev) => {
      const next = { ...prev };
      const key = meshGuid.toLowerCase();
      if (perm === null) delete next[key];
      else next[key] = perm;
      return next;
    });
  };

  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  return (
    <div className="viewer-root">
      <div className="viewer-hud">
        <div className="title">{scene.name}</div>
        <div className="muted">{scene.relPath}</div>
        <div>
          GameObjects: <b>{scene.stats.totalGameObjects}</b> &middot; Meshes:{' '}
          <b>{scene.stats.renderedMeshes}</b> &middot; Lights: <b>{scene.stats.lights}</b>{' '}
          &middot; Materials: <b>{scene.stats.materials}</b> &middot; Cameras:{' '}
          <b>{scene.stats.cameras}</b> &middot; Prefabs:{' '}
          <b>{scene.stats.prefabInstances}</b> &middot; InlineMeshes:{' '}
          <b>{scene.stats.inlineMeshes}</b>
          {scene.renderSettings?.fogEnabled && (
            <>
              {' '}
              &middot; Fog: <b>{scene.renderSettings.fogMode}</b>
            </>
          )}
        </div>
        <div className="muted">
          FBX assets: <b>{fbx.ready}</b> ready &middot; <b>{fbx.pending}</b> loading &middot;{' '}
          <b style={{ color: fbx.failed > 0 ? '#e67e7e' : undefined }}>{fbx.failed}</b> failed
          {' / '}
          {fbx.requested} requested
        </div>
        <div className="muted">
          Bounds center: [{framing.center[0].toFixed(1)}, {framing.center[1].toFixed(1)},{' '}
          {framing.center[2].toFixed(1)}] &middot; radius: {framing.radius.toFixed(1)}
        </div>
        <div className="hud-toggle-row">
          <button
            type="button"
            className={`hud-toggle${showColliders ? ' on' : ''}`}
            onClick={() => setShowColliders((v) => !v)}
            title="Toggle visibility of collider-only sub-trees and disabled renderers (m_Enabled=0). Off by default — matches Unity's Game view."
          >
            {showColliders ? 'Colliders: ON' : 'Colliders: OFF'}
          </button>
          <button
            type="button"
            className={`hud-toggle${debugSubmeshColors ? ' on' : ''}`}
            onClick={() => setDebugSubmeshColors((v) => !v)}
            title="Paint every mesh with per-slot solid colors (slot 0 red, 1 green, 2 blue, 3 yellow, …) so you can see which geometry references which submesh slot. Textures and lighting are bypassed — diagnostic only."
          >
            {debugSubmeshColors ? 'Submesh colors: ON' : 'Submesh colors: OFF'}
          </button>
          <button
            type="button"
            className={`hud-toggle${debugUvCheckerboard ? ' on' : ''}`}
            onClick={() => setDebugUvCheckerboard((v) => !v)}
            title="Paint every mesh with a UV checkerboard (red=+U arrow, green=+V arrow, mirrored 'A' glyph). Squares=UVs uniform; rectangles=stretched; flipped A=mirrored UVs. Diagnostic only."
          >
            {debugUvCheckerboard ? 'UV checker: ON' : 'UV checker: OFF'}
          </button>
          <button
            type="button"
            className={`hud-toggle${debugUnlitPreview ? ' on' : ''}`}
            onClick={() => setDebugUnlitPreview((v) => !v)}
            title="Render every lit material as unlit (MeshBasicMaterial) with only its base map. Isolates UV/texture from PBR shading — if an atlas glyph (BATTLE ARENA) shows up here but not in normal render, the bug is in lighting/emission."
          >
            {debugUnlitPreview ? 'Unlit preview: ON' : 'Unlit preview: OFF'}
          </button>
          <button
            type="button"
            className={`hud-toggle${debugFlipYOff ? ' on' : ''}`}
            onClick={() => setDebugFlipYOff((v) => !v)}
            title="Force flipY=false on every texture. Detects double-flip bugs where the server-side decoder already orients the image for GL and three.js's default flipY=true inverts it again."
          >
            {debugFlipYOff ? 'flipY: OFF (forced)' : 'flipY: ON (default)'}
          </button>
        </div>
        <RebakeButton relPath={relPath} />
      </div>
      <Canvas
        key={scene.relPath}
        camera={{
          position: framing.cameraPos,
          fov: 50,
          near: framing.near,
          far: framing.far,
        }}
        style={{ background: '#0b0d11' }}
        onPointerMissed={(e) => {
          // Click on empty space deselects. r3f fires this when no mesh
          // intercepted the pointer. Filter to button 0 so camera drags
          // that end on empty space don't clobber the selection.
          if ((e as MouseEvent).button === 0) setSelection(null);
        }}
      >
        <Suspense fallback={null}>
          {/* SceneRoots instantiates the scene lights + ambient + fog
              internally so we don't duplicate them here. */}
          <Grid
            args={[200, 200]}
            position={[0, framing.floorY, 0]}
            cellSize={Math.max(0.5, framing.radius / 40)}
            sectionSize={Math.max(5, framing.radius / 5)}
            cellThickness={0.6}
            sectionThickness={1.2}
            infiniteGrid
            fadeDistance={framing.radius * 6}
            fadeStrength={1}
            cellColor="#2a3242"
            sectionColor="#3c4a66"
          />
          <SelectionProvider
            selectedGroupUuid={selection?.groupUuid ?? null}
            setSelection={setSelection}
          >
            <SceneRoots
              roots={scene.roots}
              inlineMeshes={scene.inlineMeshes}
              materials={scene.materials}
              fbxExternalMaterials={scene.fbxExternalMaterials}
              materialNameIndex={scene.materialNameIndex}
              renderSettings={scene.renderSettings}
              showColliders={showColliders}
              debugSubmeshColors={debugSubmeshColors}
              debugUvCheckerboard={debugUvCheckerboard}
              debugUnlitPreview={debugUnlitPreview}
              debugFlipYOff={debugFlipYOff}
              slotPermutations={slotPermutations}
            />
          </SelectionProvider>
          <OrbitControls
            makeDefault
            target={framing.center}
            minDistance={framing.radius * 0.1}
            maxDistance={framing.radius * 10}
          />
          <axesHelper args={[Math.min(5, framing.radius * 0.1)]} />
        </Suspense>
      </Canvas>
      {selection && (
        <InspectorPanel
          selection={selection}
          materials={scene.materials}
          fbxExternalMaterials={scene.fbxExternalMaterials}
          materialNameIndex={scene.materialNameIndex}
          onClose={() => setSelection(null)}
          slotPermutations={slotPermutations}
          setSlotPermutation={setSlotPermutation}
          debugSubmeshColors={debugSubmeshColors}
        />
      )}
    </div>
  );
}

/**
 * HTML overlay that mirrors Unity's Inspector for the currently selected
 * GameObject. Deliberately flat/read-only — meant for side-by-side
 * comparison with the real Unity Inspector to diagnose transform, hierarchy,
 * or renderer binding discrepancies.
 */
function InspectorPanel({
  selection,
  materials,
  fbxExternalMaterials,
  materialNameIndex,
  onClose,
  slotPermutations,
  setSlotPermutation,
  debugSubmeshColors,
}: {
  selection: SceneSelection;
  materials?: Record<string, import('../lib/api').MaterialJson>;
  fbxExternalMaterials?: Record<string, Record<string, string>>;
  materialNameIndex?: Record<string, string>;
  onClose: () => void;
  slotPermutations: Record<string, number[]>;
  setSlotPermutation: (meshGuid: string, perm: number[] | null) => void;
  debugSubmeshColors: boolean;
}) {
  const { node, path, worldPosition, worldEulerDeg, worldScale } = selection;
  const t = node.transform;
  const q = t.quaternion;
  const eulerLocal = useMemo(() => {
    const quat = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    if (quat.lengthSq() < 1e-6) quat.identity();
    const e = new THREE.Euler().setFromQuaternion(quat, 'YXZ');
    const RAD2DEG = 180 / Math.PI;
    return [e.x * RAD2DEG, e.y * RAD2DEG, e.z * RAD2DEG] as [number, number, number];
  }, [q]);

  const fmt = (n: number): string => n.toFixed(3);
  const fmt1 = (n: number): string => n.toFixed(1);

  return (
    <div className="inspector-panel">
      <div className="inspector-head">
        <div className="inspector-title">{node.name || '(unnamed)'}</div>
        <button type="button" className="inspector-close" onClick={onClose} title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="inspector-path" title={path.join(' / ')}>
        {path.length > 1 ? path.slice(0, -1).join(' / ') : '(root)'}
      </div>
      <div className="inspector-meta">
        fileID: <code>{node.fileID}</code>
        {!node.active && <span className="inspector-chip">inactive</span>}
        {node.isCollider && (
          <span className="inspector-chip collider" title="Hidden by default — this GameObject lives under a collider-only sub-tree. Use the HUD 'Colliders' toggle to show.">
            collider
          </span>
        )}
        {node.renderer && <span className="inspector-chip">MeshRenderer</span>}
        {node.renderer?.enabled === false && (
          <span className="inspector-chip collider" title="MeshRenderer.m_Enabled = 0 in the scene YAML; Unity would not draw this.">
            renderer disabled
          </span>
        )}
        {node.light && <span className="inspector-chip">Light ({node.light.type})</span>}
        {node.camera && <span className="inspector-chip">Camera</span>}
      </div>

      {/* Unity Inspector에 직접 붙여 비교할 수 있도록, 우리 내부 좌표계(Three,
          오른손)를 Unity 좌표계(왼손)로 되돌린 값을 함께 표시합니다.
          같은 이름의 prefab instance가 여러 개일 때 어느 인스턴스인지
          (position/scale/path) 로 빠르게 판별할 수 있어야 오브젝트 피킹이
          오인된 건지, 진짜 렌더링 버그인지 구분이 됩니다. */}
      <div className="inspector-section">Local Transform · Unity</div>
      <div className="inspector-row">
        <span className="inspector-label">Position</span>
        <span className="inspector-val">
          {fmt(-t.position[0])}, {fmt(t.position[1])}, {fmt(t.position[2])}
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Rotation</span>
        <span className="inspector-val">
          {fmt1(eulerLocal[0])}°, {fmt1(-eulerLocal[1])}°, {fmt1(-eulerLocal[2])}°
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Scale</span>
        <span className="inspector-val">
          {fmt(t.scale[0])}, {fmt(t.scale[1])}, {fmt(t.scale[2])}
        </span>
      </div>

      <div className="inspector-section">World Transform · Unity</div>
      <div className="inspector-row">
        <span className="inspector-label">Position</span>
        <span className="inspector-val">
          {fmt(-worldPosition[0])}, {fmt(worldPosition[1])}, {fmt(worldPosition[2])}
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Rotation</span>
        <span className="inspector-val">
          {fmt1(worldEulerDeg[0])}°, {fmt1(-worldEulerDeg[1])}°, {fmt1(-worldEulerDeg[2])}°
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Scale</span>
        <span className="inspector-val">
          {fmt(worldScale[0])}, {fmt(worldScale[1])}, {fmt(worldScale[2])}
        </span>
      </div>

      <div className="inspector-section">Local Transform · three.js (internal)</div>
      <div className="inspector-row">
        <span className="inspector-label">Position</span>
        <span className="inspector-val">
          {fmt(t.position[0])}, {fmt(t.position[1])}, {fmt(t.position[2])}
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Rotation</span>
        <span className="inspector-val">
          {fmt1(eulerLocal[0])}°, {fmt1(eulerLocal[1])}°, {fmt1(eulerLocal[2])}°
        </span>
      </div>

      <div className="inspector-section">World Transform · three.js (internal)</div>
      <div className="inspector-row">
        <span className="inspector-label">Position</span>
        <span className="inspector-val">
          {fmt(worldPosition[0])}, {fmt(worldPosition[1])}, {fmt(worldPosition[2])}
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">Rotation</span>
        <span className="inspector-val">
          {fmt1(worldEulerDeg[0])}°, {fmt1(worldEulerDeg[1])}°, {fmt1(worldEulerDeg[2])}°
        </span>
      </div>

      <div className="inspector-hint">
        "Unity" 행은 왼손(Unity)좌표계로 환산한 값입니다. Unity Inspector 값과
        그대로 비교하세요. 동일한 이름이 여러 개라면 Hierarchy 경로(위)와
        world position까지 맞아떨어지는 인스턴스만 같은 객체입니다.
      </div>

      {node.renderer && (
        <>
          <div className="inspector-section">Renderer</div>
          <div className="inspector-row">
            <span className="inspector-label">Mesh</span>
            <span className="inspector-val">
              {node.renderer.meshName ?? '(inline)'}{' '}
              <code className="inspector-guid">{node.renderer.meshGuid ?? ''}</code>
            </span>
          </div>
          {(node.renderer.meshSubmeshName || node.renderer.meshFileID) && (
            <div className="inspector-row">
              <span className="inspector-label">Submesh</span>
              <span className="inspector-val">
                {node.renderer.meshSubmeshName ?? <em>(fallback to first)</em>}{' '}
                {node.renderer.meshFileID && (
                  <code className="inspector-guid">fileID {node.renderer.meshFileID}</code>
                )}
              </span>
            </div>
          )}
          {selection.meshInfo && (
            <>
              <div className="inspector-row">
                <span className="inspector-label">Geometry</span>
                <span className="inspector-val">
                  verts={selection.meshInfo.vertexCount} · UV
                  channels=<b>{selection.meshInfo.uvChannelCount}</b> · submesh groups=
                  <b>{selection.meshInfo.groupCount}</b>
                </span>
              </div>
              {(selection.pickUv || selection.pickFaceUvBounds) && (
                <div className="inspector-row">
                  <span className="inspector-label">Pick UV</span>
                  <span className="inspector-val">
                    {selection.pickUv && (
                      <code
                        className="inspector-guid"
                        title="UV0 at the exact ray-intersection point on the picked triangle. In [0,1] this is the atlas tile the shader samples at that pixel."
                      >
                        uv=({selection.pickUv[0].toFixed(3)},{' '}
                        {selection.pickUv[1].toFixed(3)})
                      </code>
                    )}
                    {selection.pickFaceUvBounds && (
                      <>
                        {' '}
                        <code
                          className="inspector-guid"
                          title="UV0 bounding box of the picked triangle's 3 vertices — the atlas sub-range this face samples"
                        >
                          face=({selection.pickFaceUvBounds[0].toFixed(3)}..
                          {selection.pickFaceUvBounds[2].toFixed(3)},{' '}
                          {selection.pickFaceUvBounds[1].toFixed(3)}..
                          {selection.pickFaceUvBounds[3].toFixed(3)})
                        </code>
                      </>
                    )}
                    {typeof selection.pickMaterialIndex === 'number' && (
                      <>
                        {' '}· slot <b>{selection.pickMaterialIndex}</b>
                      </>
                    )}
                  </span>
                </div>
              )}
              {selection.meshInfo.groups.length > 0 && (
                <div className="inspector-row">
                  <span className="inspector-label">Groups</span>
                  <span className="inspector-val">
                    {selection.meshInfo.groups.map(([s, c, m], i) => {
                      // Resolve what ACTUALLY got drawn on this group. The
                      // renderer snapshots its per-slot binding decision onto
                      // `mesh.userData.slotBindings`, keyed by slot = group's
                      // materialIndex. When `matName` here disagrees with
                      // what Unity's MeshRenderer Inspector shows at the
                      // same slot, we've found the "material order is right
                      // but drawing is wrong" bug: FBXLoader's group order
                      // diverged from Unity's submesh order, so Unity's
                      // m_Materials[m] got painted on geometry that Unity
                      // itself would draw with a different slot. The FBX-
                      // embedded name makes that divergence concrete.
                      const bind = selection.meshInfo?.slotBindings?.[m];
                      const fbxName = bind?.fbxEmbeddedName;
                      const uvBB = selection.meshInfo?.groupUvBounds?.[i];
                      return (
                        <div key={i} className="inspector-mat">
                          [{i}] start={s} count={c} → slot <b>{m}</b>
                          {uvBB && (
                            <>
                              {' '}
                              <code
                                className="inspector-guid"
                                title="UV0 bounding box (uMin..uMax, vMin..vMax) — pick the atlas tile this group samples"
                              >
                                uv=({uvBB[0].toFixed(3)}..{uvBB[2].toFixed(3)},{' '}
                                {uvBB[1].toFixed(3)}..{uvBB[3].toFixed(3)})
                              </code>
                            </>
                          )}
                          {bind && bind.matName && (
                            <>
                              {' '}· <b>{bind.matName}</b>
                              {bind.baseMapGuid && (
                                <>
                                  {' '}
                                  <code className="inspector-guid">
                                    tex:{bind.baseMapGuid}
                                  </code>
                                </>
                              )}
                            </>
                          )}
                          {fbxName && (
                            <>
                              {' '}
                              <span
                                className="inspector-chip-mini"
                                style={{
                                  color:
                                    bind?.matName &&
                                    fbxName.replace(/_M$/, '') !==
                                      bind.matName.replace(/_M$/, '')
                                      ? '#ffcf7a'
                                      : undefined,
                                }}
                                title="FBX-embedded material name at this slot"
                              >
                                fbx:{fbxName}
                              </span>
                            </>
                          )}
                        </div>
                      );
                    })}
                    {selection.meshInfo.groupCount > selection.meshInfo.groups.length && (
                      <div className="inspector-mat">
                        <em>… +{selection.meshInfo.groupCount - selection.meshInfo.groups.length} more</em>
                      </div>
                    )}
                  </span>
                </div>
              )}
            </>
          )}
          {node.renderer.meshGuid && node.renderer.materialGuids.length >= 2 && (
            <SlotPermutationEditor
              meshGuid={node.renderer.meshGuid}
              materialGuids={node.renderer.materialGuids}
              materials={materials}
              fbxRemap={
                fbxExternalMaterials?.[node.renderer.meshGuid.toLowerCase()] ??
                fbxExternalMaterials?.[node.renderer.meshGuid]
              }
              materialNameIndex={materialNameIndex}
              slotBindings={selection.meshInfo?.slotBindings}
              permutation={slotPermutations[node.renderer.meshGuid.toLowerCase()]}
              onChange={(perm) => setSlotPermutation(node.renderer!.meshGuid!, perm)}
              debugSubmeshColors={debugSubmeshColors}
            />
          )}
          <div className="inspector-row">
            <span className="inspector-label">Materials</span>
            <span className="inspector-val">
              {(() => {
                const allGuids = node.renderer.materialGuids;
                // Submesh groups authoritatively decide which slots matter.
                // When the mesh is loaded, clamp to `max(materialIndex) + 1`
                // so scene-authored slots beyond that (prefab padding,
                // leftover DM_PropSet entries inherited from variants) drop
                // out of the Inspector — mirroring what `materialList` now
                // emits in the renderer so the panel doesn't claim phantom
                // bindings Unity itself never samples.
                //
                // Before the geometry arrives (or for empty m_Materials)
                // `usedSlotCount` is 0; we fall back to the full list so
                // authoring mistakes (truly empty slot 0) stay visible.
                const used = selection.meshInfo?.usedSlotCount ?? 0;
                const visibleCount =
                  used > 0 && allGuids.length > 0
                    ? Math.min(used, allGuids.length)
                    : allGuids.length;
                const hidden = allGuids.length - visibleCount;
                const visible = allGuids.slice(0, visibleCount);
                if (allGuids.length === 0) return <em>none</em>;
                return (
                  <>
                    {visible.map((g, i) => {
                      const m = g && materials?.[g];
                      const tile = m?.baseMapTiling;
                      const off = m?.baseMapOffset;
                      const fmt = (n: number): string => n.toFixed(2);
                      return (
                        <div key={i} className="inspector-mat">
                          [{i}] {m?.name ?? '(unresolved)'}
                          {m?.shaderKind && (
                            <span className="inspector-chip-mini">{m.shaderKind}</span>
                          )}
                          <br />
                          <code className="inspector-guid">{g ?? 'null'}</code>
                          {m && (
                            <div className="inspector-mat-detail">
                              baseMap={m.baseMapGuid ? (
                                <code className="inspector-guid">
                                  {m.baseMapGuid.slice(0, 8)}
                                </code>
                              ) : (
                                <em>none</em>
                              )}
                              {' · '}tile=
                              <b
                                style={{
                                  color:
                                    tile && (tile[0] !== 1 || tile[1] !== 1)
                                      ? '#ffcf7a'
                                      : undefined,
                                }}
                              >
                                {tile ? `(${fmt(tile[0])}, ${fmt(tile[1])})` : '(1, 1)'}
                              </b>
                              {' · '}off=
                              <b
                                style={{
                                  color:
                                    off && (off[0] !== 0 || off[1] !== 0)
                                      ? '#ffcf7a'
                                      : undefined,
                                }}
                              >
                                {off ? `(${fmt(off[0])}, ${fmt(off[1])})` : '(0, 0)'}
                              </b>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {hidden > 0 && (
                      <div className="inspector-mat inspector-mat-dead">
                        <em>
                          … +{hidden} unused slot{hidden > 1 ? 's' : ''} (authored in scene,
                          no submesh samples them)
                        </em>
                      </div>
                    )}
                  </>
                );
              })()}
            </span>
          </div>
        </>
      )}
      {node.light && (
        <>
          <div className="inspector-section">Light</div>
          <div className="inspector-row">
            <span className="inspector-label">Type</span>
            <span className="inspector-val">{node.light.type}</span>
          </div>
          <div className="inspector-row">
            <span className="inspector-label">Color</span>
            <span className="inspector-val">
              {fmt(node.light.color[0])}, {fmt(node.light.color[1])}, {fmt(node.light.color[2])}
            </span>
          </div>
          <div className="inspector-row">
            <span className="inspector-label">Intensity</span>
            <span className="inspector-val">{fmt(node.light.intensity)}</span>
          </div>
          {(node.light.type === 'Point' || node.light.type === 'Spot') && (
            <div className="inspector-row">
              <span className="inspector-label">Range</span>
              <span className="inspector-val">{fmt(node.light.range)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface Framing {
  center: [number, number, number];
  cameraPos: [number, number, number];
  radius: number;
  near: number;
  far: number;
  floorY: number;
}

/**
 * Inspector sub-panel that lets the user re-order the material slots for
 * the selected FBX. Renders one dropdown per slot (capped at 16 to avoid
 * pathological cases), each picking an index into the original
 * `m_Materials` array — so the dropdown values are "what does this slot
 * *now* sample from m_Materials". Applying the identity permutation
 * `[0,1,…,N-1]` is equivalent to clearing the override.
 *
 * Why an editor instead of auto-detection: when Unity's submesh ordering
 * and three.js FBXLoader's `group.materialIndex` ordering disagree there's
 * no name-based signal to lean on (3ds Max-exported FBXs name their
 * materials `MATERIAL #4099`, `#597`, …). The reliable way to find the
 * right permutation is to let a human look at the scene and say "walls
 * should be blue" — this UI makes that experiment a one-click action.
 *
 * Per-FBX (keyed by meshGuid), not per-instance: every scene placement of
 * the same FBX shares one permutation. Matches Unity's own remap granular-
 * ity and prevents the same experiment from fragmenting across hundreds of
 * placements.
 */
function SlotPermutationEditor({
  meshGuid,
  materialGuids,
  materials,
  fbxRemap,
  materialNameIndex,
  slotBindings,
  permutation,
  onChange,
  debugSubmeshColors,
}: {
  meshGuid: string;
  materialGuids: string[];
  materials?: Record<string, import('../lib/api').MaterialJson>;
  /** ModelImporter.externalObjects remap for this FBX: FBX-embedded
   *  material name -> external `.mat` GUID. Used by the Auto button to
   *  compute the correct permutation by GUID-matching each submesh's
   *  FBX-intended material against Unity's scene-level m_Materials. */
  fbxRemap?: Record<string, string>;
  /** Project-wide `.mat` name → GUID index. Used as a fallback when the
   *  FBX `.meta` has `externalObjects: {}` but `materialSearch: 1`
   *  (Recursive-Up) + `materialName: 0` (From Model's Material) — Unity
   *  resolves each FBX-embedded material name by project-wide search, and
   *  we mirror that here. */
  materialNameIndex?: Record<string, string>;
  /** Per-slot bindings snapshotted at selection time. We need the
   *  `fbxEmbeddedName` to drive Auto-detect. */
  slotBindings?: import('../lib/sceneToR3F').MeshInfoSnapshot['slotBindings'];
  permutation: number[] | undefined;
  onChange: (perm: number[] | null) => void;
  debugSubmeshColors: boolean;
}) {
  const slotCount = Math.min(materialGuids.length, 16);
  const current: number[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    const src = permutation?.[i];
    current.push(typeof src === 'number' && src >= 0 && src < slotCount ? src : i);
  }

  const isIdentity = current.every((v, i) => v === i);

  // Compute what Unity's material binding WOULD be if we followed the FBX
  // ModelImporter's externalObjects remap (Unity's authored name->GUID
  // table) instead of the scene's positional m_Materials[] binding.
  //
  // The permutation editor's default assumption is: FBXLoader's submesh N
  // ↔ Unity's m_Materials[N]. That breaks when FBXLoader's material array
  // order diverges from Unity's import-time binding order (common for
  // FBXs authored in Max/Maya where the material ordering in the binary
  // doesn't match Unity's ordering after externalObjects remap).
  //
  // For each FBX slot N, we look up the embedded material name in the
  // remap table to find its "intended" .mat GUID G, then locate G in
  // materialGuids[] to find Unity's true slot index J. perm[N]=J then
  // routes the right material to the right submesh.
  //
  // Returns null when auto-detect is not actionable (missing inputs,
  // remap doesn't resolve for every slot, or the computed permutation
  // is identity — same as default, nothing to apply).
  const autoDiagnosis = useMemo<{
    permutation: number[] | null;
    /** Non-null whenever the Auto button is unavailable; explains why so
     *  the user isn't left guessing why the button never appears. */
    reason: string | null;
    /** Per-slot breakdown shown under the button for transparency. */
    perSlot: Array<{
      fbxName: string;
      resolvedGuid: string;
      /** Where the GUID came from: externalObjects remap, project-wide
       *  name index (Unity materialSearch: Recursive-Up), or neither. */
      source: 'remap' | 'name-index' | 'none';
      matchedSlot: number | null;
    }>;
  }>(() => {
    const perSlot: Array<{
      fbxName: string;
      resolvedGuid: string;
      source: 'remap' | 'name-index' | 'none';
      matchedSlot: number | null;
    }> = [];
    if (!slotBindings || slotBindings.length === 0) {
      return { permutation: null, reason: 'slotBindings not available yet (mesh still loading?)', perSlot };
    }
    const remapHasEntries = fbxRemap && Object.keys(fbxRemap).length > 0;
    const nameIndexHasEntries =
      materialNameIndex && Object.keys(materialNameIndex).length > 0;
    if (!remapHasEntries && !nameIndexHasEntries) {
      return {
        permutation: null,
        reason: `Neither FBX externalObjects remap nor project-wide .mat name index is available for ${meshGuid.slice(0, 8)}`,
        perSlot,
      };
    }
    const guidToSlot = new Map<string, number>();
    for (let j = 0; j < materialGuids.length; j += 1) {
      const g = (materialGuids[j] ?? '').toLowerCase();
      if (g && !guidToSlot.has(g)) guidToSlot.set(g, j);
    }
    // Build a case-insensitive view of the materialNameIndex so embedded
    // FBX names (which might differ in case from .mat asset names) still
    // resolve. First exact match wins.
    const nameIndexCI = new Map<string, string>();
    if (nameIndexHasEntries) {
      for (const [name, guid] of Object.entries(materialNameIndex!)) {
        if (!name || !guid) continue;
        const key = name.toLowerCase();
        if (!nameIndexCI.has(key)) nameIndexCI.set(key, guid.toLowerCase());
      }
    }
    const resolveName = (name: string): { guid: string; source: 'remap' | 'name-index' | 'none' } => {
      if (!name) return { guid: '', source: 'none' };
      if (remapHasEntries) {
        const g = (fbxRemap![name] ?? '').toLowerCase();
        if (g) return { guid: g, source: 'remap' };
      }
      if (nameIndexHasEntries) {
        // Unity's materialName: 0 ("From Model's Material") uses the FBX
        // embedded name verbatim. Try exact, then common suffix variants
        // Max/Maya pipelines apply (e.g. "_M" for Material asset naming).
        const tries = [name, `${name}_M`, `${name}_mat`, name.replace(/_M$/i, '')];
        for (const t of tries) {
          const g = nameIndexCI.get(t.toLowerCase());
          if (g) return { guid: g, source: 'name-index' };
        }
      }
      return { guid: '', source: 'none' };
    };
    const perm: number[] = [];
    let firstFailReason: string | null = null;
    for (let i = 0; i < slotCount; i += 1) {
      const b = slotBindings[i];
      const fbxName = b?.fbxEmbeddedName ?? '';
      const { guid: resolvedGuid, source } = resolveName(fbxName);
      const matchedSlot = resolvedGuid ? (guidToSlot.get(resolvedGuid) ?? null) : null;
      perSlot.push({ fbxName, resolvedGuid, source, matchedSlot });
      if (!fbxName) {
        firstFailReason = firstFailReason ?? `slot ${i} has no FBX-embedded name`;
        perm.push(i);
        continue;
      }
      if (!resolvedGuid) {
        // 3ds Max exports materials with internal node IDs as names
        // ("Material #500", "Material #4099"). Those are meaningless
        // outside the FBX binary and cannot be mapped to a `.mat` file
        // by any name-based lookup. Call this out specifically so the
        // user knows Auto-detect is fundamentally impossible for this
        // FBX and falls back to the cyclic-shift helpers below.
        const isAnonMaxId = /^Material\s*#\d+$/i.test(fbxName);
        firstFailReason =
          firstFailReason ??
          (isAnonMaxId
            ? `slot ${i}: FBX name "${fbxName}" is a 3ds Max internal node ID (not a real material name). Use the Cycle ↻/↺ buttons to brute-force the correct slot rotation.`
            : `slot ${i}: FBX name "${fbxName}" not resolved via externalObjects remap nor project-wide .mat search`);
        perm.push(i);
        continue;
      }
      if (matchedSlot === null) {
        firstFailReason =
          firstFailReason ??
          `slot ${i}: resolved GUID ${resolvedGuid.slice(0, 8)} (via ${source}) not present in scene m_Materials[]`;
        perm.push(i);
        continue;
      }
      perm.push(matchedSlot);
    }
    if (firstFailReason) {
      return { permutation: null, reason: firstFailReason, perSlot };
    }
    const allIdentity = perm.every((v, k) => v === k);
    if (allIdentity) {
      return {
        permutation: null,
        reason: 'Computed permutation equals the identity — Unity and FBXLoader agree on ordering for this FBX',
        perSlot,
      };
    }
    return { permutation: perm, reason: null, perSlot };
  }, [fbxRemap, materialNameIndex, slotBindings, materialGuids, slotCount, meshGuid]);

  const autoPermutation = autoDiagnosis.permutation;
  const autoDiffersFromCurrent =
    autoPermutation !== null &&
    (autoPermutation.length !== current.length ||
      autoPermutation.some((v, i) => v !== current[i]));

  const setSlotSource = (slotIdx: number, newSrc: number) => {
    const next = current.slice();
    next[slotIdx] = newSrc;
    const allIdentity = next.every((v, i) => v === i);
    onChange(allIdentity ? null : next);
  };

  const swapWithNeighbor = (i: number, j: number) => {
    const next = current.slice();
    [next[i], next[j]] = [next[j], next[i]];
    const allIdentity = next.every((v, k) => v === k);
    onChange(allIdentity ? null : next);
  };

  // Determine how many leading slots are actually "populated" — i.e. the
  // FBX bound a non-empty embedded name. Trailing empty slots usually
  // come from scene-authored m_Materials padding that never reaches an
  // actual submesh, so we exclude them from cyclic rotations to avoid
  // scrambling the indices that matter.
  const populatedCount = (() => {
    if (!slotBindings || slotBindings.length === 0) return slotCount;
    let n = 0;
    for (let i = 0; i < slotCount; i += 1) {
      if ((slotBindings[i]?.fbxEmbeddedName ?? '') !== '') n = i + 1;
    }
    // Fall back to full range if no slot had an embedded name (can't
    // tell which are padding vs real, so let the user rotate all).
    return n === 0 ? slotCount : n;
  })();

  /** Cyclically shift the first `populatedCount` slots by `delta`. Positive
   *  delta means "slot 0 picks up the material that slot `delta` used to
   *  have" — i.e. forward rotation. [0,1,2,3,4,5,6] with delta=1 and
   *  populatedCount=3 → [1,2,0,3,4,5,6], which matches the `[1,2,0,3,...]`
   *  permutation the user manually discovered fixes DM_BLDG_ATeam_A. */
  const cycleShift = (delta: number) => {
    if (populatedCount <= 1) return;
    const next = current.slice();
    const window = next.slice(0, populatedCount);
    const n = window.length;
    const d = ((delta % n) + n) % n;
    const shifted = window.slice(d).concat(window.slice(0, d));
    for (let i = 0; i < n; i += 1) next[i] = shifted[i];
    const allIdentity = next.every((v, k) => v === k);
    onChange(allIdentity ? null : next);
  };

  const matLabel = (idx: number): string => {
    const g = materialGuids[idx];
    if (!g) return `[${idx}] (unresolved)`;
    const m = g && materials ? materials[g] : undefined;
    return `[${idx}] ${m?.name ?? g.slice(0, 8)}`;
  };

  return (
    <div className="inspector-row">
      <span className="inspector-label">Slot remap</span>
      <span className="inspector-val">
        <div className="inspector-mat-detail" style={{ marginBottom: 4 }}>
          Override which `m_Materials[N]` feeds each submesh slot. Same FBX
          ({meshGuid.slice(0, 8)}) across every instance. Groups are
          auto-reordered at FBX load time to match Unity's first-appearance
          submesh ordering, so the default (identity) permutation should be
          correct — use these controls only as a diagnostic fallback.
        </div>
        {current.map((src, i) => (
          <div
            key={i}
            className="inspector-mat"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span
              title={`Slot ${i} palette color in debug-submesh mode`}
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 2,
                background: DEBUG_SLOT_PALETTE[i % DEBUG_SLOT_PALETTE.length],
                outline: debugSubmeshColors ? '1px solid #fff' : 'none',
              }}
            />
            <span>slot {i} ←</span>
            <select
              value={src}
              onChange={(e) => setSlotSource(i, Number(e.target.value))}
              style={{ flex: 1 }}
            >
              {materialGuids.slice(0, slotCount).map((_g, idx) => (
                <option key={idx} value={idx}>
                  {matLabel(idx)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="hud-toggle"
              disabled={i === 0}
              onClick={() => swapWithNeighbor(i, i - 1)}
              title="Swap with slot above"
              style={{ padding: '0 6px' }}
            >
              ↑
            </button>
            <button
              type="button"
              className="hud-toggle"
              disabled={i === slotCount - 1}
              onClick={() => swapWithNeighbor(i, i + 1)}
              title="Swap with slot below"
              style={{ padding: '0 6px' }}
            >
              ↓
            </button>
          </div>
        ))}
        <div className="inspector-mat-detail" style={{ marginTop: 6, lineHeight: 1.4 }}>
          <div>
            <b>Auto-detect:</b>{' '}
            {autoPermutation ? (
              <>
                <code className="inspector-guid">[{autoPermutation.join(', ')}]</code>{' '}
                <span style={{ color: '#7ad4ff' }}>available</span>
              </>
            ) : (
              <span style={{ color: '#ffcf7a' }}>not actionable</span>
            )}
          </div>
          {autoDiagnosis.reason && (
            <div style={{ color: '#ffcf7a', fontSize: 11 }}>
              reason: {autoDiagnosis.reason}
            </div>
          )}
          {autoDiagnosis.perSlot.length > 0 && (
            <div style={{ fontSize: 11, marginTop: 2 }}>
              {autoDiagnosis.perSlot.map((r, i) => (
                <div key={i}>
                  slot {i}: fbx=<code className="inspector-guid">{r.fbxName || '(empty)'}</code>
                  {' → '}
                  {r.resolvedGuid ? (
                    <>
                      <code className="inspector-guid">{r.resolvedGuid.slice(0, 8)}</code>
                      <span
                        style={{
                          color: r.source === 'remap' ? '#7ad4ff' : '#b4e47a',
                          marginLeft: 4,
                        }}
                      >
                        ({r.source})
                      </span>
                    </>
                  ) : (
                    <span style={{ color: '#ffcf7a' }}>no match</span>
                  )}
                  {' → '}
                  {r.matchedSlot !== null ? (
                    <b>m_Materials[{r.matchedSlot}]</b>
                  ) : (
                    <span style={{ color: '#ffcf7a' }}>no m_Materials match</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button
            type="button"
            className="hud-toggle"
            disabled={isIdentity}
            onClick={() => onChange(null)}
            title="Restore Unity's default slot assignment for this FBX"
          >
            Reset
          </button>
          <button
            type="button"
            className="hud-toggle"
            onClick={() => {
              // Reverse is the single most useful one-click probe when the
              // Unity/FBXLoader disagreement is a straight flip of the
              // material list (which happens for certain Max exports).
              const rev = current.slice().reverse();
              const allIdentity = rev.every((v, k) => v === k);
              onChange(allIdentity ? null : rev);
            }}
            title="Reverse the current slot order ([0,1,2,3] → [3,2,1,0])"
          >
            Reverse
          </button>
          {autoPermutation && (
            <button
              type="button"
              className={`hud-toggle${autoDiffersFromCurrent ? ' on' : ''}`}
              disabled={!autoDiffersFromCurrent}
              onClick={() => onChange(autoPermutation)}
              title={`Apply name-based permutation derived from the FBX ModelImporter externalObjects remap. Computed: [${autoPermutation.join(', ')}]`}
            >
              Auto [{autoPermutation.join(',')}]
            </button>
          )}
          <button
            type="button"
            className="hud-toggle"
            disabled={populatedCount <= 1}
            onClick={() => cycleShift(1)}
            title={`Forward cyclic shift on first ${populatedCount} slot(s): [0,1,2,...] → [1,2,0,...]. Click repeatedly to explore all rotations.`}
          >
            Cycle ↻
          </button>
          <button
            type="button"
            className="hud-toggle"
            disabled={populatedCount <= 1}
            onClick={() => cycleShift(-1)}
            title={`Reverse cyclic shift on first ${populatedCount} slot(s): [0,1,2,...] → [2,0,1,...].`}
          >
            Cycle ↺
          </button>
          {!isIdentity && (
            <span
              className="inspector-chip-mini"
              style={{ alignSelf: 'center', color: '#ffcf7a' }}
              title="This FBX is using a manual slot remap"
            >
              overridden: [{current.join(', ')}]
            </span>
          )}
        </div>
      </span>
    </div>
  );
}

/**
 * React hook that mirrors the global FBX cache counters into component state.
 * Lets the HUD show a live "X of Y FBX assets ready" indicator without having
 * to poll — the fbxCache publishes synchronously whenever a fetch settles.
 */
function useFbxCacheStats(): FbxCacheStats {
  const [stats, setStats] = useState<FbxCacheStats>(() => ({
    requested: 0,
    pending: 0,
    ready: 0,
    failed: 0,
  }));
  useEffect(() => subscribeFbxCacheStats(setStats), []);
  return stats;
}

/**
 * Compute a bounding sphere from all transform positions in the scene so the
 * initial camera frames the content rather than sitting at a fixed 10,10,10
 * that might be thousands of units away from where the GameObjects actually
 * live.
 */
function computeFraming(roots: GameObjectNode[]): Framing {
  const bbox = new THREE.Box3();
  bbox.makeEmpty();
  const scratch = new THREE.Vector3();
  let count = 0;

  const visit = (
    node: GameObjectNode,
    parentMatrix: THREE.Matrix4,
  ): void => {
    const local = new THREE.Matrix4();
    const pos = new THREE.Vector3(
      node.transform.position[0],
      node.transform.position[1],
      node.transform.position[2],
    );
    const quat = new THREE.Quaternion(
      node.transform.quaternion[0],
      node.transform.quaternion[1],
      node.transform.quaternion[2],
      node.transform.quaternion[3],
    );
    if (quat.lengthSq() < 1e-6) quat.identity();
    const scale = new THREE.Vector3(
      node.transform.scale[0],
      node.transform.scale[1],
      node.transform.scale[2],
    );
    local.compose(pos, quat, scale);
    const worldMatrix = new THREE.Matrix4().multiplyMatrices(parentMatrix, local);

    scratch.setFromMatrixPosition(worldMatrix);
    if (Number.isFinite(scratch.x) && Number.isFinite(scratch.y) && Number.isFinite(scratch.z)) {
      bbox.expandByPoint(scratch);
      count += 1;
    }
    for (const c of node.children) visit(c, worldMatrix);
  };

  const root = new THREE.Matrix4().identity();
  for (const r of roots) visit(r, root);

  if (count === 0 || bbox.isEmpty()) {
    return {
      center: [0, 0, 0],
      cameraPos: [10, 10, 10],
      radius: 10,
      near: 0.1,
      far: 1000,
      floorY: 0,
    };
  }

  const size = new THREE.Vector3();
  bbox.getSize(size);
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  const radius = Math.max(size.length() * 0.5, 1);
  const dist = radius * 2.2;

  return {
    center: [center.x, center.y, center.z],
    cameraPos: [center.x + dist, center.y + dist * 0.7, center.z + dist],
    radius,
    near: Math.max(0.01, radius * 0.01),
    far: Math.max(1000, radius * 50),
    floorY: bbox.min.y,
  };
}

function decodeSplat(s: string): string {
  return s
    .split('/')
    .map((seg) => seg)
    .join('/');
}

// ===========================================================================
// Unity high-fidelity viewer
// ===========================================================================

function UnityExportCanvas({ scene, relPath }: { scene: UnityExport; relPath: string }) {
  const stats = useMemo(() => getUnityExportStats(scene), [scene]);
  const framingRaw = useMemo(() => computeUnityExportFraming(scene), [scene]);

  // Same diagnostic toggles as the YAML path — baked Unity exports still
  // exhibit the "materials look wrong" symptom when UVs or submesh ordering
  // are off, so the same visualizations apply here.
  const [debugSubmeshColors, setDebugSubmeshColors] = useState(false);
  const [debugUvCheckerboard, setDebugUvCheckerboard] = useState(false);

  const radius = framingRaw.radius;
  const center: [number, number, number] = framingRaw.center;
  const dist = radius * 2.2;
  const cameraPos: [number, number, number] = [
    center[0] + dist,
    center[1] + dist * 0.7,
    center[2] + dist,
  ];

  return (
    <div className="viewer-root">
      <div className="viewer-hud">
        <div className="title">
          {scene.sceneName} <span className="muted">(high-fidelity)</span>
        </div>
        <div className="muted">{scene.scenePath}</div>
        <div>
          Nodes: <b>{stats.totalGameObjects}</b> &middot; Meshes:{' '}
          <b>{stats.renderedMeshes}</b>/<b>{stats.meshes}</b> &middot; Materials:{' '}
          <b>{stats.materials}</b> &middot; Lights: <b>{stats.lights}</b> &middot; Textures:{' '}
          <b>{stats.textures}</b>
        </div>
        <div className="muted">
          Bounds center: [{center[0].toFixed(1)}, {center[1].toFixed(1)}, {center[2].toFixed(1)}]{' '}
          &middot; radius: {radius.toFixed(1)} &middot; Fog:{' '}
          <b>{scene.render.fogEnabled ? scene.render.fogMode : 'off'}</b>
        </div>
        <div className="hud-toggle-row">
          <button
            type="button"
            className={`hud-toggle${debugSubmeshColors ? ' on' : ''}`}
            onClick={() => setDebugSubmeshColors((v) => !v)}
            title="Paint every mesh with per-slot solid colors to verify submesh ordering"
          >
            {debugSubmeshColors ? 'Submesh colors: ON' : 'Submesh colors: OFF'}
          </button>
          <button
            type="button"
            className={`hud-toggle${debugUvCheckerboard ? ' on' : ''}`}
            onClick={() => setDebugUvCheckerboard((v) => !v)}
            title="Paint every mesh with a UV checkerboard (+U arrow red, +V arrow green, 'A' glyph for orientation) to diagnose UV stretching / rotation / mirroring"
          >
            {debugUvCheckerboard ? 'UV checker: ON' : 'UV checker: OFF'}
          </button>
        </div>
        <RebakeButton relPath={relPath} />
      </div>
      <Canvas
        key={scene.scenePath}
        camera={{
          position: cameraPos,
          fov: 50,
          near: Math.max(0.01, radius * 0.01),
          far: Math.max(1000, radius * 50),
        }}
        shadows={false}
        style={{ background: '#0b0d11' }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <Suspense fallback={null}>
          <UnityRenderSettingsApply scene={scene} />
          {/* Fill light so the scene isn't pitch-black in areas the
              exported directional lights don't cover. Tier 2 will replace
              this with baked lightmaps. */}
          <hemisphereLight args={[0x8fa8c8, 0x2a2520, 0.4]} />
          <Grid
            args={[200, 200]}
            position={[0, center[1] - radius, 0]}
            cellSize={Math.max(0.5, radius / 40)}
            sectionSize={Math.max(5, radius / 5)}
            cellThickness={0.6}
            sectionThickness={1.2}
            infiniteGrid
            fadeDistance={radius * 6}
            fadeStrength={1}
            cellColor="#2a3242"
            sectionColor="#3c4a66"
          />
          <UnityExportRoots
            scene={scene}
            debugSubmeshColors={debugSubmeshColors}
            debugUvCheckerboard={debugUvCheckerboard}
          />
          <OrbitControls
            makeDefault
            target={center}
            minDistance={radius * 0.05}
            maxDistance={radius * 10}
          />
          <axesHelper args={[Math.min(5, radius * 0.1)]} />
        </Suspense>
      </Canvas>
    </div>
  );
}

/**
 * Floating button in the HUD that fires `/api/rebake` for the current scene
 * and polls the server for status until the export finishes. On success it
 * reloads the page so the freshly baked JSON is picked up.
 */
function RebakeButton({ relPath }: { relPath: string }) {
  const [status, setStatus] = useState<BatchStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRebakeStatus()
      .then((s) => !cancelled && setStatus(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const running = status?.state === 'running';

  useEffect(() => {
    if (!running) return;
    // Poll every 3s while a bake is in flight. Once the server transitions
    // to success we reload the page so the new baked JSON is served.
    const tick = setInterval(async () => {
      try {
        const s = await fetchRebakeStatus();
        setStatus(s);
        if (s.state === 'success' && s.relPath === relPath) {
          clearInterval(tick);
          window.location.reload();
        }
        if (s.state === 'failed') {
          clearInterval(tick);
        }
      } catch {
        /* ignore transient network errors */
      }
    }, 3000);
    return () => clearInterval(tick);
  }, [running, relPath]);

  const onClick = async () => {
    try {
      const resp = await triggerRebake(relPath);
      setStatus(resp.status);
    } catch (err) {
      alert('Rebake failed to queue: ' + (err as Error).message);
    }
  };

  const label = running
    ? `Baking... (${status?.relPath ?? relPath})`
    : status?.state === 'failed'
      ? `Rebake (last: failed — ${status.error ?? 'see server logs'})`
      : 'Rebake (high-fidelity)';

  return (
    <button
      type="button"
      disabled={running}
      onClick={onClick}
      style={{
        marginTop: 6,
        padding: '4px 10px',
        fontSize: 12,
        background: running ? '#2a3242' : '#1e4d8b',
        border: '1px solid #3c4a66',
        color: 'white',
        borderRadius: 4,
        cursor: running ? 'wait' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}
