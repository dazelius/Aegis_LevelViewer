/**
 * Build-time "content bundle" baker for Aegisgram.
 *
 * This script runs ONCE on a workstation that has:
 *   - Access to the Project Aegis GitLab (env: GITLAB_REPO2_URL/TOKEN)
 *   - A working Unity Editor matching the project version (optional —
 *     when missing, we fall back to the YAML parser for any scene that
 *     doesn't already have a baked JSON in `data/unity-export/`)
 *   - sharp + ts runtime (already part of server devDependencies)
 *
 * It produces `data/bundle/` — a fully self-contained, opaque content
 * pack for the deployed Aegisgram server:
 *
 *     data/bundle/
 *       manifest.json                 — scene list + GUID→blob map
 *       scenes/<relPath>.json         — per-scene render payload
 *       blobs/<guid><ext>             — only the textures/meshes the
 *                                       above scenes actually reference
 *       fbx-materials/<guid>.json     — pre-computed character/weapon
 *                                       external-material packs
 *
 * Textures are re-encoded to PNG (cap 1024 px longer edge, identical to
 * what the live `/api/assets/texture` route does at request time). That
 * means the deployed server doesn't need `sharp`/`lunapaint`/`ag-psd` at
 * all — it just streams the pre-baked PNG bytes.
 *
 * Run:
 *     npm run bake                     # from repo root
 *
 * Incremental: the script is idempotent. Re-running skips blobs that
 * already exist in the bundle (matches by GUID), skips scenes whose
 * input hasn't changed, and only re-writes the manifest. Delete
 * `data/bundle/` to force a full re-bake.
 */
// Force a full LFS pull during bake — we NEED the texture/FBX bytes, not
// pointer files. The server's default is `LEVEL_VIEWER_GIT_FETCH_LFS=false`
// because live mode only parses YAML; the bake step's requirements are
// fundamentally different. Setting this before any `../server/src/*`
// import means `config.ts` picks it up during its one-time module load.
// Anyone explicitly setting the env var to 'false' in their shell can
// still override (rare, debugging-only).
if (!process.env.LEVEL_VIEWER_GIT_FETCH_LFS) {
  process.env.LEVEL_VIEWER_GIT_FETCH_LFS = 'true';
}

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { decodeTga } from '@lunapaint/tga-codec';
import { readPsd, initializeCanvas } from 'ag-psd';

import { config } from '../server/src/config.js';
import { syncUnityRepo } from '../server/src/git/gitSync.js';
import { assetIndex } from '../server/src/unity/assetIndex.js';
import { listScenes } from '../server/src/unity/sceneScanner.js';
import { parseScene, toMaterialJson } from '../server/src/unity/sceneParser.js';
import { getFbxMeshInfo } from '../server/src/unity/metaParser.js';
import { parseMaterialByGuid } from '../server/src/unity/materialParser.js';
import { bakedJsonPathFor } from '../server/src/unity/batchRunner.js';
import type {
  BundleBlobEntry,
  BundleManifest,
  BundleSceneEntry,
} from '../server/src/bundle/bundleIndex.js';

