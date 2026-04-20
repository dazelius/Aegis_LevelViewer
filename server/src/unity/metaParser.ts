import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { assetIndex } from './assetIndex.js';

/**
 * Information extracted from an FBX asset's sibling `.meta` file.
 *
 * Unity assigns each mesh inside an FBX a stable fileID (e.g. 4300000). The
 * MeshFilter component in a scene references that fileID plus the FBX's GUID.
 * To actually find the correct sub-mesh inside the binary FBX on the client
 * we need the human-readable mesh name, which Unity stores in the
 * ModelImporter's `internalIDToNameTable` / `fileIDToRecycleName`.
 *
 * We also capture `externalObjects` — the ModelImporter's material remap
 * table. Prefab variants that extend a model rarely restate material slots
 * in their YAML (because Unity resolves them via the importer at edit
 * time), so we need this data to reconstruct the scene's final material
 * assignment when `m_Materials=[]`.
 */
export interface FbxMeshInfo {
  /** Map of `fileID` (as string) -> mesh name inside the FBX. Only entries
   *  with Unity classId = 43 (Mesh) are kept. */
  meshNames: Map<string, string>;
  /** Material remap table from ModelImporter.externalObjects, keyed by the
   *  embedded material's name. Each value is an external `.mat` GUID that
   *  Unity uses at import time to replace the FBX's own embedded material.
   *  Empty if the FBX has no remap (= uses its own embedded materials). */
  materialByName: Map<string, string>;
  /** Ordered list of external material GUIDs from `externalObjects`. When
   *  we don't know which submesh goes with which slot, we fall back to
   *  offering this list in declaration order — the client picks the first
   *  one that resolves. */
  materialGuidsInOrder: string[];
}

// FBX .meta parse results are cached forever (they only change on a git sync,
// which triggers a server restart / re-build of the asset index).
const CACHE = new Map<string, FbxMeshInfo | undefined>();
const INFLIGHT = new Map<string, Promise<FbxMeshInfo | undefined>>();

// Unity's class id for a Mesh asset. FBX files typically expose each mesh
// under this classId with fileIDs in the 4_300_000 range.
const MESH_CLASS_ID = '43';

