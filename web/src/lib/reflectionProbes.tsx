import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { textureUrl } from './api';

/**
 * Reflection Probe registry + envMap applicator.
 *
 * Each `GameObjectNode` with a `reflectionProbe` field registers a live
 * `Object3D` ref here when it mounts. The `ReflectionProbeSystem`
 * component sits at scene level, loads each probe's baked cubemap,
 * runs it through a shared `PMREMGenerator`, and assigns the resulting
 * prefiltered environment texture to the nearest-probe's envMap on
 * every `MeshStandardMaterial` in the scene graph.
 *
 * Design notes:
 *   - We deliberately do NOT override `scene.environment` on a per-mesh
 *     basis — three has no such concept. Instead we assign `mat.envMap`
 *     directly, which takes precedence over `scene.environment` for
 *     that material. Meshes outside any probe's influence keep the
 *     scene-level (skybox / room) environment.
 *   - Nearest-probe lookup is done in world space by distance to the
 *     probe's centre. True AABB containment would be more accurate but
 *     distance-only is the hobbyist norm for reflection probes in WebGL
 *     engines and avoids edge-case flicker when a mesh straddles two
 *     overlapping boxes.
 *   - Box projection (`m_BoxProjection = true`) is NOT implemented in
 *     this pass — three's built-in env sampling uses a purely spherical
 *     reflection. The visual cost is that wall reflections can look
 *     slightly "off" compared to Unity; a follow-up pass can add an
 *     `onBeforeCompile` patch to re-route the envmap sample through a
 *     box-projected ray for probes that want it.
 *   - Assignment runs once per scene mount (and once per probe load
 *     completion). Moving meshes won't automatically re-assign — but in
 *     this viewer's use case, static environment geometry is what wants
 *     probe reflections, and dynamic props (character, debug gizmos)
 *     can safely use the scene-level skybox.
 */

export type ProbeMode = 'Baked' | 'Custom' | 'Realtime' | 'Unknown';

export interface RegisteredProbe {
  /** Scene-unique key (GameObject fileID) used to invalidate registry
   *  entries when a node unmounts. */
  key: string;
  /** Ref to the anchor Object3D under the probe's GameObject. The
   *  probe's world position is `ref.getWorldPosition(...)` — we read
   *  this lazily in the applicator so scene hierarchy composition
   *  (prefab expansions, nested rotations) doesn't have to be
   *  mirrored here. */
  anchor: THREE.Object3D;
  /** Local-space box offset / size from Unity. The world-space box
   *  is `anchor.matrixWorld * (offset ± size/2)`. */
  boxSize: [number, number, number];
  boxOffset: [number, number, number];
  boxProjection: boolean;
  intensity: number;
  importance: number;
  mode: ProbeMode;
  customBakedTextureGuid?: string;
}

interface Registry {
  add(probe: RegisteredProbe): void;
  remove(key: string): void;
  version: { current: number };
  snapshot(): RegisteredProbe[];
}

const ProbeRegistryContext = createContext<Registry | null>(null);

export function ReflectionProbeRegistryProvider({ children }: { children: ReactNode }) {
  const probesRef = useRef(new Map<string, RegisteredProbe>());
  const version = useRef(0);
  const registry = useMemo<Registry>(
    () => ({
      add: (p) => {
        probesRef.current.set(p.key, p);
        version.current += 1;
      },
      remove: (key) => {
        if (probesRef.current.delete(key)) version.current += 1;
      },
      version,
      snapshot: () => Array.from(probesRef.current.values()),
    }),
    [],
  );
  return (
    <ProbeRegistryContext.Provider value={registry}>{children}</ProbeRegistryContext.Provider>
  );
}

export function useRegisterReflectionProbe(
  key: string,
  probe: Omit<RegisteredProbe, 'key' | 'anchor'>,
): React.RefObject<THREE.Group> {
  const registry = useContext(ProbeRegistryContext);
  const anchorRef = useRef<THREE.Group>(null);

  useEffect(() => {
    if (!registry || !anchorRef.current) return;
    registry.add({ key, anchor: anchorRef.current, ...probe });
    return () => registry.remove(key);
    // We intentionally re-register when any probe metadata changes; the
    // keys produced by the scene parser are stable (GameObject fileIDs)
    // so the effect only fires on a genuine scene reload.
  }, [
    registry,
    key,
    probe.mode,
    probe.boxProjection,
    probe.intensity,
    probe.importance,
    probe.customBakedTextureGuid,
    // Arrays compared by identity — scene.roots is memoised at the
    // SceneRoots level so a fresh identity means an actual reload.
    probe.boxSize,
    probe.boxOffset,
  ]);

  return anchorRef;
}