// ag-psd canvas stubs — identical to the pair registered in api/routes.ts.
// Required so reading PSDs as pure data works without a native canvas pkg.
initializeCanvas(
  ((_w: number, _h: number) => ({
    width: _w,
    height: _h,
    getContext: () => {
      throw new Error('stub-canvas-skip-side-path');
    },
  })) as unknown as (width: number, height: number) => HTMLCanvasElement,
  ((w: number, h: number) => ({
    data: new Uint8ClampedArray(w * h * 4),
    width: w,
    height: h,
  })) as unknown as (width: number, height: number) => ImageData,
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------
// Seed GUIDs — assets the client fetches without a scene reference.
//
// These MUST match `web/src/lib/playerCharacter.ts`'s hardcoded GUIDs.
// The character + weapon + animation clip FBXes are loaded unconditionally
// on play-mode entry, so they never show up in any scene JSON's
// transitive GUID closure. Copying them manually at bake time is the
// simplest way to keep the bundle self-contained.
//
// NOTE: if playerCharacter.ts changes its GUIDs (new character / weapon
// skins), this list MUST be updated too. A test that asserts matching
// constants would be nice eventually; for now the duplication is
// intentional because importing the client module drags Three.js into
// the Node bake context.
// ---------------------------------------------------------------------
const PLAYER_SEED_GUIDS: readonly string[] = [
  // Character + weapon FBX
  '9b49e922223ddbb4191985ea1b9df8ff',
  'c392d081eb00fc64b91518acdc3b53d7',
  // Standing animations
  'a890c2483d4cb0943a72cf663370b1fb',
  '96a7ca11a3b7aac47a6905a6175d373e',
  'eb4ca948711fe0943aa7f94d34bfcd10',
  '204a80b70b90b8d4294a885dd7f6ebca',
  '648c4e3e19e6fce4c8d1aabd91f7205c',
  'd11afb85d6bc053418016f9081879065',
  '9fbad436d143fca478fa8ea42ed129ba',
  '02e4dab38a9dbb5479f83aa3cc4198fe',
  'f99d7b1af56db6b40a85bc0228a06d67',
  // Crouch animations
  '79fe1cfd902bc0642ac75e3ca0665d87',
  'f22fbbf1830463347b0aa538a70101da',
  'fbd1de97965faa84ba111590fcd1b052',
  'e3538b7c419f7344d9cf01ee5e33808c',
  'ffc1643e7a36158438cca6614f371330',
  'bf2bbf7db58eaac4faa3df26ae725e90',
];

/** FBX GUIDs for which we need to emit a `fbx-materials/<guid>.json` pack.
 *  For now this is just character + weapon; animation FBXes have no
 *  material remap worth shipping. */
const FBX_MATERIAL_SEED_GUIDS: readonly string[] = [
  '9b49e922223ddbb4191985ea1b9df8ff',
  'c392d081eb00fc64b91518acdc3b53d7',
];

const MAX_TEXTURE_DIM = 1024;

// ---------------------------------------------------------------------
// GUID extraction — walks an arbitrary scene JSON value and collects
// every string that looks like a 32-char hex GUID found under a key
// ending in "Guid" or inside a "textureGuids" / "materialGuids" array.
// Forward-compatible: new map types added to the Unity exporter (e.g.
// `detailMapGuid`) are picked up automatically without code changes.
// ---------------------------------------------------------------------
const GUID_RE = /^[0-9a-f]{32}$/;

function collectGuids(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (GUID_RE.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectGuids(v, out);
    return;
  }
  if (typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      const lower = v.toLowerCase();
      if (GUID_RE.test(lower) && (key.toLowerCase().endsWith('guid') || key === 'guid')) {
        out.add(lower);
      }
    } else {
      collectGuids(v, out);
    }
  }
}

// ---------------------------------------------------------------------
// Content-type inference for bundle blobs. The live routes derive this
// per-request; we store it in the manifest so the deployed server does
// a zero-work lookup.
// ---------------------------------------------------------------------
function contentTypeForExt(ext: string): string {
  switch (ext) {
    case '.png':
    case '.tga':
    case '.psd':
    case '.jpg':
    case '.jpeg':
    case '.bmp':
    case '.webp':
    case '.gif':
      return 'image/png';
    case '.fbx':
      return 'model/fbx';
    case '.obj':
      return 'model/obj';
    default:
      return 'application/octet-stream';
  }
}

// ---------------------------------------------------------------------
// Texture transcoding — mirrors `/api/assets/texture`. Returns a Buffer
// of PNG bytes ready to write to `blobs/<guid>.png`. Throws on formats
// sharp can't handle that we also don't explicitly support.
// ---------------------------------------------------------------------
async function transcodeTexture(absPath: string, ext: string): Promise<Buffer> {
  const buf = await fs.readFile(absPath);
  const resizeOpts: sharp.ResizeOptions = {
    width: MAX_TEXTURE_DIM,
    height: MAX_TEXTURE_DIM,
    fit: 'inside',
    withoutEnlargement: true,
  };

  if (ext === '.tga') {
    const decoded = await decodeTga(buf);
    const { data, width, height } = decoded.image;
    return await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 },
    })
      .resize(resizeOpts)
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  if (ext === '.psd') {
    const psd = readPsd(buf, {
      skipLayerImageData: true,
      skipThumbnail: true,
      skipCompositeImageData: false,
      useImageData: true,
      throwForMissingFeatures: false,
    });
    const composite = psd.imageData;
    if (!composite?.data || !composite.width || !composite.height) {
      throw new Error('psd has no composite image');
    }
    let rgba: Buffer;
    const raw = composite.data as unknown;
    if (raw instanceof Uint8Array || raw instanceof Uint8ClampedArray) {
      rgba = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    } else if (raw instanceof Uint16Array) {
      const u8 = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) u8[i] = raw[i] >> 8;
      rgba = Buffer.from(u8.buffer);
    } else if (raw instanceof Float32Array) {
      const u8 = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) {
        const v = raw[i];
        u8[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
      }
      rgba = Buffer.from(u8.buffer);
    } else {
      throw new Error('psd unsupported pixel array');
    }
    return await sharp(rgba, {
      raw: { width: composite.width, height: composite.height, channels: 4 },
    })
      .resize(resizeOpts)
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  return await sharp(buf, { failOn: 'none' })
    .resize(resizeOpts)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const TEXTURE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.webp', '.gif', '.psd']);
