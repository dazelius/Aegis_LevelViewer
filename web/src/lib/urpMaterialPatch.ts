import * as THREE from 'three';

/**
 * URP → MeshStandardMaterial shader patch.
 *
 * Bridges the two big channel-layout mismatches that would otherwise make
 * every URP Lit surface look wrong:
 *
 *   1. Metallic source channel. URP's `_MetallicGlossMap` stores metallic
 *      in **R** (and smoothness in **A**), but three.js's default
 *      `metalnessmap_fragment` chunk reads `texelMetalness.b`, because
 *      three's convention is a combined Occlusion/Roughness/Metallic map
 *      with metallic in B. Without the patch, every metallic surface
 *      reads the B channel (often zero in URP authoring), so metal
 *      renders as completely non-metallic.
 *
 *   2. Smoothness source. URP supports two locations:
 *        `_SmoothnessTextureChannel = 0` → metallicGloss.a  (default)
 *        `_SmoothnessTextureChannel = 1` → baseMap.a
 *      three.js only sees `roughnessMap.g` in its default chunk, so
 *      without the patch the roughness sampled is whatever lives in G
 *      of the metallic tex (effectively random).
 *
 * Additionally, we apply URP-style detail albedo overlay and detail
 * normal blend when `_DetailAlbedoMap` / `_DetailNormalMap` are
 * authored. This covers the bulk of "close-up detail is missing" gaps
 * for URP Lit materials, which is the most visually obvious part of
 * Shader Graph fidelity for environment assets.
 *
 * The `metallicGlossMap` texture MUST be bound to BOTH
 * `mat.metalnessMap` and `mat.roughnessMap` before calling this, so
 * three sets `USE_METALNESSMAP` + `USE_ROUGHNESSMAP` defines and the
 * corresponding `vMetalnessMapUv` / `vRoughnessMapUv` varyings exist.
 * The patch then uses those varyings but samples the .r / .a channels
 * instead of three's default .b / .g.
 *
 * Note: height/parallax is intentionally NOT implemented here —
 * single-sample parallax was judged too low-reward for the tangent-space
 * plumbing it requires. Height maps are wired through to the server
 * layer in case a future revision adds it, but currently only the
 * detail albedo + detail normal are applied on the GPU.
 */
export interface UrpPatchOptions {
  /** URP's `_SmoothnessTextureChannel`: when true, smoothness is read
   *  from `baseMap.a` instead of `metallicGlossMap.a`. */
  smoothnessFromAlbedoAlpha: boolean;

  /** Bound detail albedo map. Enables detail overlay blending. */
  detailAlbedoMap?: THREE.Texture;
  /** Bound detail normal map. Enables detail normal blending on top of
   *  the primary normal map (UDN style). */
  detailNormalMap?: THREE.Texture;

  /** URP detail maps resample the primary UV set by `detailUvScale`
   *  (2.0 is URP's authoring default). */
  detailUvScale?: number;
  /** `_DetailAlbedoMapScale`, 0..2 (URP auth range). Default 1. */
  detailAlbedoScale?: number;
  /** `_DetailNormalMapScale`. Default 1. */
  detailNormalScale?: number;
}

/**
 * Install the URP compatibility shader patch on a `MeshStandardMaterial`.
 *
 * Safe to call even when no detail maps are bound — the channel-remap
 * pass is unconditional and is what fixes the "every metallic surface
 * looks plastic" issue on its own. Each distinct option combination
 * gets its own program cache key so three.js doesn't cross-pollinate
 * compiled shaders between variants.
 */