function coerceMetaText(text: string): string {
  // Same quoting as preprocessUnityYaml so that guid/fileID stay as strings.
  // We intentionally don't reuse preprocessUnityYaml because .meta files
  // don't have the `!u!<classId>` doc header, so the doc header regex isn't
  // needed here.
  //
  // We also defensively quote any unquoted `name:` value. Unity writes FBX
  // embedded material names verbatim (e.g. `name: Material #27`). In YAML,
  // an unquoted `#` after whitespace starts a line comment — so without
  // this step js-yaml happily parses that line as `name: "Material"` and
  // drops the `#27`, wrecking the externalObjects remap table. Wrapping
  // the value in double quotes tells the parser to take the entire string
  // as literal text. Values that are already quoted, or that start with a
  // flow-sequence/map opener (`[`, `{`), are left alone.
  return text
    .replace(/(\bguid:\s*)([0-9a-fA-F]{32})\b/g, '$1"$2"')
    .replace(/(\bfileID:\s*)(-?\d+)\b/g, '$1"$2"')
    // Unity 2022+ FBX imports use STABLE HASHED sub-asset IDs that are
    // 17–19 digit 64-bit integers (e.g. `824511869930607519`). These appear
    // inside `internalIDToNameTable` as a bare "<classId>: <fileID>" map
    // entry — note the key is not `fileID:` but `43:` (the mesh classId),
    // so the previous rule doesn't catch them. JavaScript's `Number` tops
    // out at 2^53 ≈ 16-digit values, so parsing these as numbers silently
    // truncates the last few digits and breaks the scene MeshFilter →
    // sub-mesh name lookup (the client falls back to the first mesh in the
    // FBX, which is usually the wrong one). Quoting the value keeps it as
    // a string end-to-end, preserving precision.
    .replace(/^(\s+\d+:)[ \t]+(-?\d+)[ \t]*$/gm, '$1 "$2"')
    .replace(
      /^(\s+name:)[ \t]+([^"'\[\{\r\n][^\r\n]*?)[ \t]*$/gm,
      (_, prefix: string, rawVal: string) => {
        const escaped = rawVal.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `${prefix} "${escaped}"`;
      },
    );
}

interface MetaExternalObjectEntry {
  first?: {
    type?: string;
    assembly?: string;
    name?: string;
  };
  second?: {
    fileID?: unknown;
    guid?: unknown;
    type?: unknown;
  };
}

interface MetaDoc {
  ModelImporter?: {
    internalIDToNameTable?: Array<{
      first?: Record<string, unknown>;
      second?: unknown;
    }>;
    fileIDToRecycleName?: Record<string, unknown>;
    externalObjects?: MetaExternalObjectEntry[];
  };
}

async function parseFbxMeta(absPath: string): Promise<FbxMeshInfo | undefined> {
  let text: string;
  try {
    text = await fs.readFile(`${absPath}.meta`, 'utf8');
  } catch {
    return undefined;
  }

  let doc: MetaDoc;
  try {
    doc = yaml.load(coerceMetaText(text), { schema: yaml.CORE_SCHEMA }) as MetaDoc;
  } catch {
    return undefined;
  }

  const meshNames = new Map<string, string>();

  // Modern Unity (serializedVersion >= 20000). internalIDToNameTable is an
  // array of { first: {<classId>: <fileID>}, second: <name> }.
  const table = doc?.ModelImporter?.internalIDToNameTable;
  if (Array.isArray(table)) {
    for (const entry of table) {
      if (!entry?.first || typeof entry.second !== 'string') continue;
      for (const [classId, fileID] of Object.entries(entry.first)) {
        if (String(classId) !== MESH_CLASS_ID) continue;
        if (fileID === undefined || fileID === null) continue;
        meshNames.set(String(fileID), entry.second);
      }
    }
  }

  // Legacy (pre-2020) Unity stored the mapping as a flat map.
  const legacy = doc?.ModelImporter?.fileIDToRecycleName;
  if (legacy && typeof legacy === 'object') {
    for (const [fid, name] of Object.entries(legacy)) {
      if (typeof name !== 'string') continue;
      if (!meshNames.has(String(fid))) meshNames.set(String(fid), name);
    }
  }

  // externalObjects entries are `first: { type, assembly, name } -> second:
  // { fileID, guid, type }`. We only want `UnityEngine:Material` remaps —
  // textures / avatars are resolved separately on the client. Duplicate
  // names (rare) resolve to the first entry, matching Unity's behaviour.
  const materialByName = new Map<string, string>();
  const materialGuidsInOrder: string[] = [];
  const external = doc?.ModelImporter?.externalObjects;
  if (Array.isArray(external)) {
    for (const entry of external) {
      const typeStr = entry?.first?.type;
      const name = entry?.first?.name;
      const guidRaw = entry?.second?.guid;
      if (typeof typeStr !== 'string') continue;
      if (!typeStr.endsWith('Material')) continue;
      if (typeof name !== 'string' || name.length === 0) continue;
      if (typeof guidRaw !== 'string' || !/^[0-9a-f]{32}$/i.test(guidRaw)) continue;
      const guid = guidRaw.toLowerCase();
      if (!materialByName.has(name)) {
        materialByName.set(name, guid);
        materialGuidsInOrder.push(guid);
      }
    }
  }

  return { meshNames, materialByName, materialGuidsInOrder };
}

/**
 * Resolve an FBX's mesh name table. Returns `undefined` if the FBX is not
 * indexed, its .meta couldn't be parsed, or it simply contains no meshes.
 *
 * Results are memoised per-GUID for the lifetime of the process.
 */
export async function getFbxMeshInfo(guid: string): Promise<FbxMeshInfo | undefined> {
  const key = guid.toLowerCase();
  if (CACHE.has(key)) return CACHE.get(key);
  const existing = INFLIGHT.get(key);
  if (existing) return existing;

  const rec = assetIndex.get(key);
  if (!rec) {
    CACHE.set(key, undefined);
    return undefined;
  }

  const p = parseFbxMeta(rec.absPath).then(
    (info) => {
      CACHE.set(key, info);
      INFLIGHT.delete(key);
      return info;
    },
    () => {
      CACHE.set(key, undefined);
      INFLIGHT.delete(key);
      return undefined;
    },
  );
  INFLIGHT.set(key, p);
  return p;
}

/**
 * Resolve a single `(guid, fileID)` to a mesh name, if we can find it.
 * Wrapper around {@link getFbxMeshInfo}.
 */
export async function resolveFbxMeshName(
  guid: string,
  fileID: string,
): Promise<string | undefined> {
  const info = await getFbxMeshInfo(guid);
  return info?.meshNames.get(String(fileID));
}
