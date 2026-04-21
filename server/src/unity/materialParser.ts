import fs from 'node:fs/promises';
import path from 'node:path';
import { loadUnityDocs, preprocessUnityYaml } from './yamlSchema.js';
import { assetIndex } from './assetIndex.js';
import { unityColorToRgba } from './coordTransform.js';
import { isLfsPointerBuf } from '../git/lazyLfs.js';

/**
 * Per-texture reference extracted from a Unity material's `m_TexEnvs`. The
 * GUID points at the Texture2D asset; `tiling` / `offset` are the shader's
 * UV transform (default [1,1] / [0,0]).
 */
export interface MaterialTextureRef {
  guid: string;
  tiling?: [number, number];
  offset?: [number, number];
}

/**
 * Enhanced material description used by the Tier-1 PBR pipeline. All colour
 * values are in Unity's native colour space (typically linear float for PBR
 * shaders, sRGB-ish for legacy). The client is responsible for deciding
 * whether to treat `color` as an sRGB surface colour or linear PBR albedo
 * based on the resolved `shaderKind`.
 */
export interface ParsedMaterial {
  guid: string;
  name: string;

  /** Shader classification — the client uses this to pick between
   *  `MeshStandardMaterial` (PBR) and `MeshBasicMaterial` (unlit). */
  shaderKind: 'lit' | 'unlit' | 'unknown';
  /** Raw shader guid (when available) for debug / future-proofing. */
  shaderGuid?: string;
  /** Shader's display name if discoverable (e.g. `Universal Render
   *  Pipeline/Lit`). We do a best-effort lookup via the shader guid's
   *  `.shader` source file. */
  shaderName?: string;

  /** Base colour albedo / tint, 0..1. RGBA. */
  color: [number, number, number, number];

  /** Main/base texture (`_MainTex` or `_BaseMap`). */
  baseMap?: MaterialTextureRef;
  /** Normal map (`_BumpMap` or `_NormalMap`). */
  normalMap?: MaterialTextureRef;
  /** Occlusion map (`_OcclusionMap`). */
  occlusionMap?: MaterialTextureRef;
  /** Combined metallic/gloss texture (URP `_MetallicGlossMap`). RGB =
   *  metallic, A = smoothness. */
  metallicGlossMap?: MaterialTextureRef;
  /** Emission texture (`_EmissionMap`). */
  emissionMap?: MaterialTextureRef;

  /** 0..1 PBR metalness. Unity/URP default: 0. */
  metallic: number;
  /** 0..1 PBR smoothness. Unity/URP default: 0.5. Client converts to
   *  Three.js roughness = 1 - smoothness. */
  smoothness: number;
  /** Emission colour (0..1, can be HDR > 1 for glowing surfaces). */
  emissionColor: [number, number, number];
  /** 0..1 normal-map intensity. Default 1. */
  bumpScale: number;
  /** 0..1 occlusion strength. Default 1. */
  occlusionStrength: number;

  /** 'Opaque' / 'Cutout' / 'Transparent' / 'Fade'. Clients map this to
   *  blending + alpha-test settings on Three.js materials. */
  renderMode: 'Opaque' | 'Cutout' | 'Transparent' | 'Fade';
  /** Alpha cutoff for Cutout mode, 0..1. Default 0.5. */
  alphaCutoff: number;
  /** 0 = double-sided, 1 = front-only (Unity convention inverted!), 2 =
   *  back-only. We report Unity's raw value; the client maps it to
   *  `THREE.DoubleSide / FrontSide / BackSide`. */
  cullMode: number;
}

/** Legacy alias kept for callers that only need the simple view. */
export interface LegacyParsedMaterial {
  guid: string;
  name: string;
  color: [number, number, number, number];
  mainTexGuid?: string;
  shader?: string;
}

/**
 * Small LRU-ish cache (bounded size) for parsed materials, keyed by guid.
 */
const CACHE = new Map<string, ParsedMaterial>();
const CACHE_LIMIT = 2048;

