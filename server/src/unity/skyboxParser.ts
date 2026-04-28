import fs from 'node:fs/promises';
import path from 'node:path';
import { assetIndex } from './assetIndex.js';
import { loadUnityDocs, preprocessUnityYaml } from './yamlSchema.js';
import { isLfsPointerBuf } from '../git/lazyLfs.js';

/**
 * Skybox material parser.
 *
 * The scene-level `RenderSettings.m_SkyboxMaterial` can point at any of
 * Unity's four stock skybox shaders, each with its own property layout:
 *
 *   - `Skybox/Cubemap`     — single `_Tex` cubemap asset
 *   - `Skybox/6 Sided`     — `_FrontTex / _BackTex / _LeftTex / _RightTex
 *                             / _UpTex / _DownTex` 2D faces
 *   - `Skybox/Panoramic`   — single `_MainTex` equirectangular 2D
 *   - `Skybox/Procedural`  — no textures, just sun / sky / ground colours
 *
 * We classify by shader name (best-effort — non-stock skyboxes fall into
 * `unknown`) and surface the texture GUIDs + the handful of tint /
 * exposure / rotation scalars the client needs to reproduce the
 * environment. The Tier-1 shader parser (`materialParser.ts`) doesn't
 * cover these properties because skyboxes never render as surfaces in
 * the normal lit/unlit pipeline — they drive `scene.background` and
 * `scene.environment` only.
 */
export type SkyboxKind = 'cubemap' | 'sixsided' | 'panoramic' | 'procedural' | 'unknown';

export interface SkyboxJson {
  guid: string;
  /** Resolved Unity shader name, e.g. `Skybox/Cubemap`. May be undefined
   *  when the referenced shader asset isn't on disk. */
  shaderName?: string;
  kind: SkyboxKind;

  /** `_Tex` cubemap asset GUID (cubemap kind). */
  cubemapGuid?: string;
  /** `_MainTex` equirectangular asset GUID (panoramic kind). */
  panoramicGuid?: string;
  /** `_FrontTex`, `_BackTex`, `_LeftTex`, `_RightTex`, `_UpTex`,
   *  `_DownTex` in that order. Positions without a texture are null so
   *  the client can detect partial authoring. */
  sixSidedGuids?: [
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
  ];

  /** `_Tint` (cubemap / six-sided) — RGB 0..1 tint. */
  tint?: [number, number, number];
  /** `_Exposure`. Default 1 for cubemap / six-sided / panoramic. */
  exposure?: number;
  /** `_Rotation` in degrees around Y. Default 0. */
  rotationDeg?: number;

  /** Procedural-only: `_SunSize`, `_SkyTint`, `_GroundColor`,
   *  `_AtmosphereThickness`. */
  sunSize?: number;
  skyTint?: [number, number, number];
  groundColor?: [number, number, number];
  atmosphereThickness?: number;
}

interface UnityTexEnv {
  m_Texture?: { fileID?: number | string; guid?: string; type?: number };
  m_Scale?: { x?: number; y?: number };
  m_Offset?: { x?: number; y?: number };
}

interface UnityMaterialBody {
  m_Name?: string;
  m_Shader?: { guid?: string; fileID?: number | string };
  m_ShaderKeywords?: string;
  m_SavedProperties?: {
    m_TexEnvs?: Array<Record<string, UnityTexEnv>>;
    m_Colors?: Array<Record<string, { r?: number; g?: number; b?: number; a?: number }>>;
    m_Floats?: Array<Record<string, number>>;
    m_Ints?: Array<Record<string, number>>;
  };
}

function pickEntry<T>(
  list: Array<Record<string, T>> | undefined,
  names: string[],
): T | undefined {
  if (!list) return undefined;
  for (const name of names) {
    for (const entry of list) {
      if (entry && Object.prototype.hasOwnProperty.call(entry, name)) {
        return entry[name];
      }
    }
  }
  return undefined;
}

function pickFloat(
  list: Array<Record<string, number>> | undefined,
  names: string[],
): number | undefined {
  const v = pickEntry(list, names);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function normalizeGuid(g: unknown): string | undefined {
  if (typeof g !== 'string') return undefined;
  const s = g.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return undefined;
  return s;
}

function texGuid(tex: UnityTexEnv | undefined): string | undefined {
  return normalizeGuid(tex?.m_Texture?.guid);
}

function pickColor3(
  list: Array<Record<string, { r?: number; g?: number; b?: number; a?: number }>> | undefined,
  name: string,
): [number, number, number] | undefined {
  const entry = pickEntry(list, [name]);
  if (!entry) return undefined;
  return [entry.r ?? 0, entry.g ?? 0, entry.b ?? 0];
}

function extractMaterialBody(docs: unknown[]): UnityMaterialBody | undefined {
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    const obj = doc as Record<string, unknown>;
    if ('Material' in obj && obj.Material && typeof obj.Material === 'object') {
      return obj.Material as UnityMaterialBody;
    }
  }
  return undefined;
}

