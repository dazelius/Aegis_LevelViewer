import { useEffect } from 'react';
import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { useThree } from '@react-three/fiber';
import { textureUrl } from './api';

/**
 * Per-material reflection cubemap binder.
 *
 * Aegis/BasicLit (and similar custom Unity shaders) authors a dedicated
 * `_EnvCubemap` / `_ReflectionMap` texture on each material — distinct
 * from the scene-wide ReflectionProbe system. Unity renders those
 * reflections even in scenes that don't place any Reflection Probe, so
 * the "factory interior looks like a factory" effect comes from the
 * per-material cubemap, not the probe graph.
 *
 * How it works:
 *   1. `buildMaterial` stashes the reflection metadata in
 *      `material.userData.reflectionCubemap = { guid, intensity,
 *      roughnessDistortion, useReflection }`. No envMap is assigned at
 *      construction time because we need the WebGLRenderer (for
 *      PMREMGenerator) and it's only available inside R3F.
 *   2. `<MaterialReflectionCubemapSystem>` mounts under the scene
 *      canvas, waits one RAF so materials are in the scene graph, then
 *      traverses the scene, collects unique cubemap GUIDs, loads each
 *      once (EXR for HDR EXRs, RGBE for `.hdr`, regular TextureLoader
 *      for LDR PNGs), PMREM-filters the result, and assigns the shared
 *      envMap to every material that referenced that GUID.
 *   3. Re-runs when `rootsVersion` changes (a scene reload).
 *
 * Why we cache per-guid:
 *   A typical Factory_New_B-style scene has ~60 materials all pointing
 *   at the same `SampleReflection.exr` cubemap. Loading that EXR once
 *   and sharing the filtered RT across 60 materials vs loading 60x
 *   is the difference between "snappy scene open" and "8 second
 *   freeze" — PMREM filtering is GPU-bound and hurts at scale.
 */

export interface MaterialReflectionData {
  guid: string;
  intensity: number;
  roughnessDistortion: number;
  useReflection: boolean;
}

const CACHE_KEY = '__aegisReflectionCubemap';

/**
 * Stash the reflection-cubemap intent on a material so
 * `MaterialReflectionCubemapSystem` can pick it up on the next mount.
 * Called from `buildMaterial` — kept as a helper so the shape of the
 * userData payload is authoritative in one file.
 */
export function setReflectionCubemapUserData(
  mat: THREE.MeshStandardMaterial,
  data: MaterialReflectionData,
): void {
  mat.userData[CACHE_KEY] = data;
}

interface LoadedEnvMap {
  envMap: THREE.Texture;
  dispose: () => void;
}

/**
 * Scene-level binder. Place inside `SceneRoots` (or any R3F subtree
 * below the <Canvas>) so `useThree()` returns the right renderer.
 *
 * `rootsVersion` should change on scene reload — it's fine to pass
 * `sceneData?.roots` identity as that's memoised at the parse layer.
 */