const MESH_EXTS = new Set(['.fbx', '.obj', '.asset', '.mesh']);

/** True for file extensions that the live routes classify as Git LFS
 *  targets in Aegis (.fbx + various binary textures). A pointer-shaped
 *  input signals the developer forgot to run `git lfs pull` locally. */
function isLfsPointer(buf: Buffer): boolean {
  if (buf.length > 1024) return false;
  return buf.slice(0, 64).toString('utf8').startsWith('version https://git-lfs.github.com/spec/');
}

// ---------------------------------------------------------------------
// Per-scene bake — returns the JSON string + the (potentially huge) set
// of GUIDs the scene references.
// ---------------------------------------------------------------------
interface BakedSceneResult {
  json: string;
  parsed: unknown;
  source: 'unity-export' | 'yaml-parser';
}

async function bakeScene(relPath: string, absPath: string): Promise<BakedSceneResult> {
  // Prefer pre-existing Unity batch exports — they carry richer lighting
  // + geometry info. The dev host is responsible for running /api/rebake
  // before baking; we intentionally don't auto-spawn Unity here.
  const unityBaked = bakedJsonPathFor(relPath);
  try {
    const st = await fs.stat(unityBaked);
    if (st.isFile()) {
      const json = await fs.readFile(unityBaked, 'utf8');
      return { json, parsed: JSON.parse(json), source: 'unity-export' };
    }
  } catch {
    // fall through to YAML parser
  }

  const parsed = await parseScene(absPath, relPath);
  // Tag the YAML output with its format version — same header the live
  // /api/levels/* endpoint prepends.
  const tagged = { format: 'yaml-mvp@1', ...parsed };
  return { json: JSON.stringify(tagged), parsed: tagged, source: 'yaml-parser' };
}