function cacheSet(guid: string, mat: ParsedMaterial): void {
  if (CACHE.size >= CACHE_LIMIT) {
    const firstKey = CACHE.keys().next().value;
    if (firstKey !== undefined) CACHE.delete(firstKey);
  }
  CACHE.set(guid, mat);
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

/** Priority lists cover both URP (_BaseColor, _BaseMap, _BumpMap,
 *  _OcclusionMap, _MetallicGlossMap, _EmissionColor, _EmissionMap) and the
 *  older Built-in Standard shader properties. When multiple names match the
 *  first found wins. */
const COLOR_BASE = ['_BaseColor', '_Color', '_MainColor', '_TintColor'];
const COLOR_EMISSION = ['_EmissionColor', '_EmissiveColor'];

const TEX_BASE = ['_BaseMap', '_BaseColorMap', '_MainTex', '_Albedo'];
const TEX_NORMAL = ['_BumpMap', '_NormalMap'];
const TEX_OCCLUSION = ['_OcclusionMap'];
const TEX_METALLIC = ['_MetallicGlossMap', '_SpecGlossMap'];
const TEX_EMISSION = ['_EmissionMap'];

const FLOAT_METALLIC = ['_Metallic'];
const FLOAT_SMOOTHNESS = ['_Smoothness', '_Glossiness'];
const FLOAT_BUMP_SCALE = ['_BumpScale'];
const FLOAT_OCCLUSION_STRENGTH = ['_OcclusionStrength'];
const FLOAT_CUTOFF = ['_Cutoff', '_AlphaCutoff'];
const FLOAT_CULL = ['_Cull', '_CullMode'];
const FLOAT_SURFACE = ['_Surface']; // URP: 0 opaque, 1 transparent
const FLOAT_ALPHA_CLIP = ['_AlphaClip']; // URP: 0 off, 1 on
const FLOAT_MODE = ['_Mode']; // Standard shader: 0 opaque, 1 cutout, 2 fade, 3 transparent

function pickNamedEntry<T>(
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
  const v = pickNamedEntry(list, names);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function normalizeGuid(g: unknown): string | undefined {
  if (typeof g !== 'string') return undefined;
  const s = g.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return undefined;
  return s;
}

function textureRef(env: UnityTexEnv | undefined): MaterialTextureRef | undefined {
  if (!env) return undefined;
  const guid = normalizeGuid(env.m_Texture?.guid);
  if (!guid) return undefined;
  const sx = env.m_Scale?.x;
  const sy = env.m_Scale?.y;
  const ox = env.m_Offset?.x;
  const oy = env.m_Offset?.y;
  const ref: MaterialTextureRef = { guid };
  const hasTiling = typeof sx === 'number' && typeof sy === 'number' && (sx !== 1 || sy !== 1);
  const hasOffset = typeof ox === 'number' && typeof oy === 'number' && (ox !== 0 || oy !== 0);
  if (hasTiling) ref.tiling = [sx!, sy!];
  if (hasOffset) ref.offset = [ox!, oy!];
  return ref;
}

/**
 * Classify a Unity shader reference into one of our three buckets.
 *
 * We treat URP Lit, Built-in Standard (regular + Specular setup), and most
 * Shader Graph-based lit shaders as "lit". Anything matching /unlit/i or
 * known GUI/particle/skybox unlit stacks is "unlit". Everything else we
 * conservatively mark "unknown" — the client defaults unknown to lit.
 */
async function classifyShader(
  guid: string | undefined,
): Promise<{ kind: ParsedMaterial['shaderKind']; name?: string }> {
  if (!guid) return { kind: 'unknown' };
  const rec = assetIndex.get(guid);
  if (!rec) return { kind: 'unknown' };

  // Fast path: shader identity by filename.
  const base = path.basename(rec.absPath).toLowerCase();
  if (/unlit/.test(base)) return { kind: 'unlit', name: rec.relPath };
  if (/(lit|standard|specular)/.test(base)) return { kind: 'lit', name: rec.relPath };

  // Slow path: try to read the first line of the .shader file and match
  // `Shader "..."`. Some shader graphs store the pipeline classification
  // in keywords (e.g. `_SURFACE_TYPE_TRANSPARENT`) — we don't need those
  // for the lit/unlit split.
  try {
    const raw = await fs.readFile(rec.absPath, 'utf8');
    const head = raw.slice(0, 512);
    const match = /Shader\s+"([^"]+)"/.exec(head);
    if (match) {
      const name = match[1];
      const low = name.toLowerCase();
      if (/unlit/.test(low)) return { kind: 'unlit', name };
      if (/(lit|standard|specular|pbr)/.test(low)) return { kind: 'lit', name };
      return { kind: 'unknown', name };
    }
  } catch {
    /* swallow — missing or unreadable shader files are common in sparse checkouts */
  }
  return { kind: 'unknown', name: rec.relPath };
}

/**
 * Derive a blending / alpha-clip mode. URP marks blend state via `_Surface`
 * and `_AlphaClip`, Built-in Standard uses a single `_Mode` enum. We pick
 * whichever is present.
 */
function deriveRenderMode(
  body: UnityMaterialBody,
  colorAlpha: number,
): ParsedMaterial['renderMode'] {
  const floats = body.m_SavedProperties?.m_Floats;
  const mode = pickFloat(floats, FLOAT_MODE);
  if (mode !== undefined) {
    // Standard shader enum order: 0 Opaque, 1 Cutout, 2 Fade, 3 Transparent.
    if (mode >= 3) return 'Transparent';
    if (mode >= 2) return 'Fade';
    if (mode >= 1) return 'Cutout';
    return 'Opaque';
  }
  const surface = pickFloat(floats, FLOAT_SURFACE);
  const alphaClip = pickFloat(floats, FLOAT_ALPHA_CLIP);
  if (surface === 1) return 'Transparent';
  if (alphaClip === 1) return 'Cutout';
  if (colorAlpha < 0.999) return 'Transparent';
  return 'Opaque';
}