async function resolveShaderName(guid: string | undefined): Promise<string | undefined> {
  if (!guid) return undefined;
  const rec = assetIndex.get(guid);
  if (!rec) return undefined;
  // The first `Shader "Path/Name"` line is authoritative. Reading 512
  // bytes is enough — Unity shader lab files always declare the shader
  // path on their first non-blank line.
  try {
    const raw = await fs.readFile(rec.absPath, 'utf8');
    const head = raw.slice(0, 512);
    const match = /Shader\s+"([^"]+)"/.exec(head);
    if (match) return match[1];
  } catch {
    // ignore
  }
  // Fall back to the asset's relative path so the client still has a
  // string it can log / diff, even when the .shader file isn't on disk.
  return rec.relPath;
}

function classify(shaderName: string | undefined): SkyboxKind {
  if (!shaderName) return 'unknown';
  const n = shaderName.toLowerCase();
  if (/(^|\/)skybox\/cubemap($|\s)/.test(n)) return 'cubemap';
  if (/(^|\/)skybox\/6\s*sided($|\s)/.test(n)) return 'sixsided';
  if (/(^|\/)skybox\/panoramic($|\s)/.test(n)) return 'panoramic';
  if (/(^|\/)skybox\/procedural($|\s)/.test(n)) return 'procedural';
  // Shader Graph skyboxes commonly use `_Tex` or `_MainTex` still; we
  // fall into 'unknown' and let the client pick a best-effort path
  // from whichever texture GUID we managed to extract.
  return 'unknown';
}

/**
 * Parse a skybox material `.mat` into a compact JSON shape for the
 * client. Returns undefined when the asset can't be found, is still an
 * LFS pointer, or isn't a `Material` document at all.
 */
export async function parseSkyboxByGuid(guid: string): Promise<SkyboxJson | undefined> {
  if (!guid) return undefined;
  const key = guid.toLowerCase();
  const rec = assetIndex.get(key);
  if (!rec || rec.ext !== '.mat') return undefined;

  let rawBuf: Buffer;
  try {
    rawBuf = await fs.readFile(rec.absPath);
  } catch {
    return undefined;
  }
  if (isLfsPointerBuf(rawBuf)) return undefined;

  const raw = rawBuf.toString('utf8');
  const pre = preprocessUnityYaml(raw);
  let docs: unknown[];
  try {
    docs = loadUnityDocs(pre);
  } catch {
    return undefined;
  }

  const body = extractMaterialBody(docs);
  if (!body) return undefined;

  const shaderGuid = normalizeGuid(body.m_Shader?.guid);
  const shaderName = await resolveShaderName(shaderGuid);
  const kind = classify(shaderName) === 'unknown' && path.basename(rec.absPath).toLowerCase().includes('skybox')
    ? classify(shaderName)
    : classify(shaderName);

  const props = body.m_SavedProperties;
  const texEnvs = props?.m_TexEnvs;
  const colors = props?.m_Colors;
  const floats = props?.m_Floats;

  const out: SkyboxJson = {
    guid: key,
    shaderName,
    kind,
    tint: pickColor3(colors, '_Tint'),
    exposure: pickFloat(floats, ['_Exposure']),
    rotationDeg: pickFloat(floats, ['_Rotation']),
  };

  const cubemapGuid = texGuid(pickEntry(texEnvs, ['_Tex']));
  if (cubemapGuid) out.cubemapGuid = cubemapGuid;

  const panoramicGuid = texGuid(pickEntry(texEnvs, ['_MainTex']));
  if (panoramicGuid) out.panoramicGuid = panoramicGuid;

  const frontGuid = texGuid(pickEntry(texEnvs, ['_FrontTex']));
  const backGuid = texGuid(pickEntry(texEnvs, ['_BackTex']));
  const leftGuid = texGuid(pickEntry(texEnvs, ['_LeftTex']));
  const rightGuid = texGuid(pickEntry(texEnvs, ['_RightTex']));
  const upGuid = texGuid(pickEntry(texEnvs, ['_UpTex']));
  const downGuid = texGuid(pickEntry(texEnvs, ['_DownTex']));
  if (frontGuid || backGuid || leftGuid || rightGuid || upGuid || downGuid) {
    out.sixSidedGuids = [
      frontGuid ?? null,
      backGuid ?? null,
      leftGuid ?? null,
      rightGuid ?? null,
      upGuid ?? null,
      downGuid ?? null,
    ];
  }

  if (out.kind === 'procedural' || (out.kind === 'unknown' && !cubemapGuid && !panoramicGuid && !frontGuid)) {
    out.sunSize = pickFloat(floats, ['_SunSize']);
    out.skyTint = pickColor3(colors, '_SkyTint');
    out.groundColor = pickColor3(colors, '_GroundColor');
    out.atmosphereThickness = pickFloat(floats, ['_AtmosphereThickness']);
  }

  return out;
}