export function MaterialReflectionCubemapSystem({
  rootsVersion,
  envMultiplier = 1,
}: {
  rootsVersion: unknown;
  envMultiplier?: number;
}) {
  const { scene, gl } = useThree();

  useEffect(() => {
    let cancelled = false;
    let pmrem: THREE.PMREMGenerator | null = null;
    const disposers: (() => void)[] = [];
    // guid -> Promise<LoadedEnvMap | null>. Shared across the single
    // pass so 60 materials referencing the same guid trigger 1 fetch.
    const byGuid = new Map<string, Promise<LoadedEnvMap | null>>();

    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;

      // Collect unique pending GUIDs. `userData[CACHE_KEY]` persists
      // across re-renders (it's on the material itself), so meshes
      // added later still get bound on the next scene-reload pass.
      const pending = new Set<string>();
      // Track which materials want which guid so we can bind back
      // once each texture has loaded.
      const bindings: Array<{ mat: THREE.MeshStandardMaterial; data: MaterialReflectionData }> = [];

      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const std = m as THREE.MeshStandardMaterial;
          if (!std.isMeshStandardMaterial) continue;
          const data = std.userData?.[CACHE_KEY] as MaterialReflectionData | undefined;
          if (!data) continue;
          if (!data.useReflection || !data.guid) continue;
          pending.add(data.guid);
          bindings.push({ mat: std, data });
        }
      });

      if (pending.size === 0) return;

      pmrem = new THREE.PMREMGenerator(gl);
      pmrem.compileEquirectangularShader();

      for (const guid of pending) {
        byGuid.set(guid, loadAndPmrem(guid, pmrem));
      }

      Promise.all(
        Array.from(byGuid.entries()).map(async ([guid, promise]) => {
          const loaded = await promise;
          return { guid, loaded };
        }),
      ).then((results) => {
        if (cancelled) return;
        const lookup = new Map<string, LoadedEnvMap>();
        for (const { guid, loaded } of results) {
          if (loaded) {
            lookup.set(guid, loaded);
            disposers.push(loaded.dispose);
          }
        }

        let bound = 0;
        for (const { mat, data } of bindings) {
          const lp = lookup.get(data.guid);
          if (!lp) continue;
          mat.envMap = lp.envMap;
          // Calibration rationale — the authored Unity values for
          // `_ReflectionIntensity` live in a ~0.02-0.08 range because
          // the custom Aegis/BasicLit shader uses them as a SCALAR
          // inside a formula like `albedo + ambient + x * reflColor`,
          // where `albedo` and `ambient` already carry most of the
          // surface brightness. three's `envMapIntensity` is a direct
          // multiplier on the ENTIRE indirect-light term for the
          // material — 0.04 makes the surface almost entirely matte
          // black (see Factory_New_B first pass: 205/205 bound, pitch
          // dark). We rescale with a 20x factor and clamp to [0.35,
          // 3.0] so:
          //   - 0.02 authored -> 0.40 (reasonable indoor IBL)
          //   - 0.04 authored -> 0.80 (Factory_New_B, matches Unity)
          //   - 0.08 authored -> 1.60 (bright polished surfaces)
          //   - 0.50 authored -> 3.00 (cap, avoids blown highlights)
          // The HUD's Env slider further multiplies so users can dial
          // this per scene without an edit loop.
          const MAT_CALIBRATION = 20;
          mat.envMapIntensity =
            Math.min(3.0, Math.max(0.35, data.intensity * MAT_CALIBRATION)) *
            envMultiplier;
          // Store distortion so the URP patch (if it reads it) can
          // modulate roughness when sampling the env. Currently unused
          // by onBeforeCompile but kept for future tuning without
          // needing another data round-trip.
          mat.userData.roughnessDistortion = data.roughnessDistortion;
          mat.needsUpdate = true;
          bound += 1;
        }
        const sampleI =
          bindings[0]?.data.intensity.toFixed(3) ?? '-';
        const sampleEnv =
          bindings.find((b) => b.data.guid && lookup.has(b.data.guid))?.mat
            .envMapIntensity.toFixed(2) ?? '-';
        console.log(
          `[matReflCube] bound envMap on ${bound}/${bindings.length} materials ` +
            `(${lookup.size} unique textures, sample authored=${sampleI} ` +
            `-> envMapIntensity=${sampleEnv}, envMult=${envMultiplier.toFixed(2)})`,
        );
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      // Wait until disposers accrue, but dispose PMREM immediately —
      // the generator's RTs have already been handed off to each
      // material via `envMap`, and those are torn down by each
      // disposer below rather than by PMREM.
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* best-effort — material may already be disposed by three */
        }
      }
      pmrem?.dispose();
    };
  }, [gl, scene, rootsVersion, envMultiplier]);

  return null;
}

/**
 * Load one cubemap texture by GUID and run it through PMREMGenerator.
 * Picks the loader by MIME-sniffing the server response — EXR for
 * `image/x-exr`, RGBE for `image/vnd.radiance`, plain PNG via
 * TextureLoader otherwise. The server's `/api/assets/texture` route
 * sets these Content-Types explicitly for `.exr` / `.hdr` files (see
 * `server/src/api/routes.ts`).
 */
async function loadAndPmrem(
  guid: string,
  pmrem: THREE.PMREMGenerator,
): Promise<LoadedEnvMap | null> {
  const url = textureUrl(guid);
  try {
    const head = await fetch(url, { method: 'HEAD' });
    const ct = head.headers.get('content-type') ?? '';
    let tex: THREE.DataTexture | THREE.Texture;
    if (/x-exr/i.test(ct) || /\.exr(\?|$)/i.test(url)) {
      const loader = new EXRLoader();
      loader.setDataType(THREE.HalfFloatType);
      tex = await new Promise<THREE.DataTexture>((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
      });
    } else if (/vnd\.radiance/i.test(ct) || /\.hdr(\?|$)/i.test(url)) {
      const loader = new RGBELoader();
      loader.setDataType(THREE.HalfFloatType);
      tex = await new Promise<THREE.DataTexture>((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
      });
    } else {
      const loader = new THREE.TextureLoader();
      tex = await new Promise<THREE.Texture>((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
      });
      // LDR cubemaps shipped as PNG need sRGB input so the PMREM pass
      // produces linear-light filtered mipmaps. HDR data textures are
      // already linear, no colorSpace override needed.
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    // Unity stores these textures as either equirectangular panoramas
    // (`textureShape: 2`, `generateCubemap: 6`) or pre-built cubemap
    // faces. Three auto-detects via `mapping` — we default to
    // EquirectangularReflectionMapping because that's what Unity's
    // spherical EXRs (SampleReflection.exr) produce after the
    // `generateCubemap: FullCubemap` importer step.
    tex.mapping = THREE.EquirectangularReflectionMapping;

    const rt = pmrem.fromEquirectangular(tex as THREE.Texture);
    // Source texture is no longer needed once PMREM has baked its
    // mipmaps — the renderer samples exclusively from rt.texture.
    tex.dispose();
    return {
      envMap: rt.texture,
      dispose: () => rt.texture.dispose(),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[matReflCube] load failed for guid=${guid.slice(0, 8)}: ${String(err)}`,
    );
    return null;
  }
}