export function applyUrpMaterialPatch(
  mat: THREE.MeshStandardMaterial,
  opts: UrpPatchOptions,
): void {
  const detailUvScale = opts.detailUvScale ?? 2.0;
  const detailAlbedoScale = opts.detailAlbedoScale ?? 1.0;
  const detailNormalScale = opts.detailNormalScale ?? 1.0;

  const hasDetailA = !!opts.detailAlbedoMap;
  const hasDetailN = !!opts.detailNormalMap;
  const smoothA = opts.smoothnessFromAlbedoAlpha;

  const patchKey = [
    'urp',
    smoothA ? 'smA' : 'smM',
    hasDetailA ? 'dA' : '-',
    hasDetailN ? 'dN' : '-',
  ].join('_');

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.detailUvScale = { value: detailUvScale };
    shader.uniforms.detailAlbedoScale = { value: detailAlbedoScale };
    shader.uniforms.detailNormalScale = { value: detailNormalScale };
    if (hasDetailA) shader.uniforms.detailAlbedoMap = { value: opts.detailAlbedoMap! };
    if (hasDetailN) shader.uniforms.detailNormalMap = { value: opts.detailNormalMap! };

    const extraDefines: Record<string, string> = {};
    if (smoothA) extraDefines.SMOOTHNESS_FROM_ALBEDO_ALPHA = '';
    if (hasDetailA) extraDefines.USE_DETAIL_ALBEDO = '';
    if (hasDetailN) extraDefines.USE_DETAIL_NORMAL = '';
    shader.defines = { ...(shader.defines ?? {}), ...extraDefines };

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      /* glsl */ `#include <common>
uniform float detailUvScale;
uniform float detailAlbedoScale;
uniform float detailNormalScale;
#ifdef USE_DETAIL_ALBEDO
uniform sampler2D detailAlbedoMap;
#endif
#ifdef USE_DETAIL_NORMAL
uniform sampler2D detailNormalMap;
#endif
`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      /* glsl */ `
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
  // URP stores metallic in R (three's default reads B, which is wrong
  // for URP Lit and makes every metal surface read as dielectric).
  metalnessFactor *= texelMetalness.r;
#endif
`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `
float roughnessFactor = roughness;
{
  // URP final smoothness = authored _Smoothness * textureSample.a.
  // three's 'roughness' uniform already holds (1 - authored smoothness),
  // so we recover authored smoothness from it and combine with the
  // tex-alpha sample from whichever source URP picked.
  float smoothnessAuthored = 1.0 - roughness;
  float sampledSmoothness = 1.0;
  #if defined(SMOOTHNESS_FROM_ALBEDO_ALPHA) && defined(USE_MAP)
    sampledSmoothness = texture2D(map, vMapUv).a;
  #elif defined(USE_ROUGHNESSMAP)
    sampledSmoothness = texture2D(roughnessMap, vRoughnessMapUv).a;
  #endif
  roughnessFactor = clamp(1.0 - sampledSmoothness * smoothnessAuthored, 0.0, 1.0);
}
`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `#include <map_fragment>
#if defined(USE_DETAIL_ALBEDO) && defined(USE_MAP)
  {
    vec3 detailRgb = texture2D(detailAlbedoMap, vMapUv * detailUvScale).rgb;
    // URP-ish overlay approximation: modulate albedo by 2x detail.
    // Full URP uses a signed offset (detail - 0.5), but the multiplicative
    // variant keeps albedo in-range without extra clamping and covers
    // the "walls lose surface texture at close range" symptom.
    vec3 overlay = diffuseColor.rgb * detailRgb * 2.0;
    diffuseColor.rgb = mix(diffuseColor.rgb, overlay, detailAlbedoScale);
  }
#endif
`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
#ifdef USE_NORMALMAP_OBJECTSPACE
  normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  #ifdef FLIP_SIDED
    normal = - normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
  #ifdef USE_DETAIL_NORMAL
    // UDN blend (simplest correct-ish tangent-space blend): add xy,
    // keep base z so the orientation is preserved.
    vec3 detailN = texture2D(detailNormalMap, vNormalMapUv * detailUvScale).xyz * 2.0 - 1.0;
    detailN.xy *= detailNormalScale;
    mapN = normalize(vec3(mapN.xy + detailN.xy, mapN.z));
  #endif
  normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
  normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif
`,
    );
  };

  mat.customProgramCacheKey = () => patchKey;
  mat.needsUpdate = true;
}