// ---------------------------------------------------------------------
// Preflight — surface every common "why is my clone silently dying"
// failure mode in one fail-fast block with human-readable output.
//
// The bake's very first action is a `git clone` against the configured
// GitLab, and when that silently hangs or exits 1 it's almost always
// one of:
//   - git / git-lfs not installed on the host
//   - URL requires auth but no `GITLAB_REPO2_TOKEN` was provided, so
//     git CLI blocks waiting for credentials from a TTY that doesn't
//     exist, then the platform's silence-timeout kills the process
//   - URL scheme is http:// and the host disallows unencrypted
//     credentials
// We print a single diagnostic block and intentionally throw early
// when the combo is unworkable, so the platform operator sees a
// clear error instead of "process exited with code 1".
// Everything is written to STDOUT (even errors) because many
// platform log viewers surface stdout but truncate stderr.
// ---------------------------------------------------------------------
function which(cmd: string): { ok: true; version: string } | { ok: false; message: string } {
  try {
    const res = spawnSync(cmd, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (res.status === 0) {
      return { ok: true, version: res.stdout.trim().split('\n')[0] };
    }
    return { ok: false, message: res.stderr.trim() || `exit ${res.status}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return raw;
  }
}

function preflight(): void {
  console.log('[bake] ==================== PREFLIGHT ====================');
  console.log(`[bake] node:      ${process.version} (${process.platform}/${process.arch})`);
  console.log(`[bake] cwd:       ${process.cwd()}`);

  const git = which('git');
  if (git.ok) {
    console.log(`[bake] git:       ${git.version}`);
  } else {
    console.log(`[bake] git:       NOT FOUND — ${git.message}`);
    throw new Error(
      'git CLI is required but not installed on this host. Install git (and git-lfs) and retry.',
    );
  }

  const gitLfs = which('git-lfs');
  if (gitLfs.ok) {
    console.log(`[bake] git-lfs:   ${gitLfs.version}`);
  } else {
    console.log(
      `[bake] git-lfs:   NOT FOUND — ${gitLfs.message}. LFS assets (textures, FBX) will NOT be pulled; bundle will be incomplete.`,
    );
    // Soft warning. Scene YAML will still come through because it's
    // text-tracked in Aegis; only the binary blobs go missing.
  }

  const url = config.gitlabRepo2Url;
  const token = config.gitlabRepo2Token;
  const authed = token && url;
  console.log(`[bake] repo URL:  ${maskUrl(url)}`);
  console.log(`[bake] repo auth: ${authed ? 'token present' : 'NO token (anonymous clone)'}`);
  if (!authed) {
    console.log(
      '[bake] hint:      set GITLAB_REPO2_TOKEN (or bake against an SSH URL with deploy key) ' +
        'if your GitLab requires authentication. Silent clone failures with no error output ' +
        'almost always mean git CLI is blocked on a credential prompt.',
    );
  }
  if (url.startsWith('http://')) {
    console.log(
      '[bake] note:      URL is plain HTTP — some GitLab setups disable credentials over http. ' +
        'Use https:// if auth is required.',
    );
  }

  console.log(`[bake] branch:    ${config.gitBranch}`);
  console.log(`[bake] lfs fetch: ${config.gitFetchLfs ? 'full' : 'text-only'}`);
  console.log(`[bake] bundle:    ${config.bundleDir}`);
  console.log('[bake] ===================================================');
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function main(): Promise<void> {
  preflight();

  const bundleDir = config.bundleDir;
  const scenesOutDir = path.join(bundleDir, 'scenes');
  const blobsOutDir = path.join(bundleDir, 'blobs');
  const fbxMatsOutDir = path.join(bundleDir, 'fbx-materials');
  await fs.mkdir(scenesOutDir, { recursive: true });
  await fs.mkdir(blobsOutDir, { recursive: true });
  await fs.mkdir(fbxMatsOutDir, { recursive: true });

  // --- 1. Ensure the Aegis repo is synced -----------------------------------
  console.log('[bake] syncing Aegis repo...');
  const syncResult = await syncUnityRepo();
  console.log(`[bake] sync: ${syncResult.action}${syncResult.head ? ` @ ${syncResult.head}` : ''}`);
  if (syncResult.action === 'skipped' && syncResult.message?.startsWith('clone failed')) {
    // Hard fail — the rest of the bake has nothing to work on and would
    // produce an empty bundle. Better to stop with a clear error now.
    throw new Error(
      `Aegis clone failed: ${syncResult.message}. Check the PREFLIGHT block above for missing token / git-lfs.`,
    );
  }

  // --- 2. Build the asset index ---------------------------------------------
  console.log('[bake] building asset index...');
  await assetIndex.build();
  console.log(`[bake] asset index: ${assetIndex.size()} guids`);

  // --- 3. Enumerate scenes + bake each to JSON ------------------------------
  const scenes = await listScenes();
  console.log(`[bake] ${scenes.length} scenes to bake`);

  const allGuids = new Set<string>();
  const sceneEntries: BundleSceneEntry[] = [];

  for (let i = 0; i < scenes.length; i += 1) {
    const scene = scenes[i];
    const prefix = `[bake ${i + 1}/${scenes.length}]`;
    try {
      const { json, parsed, source } = await bakeScene(scene.relPath, scene.absPath);
      const outPath = path.join(scenesOutDir, scene.relPath.replace(/\.unity$/i, '') + '.json');
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, json, 'utf8');
      collectGuids(parsed, allGuids);
      sceneEntries.push({
        name: scene.name,
        relPath: scene.relPath,
        category: scene.category,
      });
      console.log(`${prefix} ${scene.relPath} (${source}, ${(json.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.warn(`${prefix} FAILED ${scene.relPath}: ${(err as Error).message}`);
    }
  }

  // --- 4. Seed GUIDs (character/weapon FBX + animation clips) --------------
  for (const g of PLAYER_SEED_GUIDS) allGuids.add(g.toLowerCase());

  // --- 5. Transitive closure: materials → textures -------------------------
  // For the YAML-parser path the scene JSON already includes the materials
  // dictionary with every texture GUID folded in. For the Unity-export
  // path the exporter does the same via its `textureGuids` list. We still
  // re-parse every indexed `.mat` file we already have a record for so
  // that FBX-embedded material remaps (which route through the live
  // `/api/assets/fbx-character-materials` endpoint) also pull in their
  // textures — the asset index has those materials by GUID.
  console.log('[bake] resolving material → texture closure...');
  const materialGuidsToResolve = new Set<string>();
  for (const g of allGuids) {
    const rec = assetIndex.get(g);
    if (rec && rec.ext === '.mat') materialGuidsToResolve.add(g);
  }
  let matTexAdded = 0;
  for (const matGuid of materialGuidsToResolve) {
    try {
      const parsed = await parseMaterialByGuid(matGuid);
      if (!parsed) continue;
      const js = toMaterialJson(parsed);
      for (const v of Object.values(js)) {
        if (typeof v === 'string' && GUID_RE.test(v) && !allGuids.has(v)) {
          allGuids.add(v);
          matTexAdded += 1;
        }
      }
    } catch {
      // ignore — missing material returns fallback in live path too
    }
  }
  console.log(`[bake] added ${matTexAdded} texture GUIDs from materials`);

  // --- 6. Copy / transcode blobs -------------------------------------------
  console.log(`[bake] copying ${allGuids.size} referenced blobs...`);
  const guidToBlob: Record<string, BundleBlobEntry> = {};
  let copied = 0;
  let skipped = 0;
  let missing = 0;
  let lfsMissing = 0;

  for (const guid of allGuids) {
    const rec = assetIndex.get(guid);
    if (!rec) {
      missing += 1;
      continue;
    }

    // Only bundle the asset types the client actually fetches. Materials,
    // scripts, prefabs etc. are already baked into the scene JSONs; their
    // GUIDs are in `allGuids` only because the scan is conservative.
    const isTexture = TEXTURE_EXTS.has(rec.ext);
    const isMesh = MESH_EXTS.has(rec.ext);
    if (!isTexture && !isMesh) {
      skipped += 1;
      continue;
    }

    const blobExt = isTexture ? '.png' : rec.ext;
    const blobPath = path.join(blobsOutDir, guid + blobExt);
    const entry: BundleBlobEntry = {
      ext: rec.ext,
      blobExt,
      originalRelPath: rec.relPath,
      contentType: isTexture ? 'image/png' : contentTypeForExt(rec.ext),
    };

    // Incremental: skip if already written AND at least non-empty
    let alreadyDone = false;
    try {
      const st = await fs.stat(blobPath);
      if (st.isFile() && st.size > 0) alreadyDone = true;
    } catch {
      // missing — we'll write it
    }
    if (alreadyDone) {
      guidToBlob[guid] = entry;
      continue;
    }

    try {
      if (isTexture) {
        const raw = await fs.readFile(rec.absPath);
        if (isLfsPointer(raw)) {
          lfsMissing += 1;
          console.warn(
            `[bake] LFS pointer for ${rec.relPath} (${guid}) — skipping. Run \`git lfs pull\` in the Aegis clone.`,
          );
          continue;
        }
        const png = await transcodeTexture(rec.absPath, rec.ext);
        await fs.writeFile(blobPath, png);
      } else {
        // mesh — copy raw bytes
        const raw = await fs.readFile(rec.absPath);
        if (isLfsPointer(raw)) {
          lfsMissing += 1;
          console.warn(
            `[bake] LFS pointer for ${rec.relPath} (${guid}) — skipping. Run \`git lfs pull\` in the Aegis clone.`,
          );
          continue;
        }
        await fs.writeFile(blobPath, raw);
      }
      guidToBlob[guid] = entry;
      copied += 1;
    } catch (err) {
      console.warn(`[bake] blob ${guid} (${rec.relPath}) failed: ${(err as Error).message}`);
    }
  }

  console.log(
    `[bake] blobs: ${copied} copied, ${Object.keys(guidToBlob).length} indexed, ` +
      `${skipped} skipped (non-renderable ext), ${missing} unresolved GUIDs, ` +
      `${lfsMissing} LFS pointers not pulled`,
  );

  // --- 7. Pre-compute FBX external-material packs --------------------------
  console.log('[bake] computing fbx-character-materials packs...');
  const fbxMaterialPacks: string[] = [];
  for (const guid of FBX_MATERIAL_SEED_GUIDS) {
    try {
      const info = await getFbxMeshInfo(guid);
      if (!info) {
        console.warn(`[bake] fbx-material ${guid}: meta unreadable, skipping`);
        continue;
      }
      const out: Record<string, unknown> = {};
      const cache = new Map<string, unknown | null>();
      for (const [name, matGuid] of info.materialByName.entries()) {
        let json = cache.get(matGuid);
        if (json === undefined) {
          try {
            const parsed = await parseMaterialByGuid(matGuid);
            json = parsed ? toMaterialJson(parsed) : null;
          } catch {
            json = null;
          }
          cache.set(matGuid, json);
          // Any texture GUIDs this material references but we haven't
          // bundled yet are logged so the seed list can grow. We don't
          // retroactively copy from here to keep the step simple; most
          // runs this is empty because step 5 already walked every
          // indexed `.mat`.
          if (json) {
            const js = json as Record<string, unknown>;
            for (const v of Object.values(js)) {
              if (typeof v === 'string' && GUID_RE.test(v) && !guidToBlob[v]) {
                console.warn(
                  `[bake] character FBX ${guid} references un-bundled texture ${v}`,
                );
              }
            }
          }
        }
        if (json) out[name] = json;
      }
      const outPath = path.join(fbxMatsOutDir, `${guid}.json`);
      await fs.writeFile(outPath, JSON.stringify({ materials: out }), 'utf8');
      fbxMaterialPacks.push(guid);
    } catch (err) {
      console.warn(`[bake] fbx-material ${guid}: ${(err as Error).message}`);
    }
  }

  // --- 8. Write manifest ---------------------------------------------------
  const manifest: BundleManifest = {
    version: 1,
    bakedAt: new Date().toISOString(),
    gitHead: syncResult.head,
    scenes: sceneEntries,
    guidToBlob,
    fbxMaterialPacks,
  };
  const manifestPath = path.join(bundleDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // --- 9. Optional source cleanup -----------------------------------------
  // Opt-in via `AEGISGRAM_POST_BAKE_CLEANUP=1`. Intended for platform build
  // steps where the runtime container is the same filesystem as the build:
  // the Aegis clone (often several GB) and the Unity batch export scratch
  // dir are useless at runtime once the bundle exists, and leaving them
  // around bloats the image. Never runs unless explicitly asked because a
  // local developer would lose their working clone.
  if (envFlag('AEGISGRAM_POST_BAKE_CLEANUP')) {
    const targets = [
      path.resolve(config.repoRoot, 'data/repos'),
      path.resolve(config.repoRoot, 'data/unity-export'),
    ];
    for (const t of targets) {
      try {
        await fs.rm(t, { recursive: true, force: true });
        console.log(`[bake] cleanup: removed ${t}`);
      } catch (err) {
        console.warn(`[bake] cleanup: ${t} — ${(err as Error).message}`);
      }
    }
  }

  // --- 10. Summary ---------------------------------------------------------
  const bytes = await sumDirBytes(bundleDir);
  console.log('');
  console.log('[bake] ==================== SUMMARY ====================');
  console.log(`[bake] scenes:          ${sceneEntries.length}`);
  console.log(`[bake] blobs indexed:   ${Object.keys(guidToBlob).length}`);
  console.log(`[bake] fbx-mat packs:   ${fbxMaterialPacks.length}`);
  console.log(`[bake] bundle size:     ${(bytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`[bake] manifest:        ${manifestPath}`);
}

function envFlag(key: string): boolean {
  const v = process.env[key];
  if (!v) return false;
  const n = v.toLowerCase();
  return n === '1' || n === 'true' || n === 'yes' || n === 'on';
}

async function sumDirBytes(dir: string): Promise<number> {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += (await fs.stat(p)).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}

// Defensive: if this script is imported (rather than run as CLI), don't
// kick off the bake. `import.meta.main` isn't universally supported so we
// compare module URL to argv.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[bake] fatal:', err);
    process.exit(1);
  });
}

// Silence unused-warning for REPO_ROOT (reserved for future use)
void REPO_ROOT;
