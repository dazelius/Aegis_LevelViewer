import type { RawDoc } from './sceneParser.js';
import { unityColorToRgba } from './coordTransform.js';

/** Unity classId for the scene-level `RenderSettings` document. */
const CLASS_RENDER_SETTINGS = 104;
/** Unity classId for `LightmapSettings` (carries `m_LightingDataAsset`,
 *  indirect intensity, skybox reflection intensity, etc.). Scoped for Tier 1
 *  as "nice to have" — only the bounce indirect intensity is surfaced. */
const CLASS_LIGHTMAP_SETTINGS = 157;

/**
 * Fog / ambient / skybox data extracted from a scene's `RenderSettings` doc.
 *
 * All colour values are 0..1 floats (Unity serializes them that way). The
 * client maps `ambientMode` / `fogMode` to their Three.js equivalents:
 *
 *   ambientMode 0 (Skybox)       → use ambientSkyColor ≈ equatorColor average
 *   ambientMode 1 (Trilight)     → gradient ≈ average of sky/equator/ground
 *   ambientMode 3 (Flat)         → use ambientLight directly
 *   fogMode 1 (Linear)           → THREE.Fog(color, start, end)
 *   fogMode 2 (Exponential)      → THREE.FogExp2(color, density) (approx)
 *   fogMode 3 (Exp Squared)      → THREE.FogExp2(color, density)
 */
export interface SceneRenderSettings {
  ambientMode: 'Skybox' | 'Trilight' | 'Flat' | 'Custom';
  ambientSkyColor: [number, number, number, number];
  ambientEquatorColor: [number, number, number, number];
  ambientGroundColor: [number, number, number, number];
  /** Flat ambient colour — used when ambientMode = Flat. */
  ambientLight: [number, number, number, number];
  /** Global ambient intensity multiplier; default 1. */
  ambientIntensity: number;

  fogEnabled: boolean;
  fogMode: 'Linear' | 'Exponential' | 'ExponentialSquared';
  fogColor: [number, number, number, number];
  fogDensity: number;
  fogStart: number;
  fogEnd: number;

  /** Bounce lighting intensity from LightmapSettings; 1.0 is default. */
  indirectIntensity: number;
  /** Skybox material guid (if present). The client may look it up in the
   *  materials table for future skybox support. */
  skyboxMaterialGuid?: string;
}

function readNum(obj: Record<string, unknown> | undefined, key: string, fallback: number): number {
  if (!obj) return fallback;
  const v = obj[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function readColor(
  obj: Record<string, unknown> | undefined,
  key: string,
): [number, number, number, number] {
  const v = obj?.[key];
  if (!v || typeof v !== 'object') return [0, 0, 0, 1];
  return unityColorToRgba(v as { r?: number; g?: number; b?: number; a?: number });
}

function ambientModeFromInt(n: number): SceneRenderSettings['ambientMode'] {
  switch (n) {
    case 0:
      return 'Skybox';
    case 1:
      return 'Trilight';
    case 3:
      return 'Flat';
    default:
      return 'Custom';
  }
}

function fogModeFromInt(n: number): SceneRenderSettings['fogMode'] {
  // Unity: 1 Linear, 2 Exponential, 3 ExponentialSquared.
  if (n <= 1) return 'Linear';
  if (n === 2) return 'Exponential';
  return 'ExponentialSquared';
}

const DEFAULT_RENDER_SETTINGS: SceneRenderSettings = {
  ambientMode: 'Skybox',
  ambientSkyColor: [0.212, 0.227, 0.259, 1],
  ambientEquatorColor: [0.114, 0.125, 0.133, 1],
  ambientGroundColor: [0.047, 0.043, 0.035, 1],
  ambientLight: [0.212, 0.227, 0.259, 1],
  ambientIntensity: 1,
  fogEnabled: false,
  fogMode: 'ExponentialSquared',
  fogColor: [0.5, 0.5, 0.5, 1],
  fogDensity: 0.01,
  fogStart: 0,
  fogEnd: 300,
  indirectIntensity: 1,
};

export function extractRenderSettings(
  docs: RawDoc[],
): { settings: SceneRenderSettings; skyboxMaterialGuid?: string } {
  let settings: SceneRenderSettings = { ...DEFAULT_RENDER_SETTINGS };
  let skyboxMaterialGuid: string | undefined;

  for (const doc of docs) {
    if (doc.header.classId === CLASS_RENDER_SETTINGS) {
      const body = doc.body;
      settings = {
        ambientMode: ambientModeFromInt(readNum(body, 'm_AmbientMode', 0)),
        ambientSkyColor: readColor(body, 'm_AmbientSkyColor'),
        ambientEquatorColor: readColor(body, 'm_AmbientEquatorColor'),
        ambientGroundColor: readColor(body, 'm_AmbientGroundColor'),
        ambientLight: readColor(body, 'm_AmbientSkyColor'),
        ambientIntensity: readNum(body, 'm_AmbientIntensity', 1),
        fogEnabled: readNum(body, 'm_Fog', 0) !== 0,
        fogMode: fogModeFromInt(readNum(body, 'm_FogMode', 3)),
        fogColor: readColor(body, 'm_FogColor'),
        fogDensity: readNum(body, 'm_FogDensity', 0.01),
        fogStart: readNum(body, 'm_LinearFogStart', 0),
        fogEnd: readNum(body, 'm_LinearFogEnd', 300),
        indirectIntensity: settings.indirectIntensity,
      };

      // Skybox material reference.
      const sky = body['m_SkyboxMaterial'] as { guid?: string } | undefined;
      if (sky && typeof sky.guid === 'string') {
        const g = sky.guid.trim().toLowerCase();
        if (/^[0-9a-f]{32}$/.test(g)) {
          skyboxMaterialGuid = g;
          settings.skyboxMaterialGuid = g;
        }
      }
    } else if (doc.header.classId === CLASS_LIGHTMAP_SETTINGS) {
      // GIWorkflowMode / indirect scale — only surface bounce intensity, which
      // is what the client can use as a cheap hint.
      const giSettings = doc.body['m_GISettings'] as Record<string, unknown> | undefined;
      const bounce = readNum(giSettings, 'm_IndirectOutputScale', 1);
      settings.indirectIntensity = bounce;
    }
  }

  return { settings, skyboxMaterialGuid };
}