// Log-once de-dup so a scene that references the same unfetched .mat
// 500 times doesn't spam the server log 500 times. Count is exposed
// via `getLfsPointerMaterialStats()` so a caller can decide to kick
// off a synchronous fetch and retry.
const LFS_POINTER_MAT_SEEN = new Set<string>();
let LFS_POINTER_MAT_HITS = 0;
function logLfsPointerMaterialOnce(relPath: string): void {
  LFS_POINTER_MAT_HITS += 1;
  if (LFS_POINTER_MAT_SEEN.has(relPath)) return;
  LFS_POINTER_MAT_SEEN.add(relPath);
  console.warn(
    `[materialParser] ${relPath} is still an LFS pointer — material returned ` +
      `as undefined. Scene will render with three.js default (magenta) ` +
      `until the .mat blob lands on disk.`,
  );
}

/**
 * Returns and resets the pointer-hit counter. Useful right after a
 * scene parse to decide whether it's worth kicking off a secondary
 * LFS fetch pass for `.mat` files before serving the JSON.
 */
export function consumeLfsPointerMaterialStats(): { hits: number; distinct: number } {
  const out = { hits: LFS_POINTER_MAT_HITS, distinct: LFS_POINTER_MAT_SEEN.size };
  LFS_POINTER_MAT_HITS = 0;
  LFS_POINTER_MAT_SEEN.clear();
  return out;
}

export async function parseMaterialByGuid(guid: string): Promise<ParsedMaterial | undefined> {
  if (!guid) return undefined;
  const key = guid.toLowerCase();
  const cached = CACHE.get(key);
  if (cached) return cached;

  const rec = assetIndex.get(key);
  if (!rec || rec.ext !== '.mat') return undefined;

  // `.mat` files on this project are LFS-tracked — when the lazy LFS
  // fetch hasn't materialised the blob yet we see the 130-byte pointer
  // text. Reading that as YAML would silently "succeed" with an empty
  // doc stream, then materials come back as undefined and the viewer
  // paints every surface magenta (three.js's default-material fallback).
  // Detect pointers explicitly and log once per GUID so a real missing
  // material is still distinguishable from a not-yet-fetched one.
  let rawBuf: Buffer;
  try {
    rawBuf = await fs.readFile(rec.absPath);
  } catch {
    return undefined;
  }
  if (isLfsPointerBuf(rawBuf)) {
    logLfsPointerMaterialOnce(rec.relPath);
    return undefined;
  }
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

  const props = body.m_SavedProperties;
  const texEnvs = props?.m_TexEnvs;
  const colors = props?.m_Colors;
  const floats = props?.m_Floats;

  const colorRaw = pickNamedEntry(colors, COLOR_BASE);
  const color = unityColorToRgba(colorRaw);

  // Unity convention: emission defaults to black (0,0,0) when the property
  // isn't authored and when the `_EMISSION` shader keyword is OFF. Our
  // generic unityColorToRgba defaults missing channels to 1 (sensible for
  // base colour), which would wrongly paint every material self-illuminated
  // white. Read it manually with a zero default and respect `_EMISSION`.
  const emissionRaw = pickNamedEntry(colors, COLOR_EMISSION);
  const emissionEnabled = /(^|\s)_EMISSION(\s|$)/.test(body.m_ShaderKeywords ?? '');
  const emissionColor: [number, number, number] =
    emissionRaw && emissionEnabled
      ? [emissionRaw.r ?? 0, emissionRaw.g ?? 0, emissionRaw.b ?? 0]
      : [0, 0, 0];

  const baseMap = textureRef(pickNamedEntry(texEnvs, TEX_BASE));
  const normalMap = textureRef(pickNamedEntry(texEnvs, TEX_NORMAL));
  const occlusionMap = textureRef(pickNamedEntry(texEnvs, TEX_OCCLUSION));
  const metallicGlossMap = textureRef(pickNamedEntry(texEnvs, TEX_METALLIC));
  const emissionMap = emissionEnabled
    ? textureRef(pickNamedEntry(texEnvs, TEX_EMISSION))
    : undefined;

  const metallic = pickFloat(floats, FLOAT_METALLIC) ?? 0;
  const smoothness = pickFloat(floats, FLOAT_SMOOTHNESS) ?? 0.5;
  const bumpScale = pickFloat(floats, FLOAT_BUMP_SCALE) ?? 1;
  const occlusionStrength = pickFloat(floats, FLOAT_OCCLUSION_STRENGTH) ?? 1;
  const alphaCutoff = pickFloat(floats, FLOAT_CUTOFF) ?? 0.5;
  const cullMode = pickFloat(floats, FLOAT_CULL) ?? 2;

  const shaderGuid = normalizeGuid(body.m_Shader?.guid);
  const { kind: shaderKind, name: shaderName } = await classifyShader(shaderGuid);

  const mat: ParsedMaterial = {
    guid: key,
    name: body.m_Name || path.basename(rec.absPath, '.mat'),
    shaderKind,
    shaderGuid,
    shaderName,

    color,
    baseMap,
    normalMap,
    occlusionMap,
    metallicGlossMap,
    emissionMap,

    metallic: clamp01(metallic),
    smoothness: clamp01(smoothness),
    emissionColor,
    bumpScale,
    occlusionStrength,

    renderMode: deriveRenderMode(body, color[3]),
    alphaCutoff,
    cullMode,
  };

  cacheSet(key, mat);
  return mat;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
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