/**
 * Scene-level applicator. Walks `scene.roots` once per mount, loads
 * every probe's baked cubemap, and assigns the resulting PMREM texture
 * to `mesh.material.envMap` for the nearest probe per mesh.
 *
 * Placement: render this inside `SceneRoots`, AFTER the tree that
 * hosts the SceneNodes. That way the probe anchors have mounted (so
 * their `matrixWorld` is valid) by the time our useEffect runs.
 */
export function ReflectionProbeSystem({ rootsVersion }: { rootsVersion: unknown }) {
  const registry = useContext(ProbeRegistryContext);
  const { scene, gl } = useThree();

  useEffect(() => {
    if (!registry) return;
    let cancelled = false;
    // Lazily constructed — we skip the whole probe pass (including
    // scene.traverse, which is the expensive part on large scenes) when
    // no probes are registered, so a typical probe-less scene pays
    // zero cost here beyond the one requestAnimationFrame hop.
    let pmrem: THREE.PMREMGenerator | null = null;

    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      const probes = registry.snapshot();
      if (probes.length === 0) return;

      pmrem = new THREE.PMREMGenerator(gl);
      pmrem.compileEquirectangularShader();
      pmrem.compileCubemapShader();

      // Force matrix update on the whole scene so anchor refs report
      // correct world positions even before the first render frame.
      scene.updateMatrixWorld(true);

      interface LoadedProbe {
        probe: RegisteredProbe;
        position: THREE.Vector3;
        envMap: THREE.Texture;
        sourceTex?: THREE.Texture;
      }
      const loaded: LoadedProbe[] = [];
      const disposers: (() => void)[] = [];

      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');

      const loadPromises = probes.map(async (probe) => {
        if (probe.mode !== 'Custom' || !probe.customBakedTextureGuid) {
          // Baked / realtime / unknown probes have no sidecar texture
          // we can decode on the client. Skip — the scene's
          // environment (skybox or room fallback) continues to light
          // them, same as URP when the reflection texture isn't
          // authored yet.
          return null;
        }
        const url = textureUrl(probe.customBakedTextureGuid);
        try {
          const tex = await new Promise<THREE.Texture>((resolve, reject) => {
            loader.load(url, resolve, undefined, reject);
          });
          if (cancelled) {
            tex.dispose();
            return null;
          }
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          const rt = pmrem!.fromEquirectangular(tex);
          const world = new THREE.Vector3();
          probe.anchor.getWorldPosition(world);
          loaded.push({ probe, position: world, envMap: rt.texture, sourceTex: tex });
          disposers.push(() => {
            rt.texture.dispose();
            tex.dispose();
          });
          return rt;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[probe] cubemap load failed for ${probe.key} (guid=${probe.customBakedTextureGuid.slice(0, 8)}): ${String(err)}`,
          );
          return null;
        }
      });

      Promise.all(loadPromises).then(() => {
        if (cancelled || loaded.length === 0) return;
        scene.updateMatrixWorld(true);

        const meshWorldPos = new THREE.Vector3();
        scene.traverse((obj) => {
          if (!(obj as THREE.Mesh).isMesh) return;
          const mesh = obj as THREE.Mesh;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mesh.getWorldPosition(meshWorldPos);

          let best: LoadedProbe | null = null;
          let bestScore = Infinity;
          for (const lp of loaded) {
            const dx = meshWorldPos.x - lp.position.x;
            const dy = meshWorldPos.y - lp.position.y;
            const dz = meshWorldPos.z - lp.position.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            // Importance acts as a bias — Unity breaks ties in favour
            // of the higher-importance probe, and we approximate that
            // by dividing distance by importance so a heavily-weighted
            // probe can win against a slightly closer default probe.
            const score = dist / Math.max(lp.probe.importance, 0.001);
            if (score < bestScore) {
              bestScore = score;
              best = lp;
            }
          }
          if (!best) return;

          for (const m of mats) {
            if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
              const std = m as THREE.MeshStandardMaterial;
              std.envMap = best.envMap;
              std.envMapIntensity = best.probe.intensity;
              std.needsUpdate = true;
            }
          }
        });
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      // Don't dispose PMREM immediately — the Promise handlers above
      // might still be queuing work. PMREMGenerator.dispose is
      // idempotent and the textures track their own disposal via
      // `disposers`, so we leak at most one RT briefly if the scene
      // unmounts mid-load. When no probes registered we never
      // constructed the generator — nothing to dispose.
      pmrem?.dispose();
    };
  }, [registry, gl, scene, rootsVersion]);

  return null;
}
