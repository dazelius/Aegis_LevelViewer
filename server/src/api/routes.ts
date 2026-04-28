import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import sharp from 'sharp';
import { decodeTga } from '@lunapaint/tga-codec';
import { readPsd, initializeCanvas } from 'ag-psd';

// ag-psd has two canvas-adjacent hooks it needs on Node:
//
//  1. `createCanvas(w, h)` — only called for embedded JPEG thumbnails
//     (image resource blocks 1033/1036). ag-psd wraps that decode in a
//     try/catch, so a dead stub whose `getContext` throws is fine: the
//     catch swallows the error and the parse continues. The failed stub
//     lands on `psd.imageResources.thumbnail` which we ignore.
//
//  2. `createImageData(w, h)` — called from `createImageDataBitDepth` on
//     the main composite / layer-image decode path, even with
//     `useImageData: true`. The default implementation routes through
//     `tempCanvas.getContext('2d').createImageData(…)` which will hit our
//     stub canvas and throw UN-caught, aborting the whole parse. So we
//     supply a canvas-free factory that returns a plain
//     `{ data, width, height }` record with a Uint8ClampedArray backing
//     store — this is exactly the shape ag-psd reads/writes on these
//     objects, and is what it would hand us on `psd.imageData` anyway.
//
// Registering both keeps us off native canvas packages (`canvas`,
// `@napi-rs/canvas`) and their toolchain requirements on Windows.
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
import { listScenes } from '../unity/sceneScanner.js';
import { parseScene, toMaterialJson } from '../unity/sceneParser.js';
import { assetIndex } from '../unity/assetIndex.js';
import { getFbxMeshInfo } from '../unity/metaParser.js';
import { parseMaterialByGuid } from '../unity/materialParser.js';
import { syncUnityRepo } from '../git/gitSync.js';
import {
  triggerLazyLfsForScene,
  triggerLfsFetch,
  ensureLfsFile,
  ensureSceneYamlPointersReady,
  bulkFetchMaterialsAndTextures,
  getBulkPrefetchProgress,
  getLfsHealth,
  isLfsPointerBuf,
  warmChangedPaths,
} from '../git/lazyLfs.js';
import { consumeLfsPointerMaterialStats } from '../unity/materialParser.js';
import { bundleMode, config, getAssetsDir, getRepo2LocalDir } from '../config.js';
import { bundleIndex, isBundleLfsPointer } from '../bundle/bundleIndex.js';
import {
  bakedJsonPathFor,
  getBatchStatus,
  runUnityExport,
} from '../unity/batchRunner.js';
import {
  addComment as addCommentToStore,
  isFeedback,
  listAll as listAllFeedbacks,
  listForScene as listFeedbacksForScene,
  removeComment as removeCommentFromStore,
  removeFeedback as removeFeedbackFromStore,
  sanitizeAuthor,
  sanitizeCommentText,
  setStatus as setFeedbackStatusOnStore,
  toggleLike as toggleLikeOnStore,
  upsertFeedback as upsertFeedbackToStore,
} from '../feedback/feedbackStore.js';
import {
  broadcastFeedbackAdded,
  broadcastFeedbackRemoved,
  broadcastFeedbackUpdated,
} from '../multiplayer/hub.js';

export const apiRouter: Router = Router();

apiRouter.get('/health', (_req: Request, res: Response) => {
  if (bundleMode) {
    res.json({
      ok: true,
      mode: 'bundle',
      bundleDir: config.bundleDir,
      bundleLoaded: bundleIndex.isLoaded(),
      scenes: bundleIndex.listScenes().length,
    });
    return;
  }
  res.json({
    ok: true,
    mode: 'live',
    assetsDir: getAssetsDir(),
    assetIndexBuilt: assetIndex.isBuilt(),
    indexedAssets: assetIndex.size(),
  });
});

apiRouter.get('/levels', async (_req: Request, res: Response) => {
  try {
    if (bundleMode) {
      // Bundle mode serves straight from the manifest — no FS scan.
      // The manifest's scene entries already carry the fields the
      // client picker expects.
      const scenes = bundleIndex.listScenes();
      res.json(scenes.map((s) => ({ name: s.name, relPath: s.relPath, category: s.category })));
      return;
    }
    const scenes = await listScenes();
    res.json(
      scenes.map((s) => ({ name: s.name, relPath: s.relPath, category: s.category })),
    );
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Warm-up endpoint. Clients (typically the level-list thumbnail grid)
 * POST to this when the user hovers or focuses a scene tile so we can
 * start streaming the scene YAML + its referenced LFS pointers into
 * the cache before the actual click lands. Always fire-and-forget:
 * we return 204 immediately and never block, so even rapid hover
 * storms don't accumulate work — the underlying `registerBatch`
 * layer dedupes in-flight fetches per absPath.
 *
 * No-op in bundle mode (nothing to warm — everything's pre-baked).
 */
apiRouter.post('/levels/*/warm', async (req: Request, res: Response) => {
  if (bundleMode) {
    res.status(204).end();
    return;
  }
  const relPathRaw = req.params[0];
  if (!relPathRaw || !relPathRaw.toLowerCase().endsWith('.unity')) {
    res.status(204).end();
    return;
  }
  const relPath = path.posix.normalize(relPathRaw).replace(/^(\.\.(\/|$))+/, '');
  if (relPath.startsWith('..') || relPath.includes('..\\')) {
    res.status(204).end();
    return;
  }
  const repoDir = getRepo2LocalDir();
  const absPath = path.join(repoDir, relPath);
  // Respond first — the warm work happens on the next tick.
  res.status(204).end();
  // The scene YAML itself might be a pointer, so register it for fetch
  // and, on completion, walk its GUID graph. We intentionally don't
  // await anything here: callers treat this as hinting.
  void (async () => {
    try {
      await ensureLfsFile(absPath, repoDir, 15_000);
      triggerLazyLfsForScene(absPath, repoDir);
      await ensureSceneYamlPointersReady(absPath, repoDir, 5_000).catch(() => undefined);
    } catch {
      // never propagate
    }
  })();
});

apiRouter.get('/levels/*', async (req: Request, res: Response) => {
  const relPathRaw = req.params[0];
  if (!relPathRaw) {
    res.status(400).json({ error: 'relPath required' });
    return;
  }
  // Guard against path traversal.
  const relPath = path.posix.normalize(relPathRaw).replace(/^(\.\.(\/|$))+/, '');
  if (relPath.startsWith('..') || relPath.includes('..\\')) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  if (!relPath.toLowerCase().endsWith('.unity')) {
    res.status(400).json({ error: 'not a .unity file' });
    return;
  }

  // Bundle mode: the scene JSON is pre-baked at deploy time and lives
  // under `<bundleDir>/scenes/<relPath>.json`. We never fall back to the
  // YAML parser because a deployed environment doesn't have the source
  // .unity text at all (the bundle intentionally omits it).
  if (bundleMode) {
    const scenePath = bundleIndex.sceneJsonPath(relPath);
    try {
      const stat = await fs.stat(scenePath);
      if (stat.isFile()) {
        const buf = await fs.readFile(scenePath, 'utf8');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Level-Source', 'bundle');
        res.setHeader('X-Level-Baked-At', new Date(stat.mtimeMs).toISOString());
        res.end(buf);
        return;
      }
    } catch {
      // fall through to 404
    }
    res.status(404).json({ error: 'scene not in bundle', relPath });
    return;
  }

  // Prefer the Unity-batch-exported JSON when available. That format is
  // higher fidelity (real geometry + URP material props + lighting) and
  // the client has a dedicated PBR renderer for it. Fallback to the YAML
  // parser gives us an instant preview for scenes the user hasn't rebaked
  // yet, or when Unity isn't installed locally.
  const skipBaked = req.query.raw === '1';
  if (!skipBaked) {
    const bakedPath = bakedJsonPathFor(relPath);
    try {
      const stat = await fs.stat(bakedPath);
      if (stat.isFile()) {
        const buf = await fs.readFile(bakedPath, 'utf8');
        // Served as a raw JSON string (no re-parsing) because the file is
        // already a valid self-describing document and can be 10+ MB for
        // large scenes — JSON.parse + JSON.stringify would double the cost.
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Level-Source', 'unity-export');
        res.setHeader('X-Level-Baked-At', new Date(stat.mtimeMs).toISOString());
        res.end(buf);
        return;
      }
    } catch {
      // baked file doesn't exist — fall through to YAML parser below.
    }
  }

  const absPath = path.join(getAssetsDir(), relPath);
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      res.status(404).json({ error: 'not a file' });
      return;
    }
  } catch {
    res.status(404).json({ error: 'scene not found', relPath });
    return;
  }

  // If the scene file itself is still a Git LFS pointer, try to
  // materialise it synchronously — but strictly within the platform
  // proxy's upstream timeout. Going over that yields a bare 504
  // Gateway Time-out with no retry hint (the user can't even tell
  // whether the fetch is progressing), so we cap all server-side
  // waits well under the observed proxy limit.
  //
  // Observed proxy kill: ~30 s (nginx default). Previous 45 s + 20 s
  // budget let scene+mat waits stack to 65 s and reproduce 504 on
  // cold opens. New allocation, hard-capped at ~25 s total:
  //     scene LFS fetch       up to 12 s   ← was 45 s
  //     .mat/.prefab prefetch up to 10 s   ← was 20 s
  //     parseScene + JSON            ~2–3 s
  //     headroom                     ~0–3 s
  //
  // If 12 s isn't enough for the scene blob, we return 409 and let
  // the client's retry loop (MAX_ATTEMPTS=12 × 5 s = 60 s total)
  // piggy-back on the already-registered in-flight fetch. That turns
  // a "huge scene on slow LFS" case into 2–3 visible retry ticks
  // instead of a hard 504 with no feedback — which is strictly
  // better UX than the previous 45 s single-shot approach.
  const repoDir = getRepo2LocalDir();
  const SYNC_WAIT_MS = 12_000;
  try {
    const head = await fs.readFile(absPath);
    if (isLfsPointerBuf(head)) {
      console.log(
        `[lazyLfs] scene ${relPath} is a pointer — ` +
          `attempting synchronous fetch+smudge (up to ${SYNC_WAIT_MS}ms)`,
      );
      // ensureLfsFile either awaits an in-flight batch (scheduled by
      // a previous click / preload) or registers a fresh single-file
      // fetch and races it against the timeout. It never rejects.
      await ensureLfsFile(absPath, repoDir, SYNC_WAIT_MS);
      const head2 = await fs.readFile(absPath);
      if (isLfsPointerBuf(head2)) {
        // Timeout elapsed without the blob landing. Ensure a fetch is
        // still queued (in case ensureLfsFile's in-flight promise got
        // cleaned up at the timeout boundary) and hand off to the
        // client's retry loop.
        triggerLfsFetch(absPath, repoDir);
        console.log(
          `[lazyLfs] scene ${relPath} still a pointer after ${SYNC_WAIT_MS}ms — ` +
            `returning 200 'pending' for client retry`,
        );
        // We deliberately respond 200 (not 409) so platform reverse
        // proxies that count non-2xx as errors don't flag the cold-
        // open retry loop. The client reads `status:'pending'` from
        // the JSON body and replays the request after a short delay
        // — exactly the same contract as before, just on a 2xx code.
        res.status(200).json({
          status: 'pending',
          error: 'lfs-pointer',
          hint: 'Scene file is still being downloaded from Git LFS — retry shortly.',
          relPath,
        });
        return;
      }
      console.log(`[lazyLfs] scene ${relPath} smudged synchronously — serving now`);
    }
  } catch {
    // Non-fatal — parseScene below will surface a clearer error.
  }

  // Pre-parse: materialise every `.mat` / `.prefab` / `.asset` the
  // scene references that is still an LFS pointer. Without this pass,
  // the material parser reads pointer-text as YAML, silently produces
  // undefined materials, and three.js paints every surface magenta.
  //
  // Timeout budget 10 s: must fit under the platform's ~30 s proxy
  // limit AFTER the 12 s scene LFS wait above and leave room for
  // parseScene itself (2–3 s on big scenes). The LFS fetch now runs
  // on a separate chain (`scheduleLfsFetch`) that is NOT blocked by
  // a concurrent `reset --hard` from Git Sync, so blob downloads for
  // ~14 .mat files finish in 2–5 s even mid-sync. The final `git lfs
  // checkout` waits behind reset's index-lock hold, but we now invoke
  // it with explicit batch paths (see doFetchBatch) so that step is
  // sub-second rather than a full-repo scan. 10 s is plenty for the
  // common case; anything slower falls through to parseScene, which
  // will render with whatever materials landed — the remainder is
  // refilled by the client's inFlight-aware retry on the next scene
  // open since `registerBatch` keeps them queued.
  try {
    await ensureSceneYamlPointersReady(absPath, repoDir, 10_000);
  } catch {
    // Never propagate — missing materials are a cosmetic regression,
    // not a reason to 500 the whole scene request.
  }

  // Kick off a background LFS fetch for every binary asset (FBX,
  // textures) this scene references that is still a pointer. Fire
  // and forget — the JSON is returned immediately and three.js starts
  // rendering while the downloads race the browser render pipeline.
  triggerLazyLfsForScene(absPath, repoDir);

  try {
    const parsed = await parseScene(absPath, relPath);
    // Drain the material-parser's pointer counter so we get one
    // diagnostic line per scene instead of one per (materialGuid x
    // referencing node), and so the next scene's counters start
    // fresh. Log only when we actually hit any.
    const matPointerStats = consumeLfsPointerMaterialStats();
    if (matPointerStats.distinct > 0) {
      console.warn(
        `[sceneRoute] ${relPath}: ${matPointerStats.distinct} distinct ` +
          `.mat file(s) were still LFS pointers during parse ` +
          `(${matPointerStats.hits} total look-ups). ` +
          `Client will see magenta surfaces until a re-open picks up ` +
          `the now-queued blobs.`,
      );
    }
    // Tag the YAML pipeline's output with a stable format string so the
    // client can route it to the legacy renderer. The Unity batch exporter
    // puts its own `format` in the JSON root.
    res.setHeader('X-Level-Source', 'yaml-parser');
    res.json({ format: 'yaml-mvp@1', ...parsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'parse failed', message });
  }
});

// Trigger a Unity batch export for a given scene. Returns immediately with
// the in-flight status; clients poll `/rebake/status` for progress and then
// re-fetch `/levels/<relPath>` to see the updated high-fidelity render.
apiRouter.post('/rebake', async (req: Request, res: Response) => {
  // In bundle (deployed) mode we have no Unity Editor on the host and
  // the source project isn't even cloned. Fail fast with a clear 501
  // rather than leaving the client waiting on an `/rebake/status`
  // endpoint that will never resolve.
  if (bundleMode) {
    res.status(501).json({ error: 'rebake is disabled in bundle mode' });
    return;
  }
  const relPathRaw =
    (typeof req.query.relPath === 'string' && req.query.relPath) ||
    (typeof req.body?.relPath === 'string' && req.body.relPath) ||
    '';
  const relPath = path.posix.normalize(relPathRaw).replace(/^(\.\.(\/|$))+/, '');
  if (!relPath || relPath.startsWith('..') || !relPath.toLowerCase().endsWith('.unity')) {
    res.status(400).json({ error: 'invalid relPath' });
    return;
  }

  const current = getBatchStatus();
  if (current.state === 'running') {
    res.status(202).json({ queued: false, status: current });
    return;
  }

  // Fire-and-forget: the caller polls /rebake/status. We intentionally
  // don't await the full Unity run here because it can legitimately take
  // 10+ minutes on a cold Library cache, which would blow past any sane
  // HTTP timeout.
  runUnityExport({ relPath }).catch((err) => {
    console.error('[api/rebake] runUnityExport rejected:', err);
  });

  res.status(202).json({ queued: true, status: getBatchStatus() });
});

apiRouter.get('/rebake/status', (_req: Request, res: Response) => {
  res.json(getBatchStatus());
});

// Texture streamer. Query: ?guid=<32 hex>
// Supported inputs: png, jpg, jpeg, bmp, tga, webp, gif -> streamed as PNG.
// PSD/EXR and other non-standard formats are not supported in the MVP.
apiRouter.get('/assets/texture', async (req: Request, res: Response) => {
  const guidRaw = typeof req.query.guid === 'string' ? req.query.guid : '';
  const guid = guidRaw.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(guid)) {
    res.status(400).json({ error: 'bad guid' });
    return;
  }

  // Bundle mode: all texture blobs are already re-encoded to PNG at bake
  // time (cap 1024 px, compressionLevel 9). We just stream the bytes;
  // no sharp / lunapaint / ag-psd work happens in this hot path.
  if (bundleMode) {
    const blob = bundleIndex.getBlob(guid);
    const blobPath = blob ? bundleIndex.blobPath(guid) : null;
    if (!blob || !blobPath) {
      // Missing-GUID is a soft failure: many scenes reference textures
      // that didn't make it into the bundle (sliced atlases, removed
      // packs, etc.). Returning 404 made the platform proxy count it
      // as an error for every scene-open. Hand back a 1×1 transparent
      // placeholder PNG so material loaders silently fall back to flat
      // colour, and tag the response with `X-Asset-Missing:1` so any
      // diagnostic tooling can still distinguish placeholder from real.
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Asset-Missing', '1');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(PLACEHOLDER_PNG);
      return;
    }
    try {
      const buf = await fs.readFile(blobPath);
      if (isBundleLfsPointer(buf)) {
        // Surfaced as a transparent PNG placeholder — same shape the live
        // path uses — so the material falls back to flat colour without
        // a loader-level failure.
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('X-Lfs-Placeholder', '1');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.end(PLACEHOLDER_PNG);
        return;
      }
      res.setHeader('Content-Type', blob.contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'bundle blob read failed', message });
    }
    return;
  }

  const rec = assetIndex.get(guid);
  if (!rec) {
    // Soft 200 placeholder for missing-GUID — see bundle-mode rationale
    // above; same logic applies here.
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Asset-Missing', '1');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(PLACEHOLDER_PNG);
    return;
  }
  const ext = rec.ext;
  const streamable = ['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.webp', '.gif', '.psd', '.exr', '.hdr'];
  if (!streamable.includes(ext)) {
    // Unsupported source extension — also a soft failure so the
    // material loader gets a clean placeholder instead of a hard 415.
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Asset-Unsupported', ext);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(PLACEHOLDER_PNG);
    return;
  }
  try {
    let buf = await fs.readFile(rec.absPath);
    // Detect unresolved Git LFS pointers. In live mode we attempt a lazy
    // fetch first (waiting up to 45 s if the scene pre-fetch already queued
    // this file, or triggering a fresh single-file download otherwise).
    // In bundle mode (or if the per-file fetch times out / fails) we fall
    // back to the transparent placeholder PNG so the material degrades
    // gracefully to flat-colour without crashing the loader.
    if (isLfsPointerBuf(buf)) {
      if (!bundleMode) {
        // Fire-and-forget: register the file for background fetch but
        // do NOT await it here. Platform reverse-proxies often time
        // out at ~30 s and git-lfs fetches can exceed that on a cold
        // cache. Serve a placeholder now; the client refetches on
        // the next render once the blob lands.
        triggerLfsFetch(rec.absPath, getRepo2LocalDir());
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Lfs-Placeholder', '1');
      res.setHeader('Cache-Control', 'no-store');
      res.end(PLACEHOLDER_PNG);
      return;
    }
    // HDR cubemaps (Aegis BasicLit._EnvCubemap is typically a `.exr`,
    // `.hdr` is the RGBE fallback). These are passed through as raw bytes
    // so the client's EXRLoader / RGBELoader can decode them with full
    // float precision — re-encoding to PNG would clip the HDR range and
    // destroy the look. Content-Type uses the informal image/x-exr mime
    // that three.js's loader accepts; RGBE is image/vnd.radiance.
    if (ext === '.exr' || ext === '.hdr') {
      res.setHeader(
        'Content-Type',
        ext === '.exr' ? 'image/x-exr' : 'image/vnd.radiance',
      );
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(buf);
      return;
    }
    // sharp/libvips does not support TGA, so we pre-decode TGA files to raw
    // RGBA pixels via lunapaint's codec, then hand the raw buffer to sharp
    // for PNG encoding. Covers both uncompressed and RLE TGAs which are very
    // common in older Unity URP asset packs (e.g. `T_Test_Building_*.tga`).
    //
    // We also cap the streamed texture at MAX_TEXTURE_DIM on its longer edge
    // to avoid sending 4k+ source textures (common in game content) to the
    // browser — Three.js would otherwise upload 64+ MB per texture to GPU
    // memory. 1024 px is a reasonable balance for a viewer.
    const MAX_TEXTURE_DIM = 1024;
    const resizeOpts: sharp.ResizeOptions = {
      width: MAX_TEXTURE_DIM,
      height: MAX_TEXTURE_DIM,
      fit: 'inside',
      withoutEnlargement: true,
    };
    let pngBuf: Buffer;
    if (ext === '.tga') {
      const decoded = await decodeTga(buf);
      const { data, width, height } = decoded.image;
      pngBuf = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
        raw: { width, height, channels: 4 },
      })
        .resize(resizeOpts)
        .png({ compressionLevel: 9 })
        .toBuffer();
    } else if (ext === '.psd') {
      // sharp/libvips has no PSD reader. We parse the Photoshop file with
      // ag-psd and hand the composite RGBA buffer to sharp for resize+PNG
      // encoding. `skipLayerImageData: true` avoids decoding every layer —
      // we only need the merged composite that's stored at the tail of the
      // PSD as a pre-baked, pre-flattened bitmap.
      //
      // Corner cases we handle explicitly:
      //   - 16-bit / 32-bit PSDs: ag-psd returns a Uint16Array / Float32Array
      //     instead of Uint8Array. We down-convert to 8-bit RGBA because
      //     sharp's raw input only accepts uint8.
      //   - PSDs saved without a flattened composite ("Maximize
      //     Compatibility" off in Photoshop): imageData is undefined, and
      //     we'd need to re-flatten every layer. We treat this as an error
      //     with an actionable message instead of silently failing.
      //   - CMYK / grayscale / indexed: ag-psd converts to RGBA itself.
      let psd: ReturnType<typeof readPsd>;
      try {
        psd = readPsd(buf, {
          skipLayerImageData: true,
          skipThumbnail: true,
          skipCompositeImageData: false,
          useImageData: true,
          throwForMissingFeatures: false,
        });
      } catch (psdErr) {
        const msg = psdErr instanceof Error ? psdErr.message : String(psdErr);
        console.warn(`[psd] ${rec.relPath}: parse failed: ${msg}`);
        res.status(500).json({
          error: 'psd parse failed',
          message: msg,
          path: rec.relPath,
        });
        return;
      }
      const composite = psd.imageData;
      if (
        !composite ||
        !composite.data ||
        !composite.width ||
        !composite.height
      ) {
        console.warn(
          `[psd] ${rec.relPath}: no composite (w=${composite?.width} h=${composite?.height} bits=${psd.bitsPerChannel} mode=${psd.colorMode})`,
        );
        res.status(500).json({
          error: 'psd has no composite image',
          message:
            'Re-save the PSD with "Maximize Compatibility" enabled in Photoshop so it embeds a flattened bitmap.',
          path: rec.relPath,
        });
        return;
      }
      // ag-psd's data field is declared as PixelArray = Uint8ClampedArray |
      // Uint8Array | Uint16Array | Float32Array depending on bitsPerChannel.
      // Normalize to an 8-bit RGBA Buffer for sharp.
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
        res.status(500).json({
          error: 'psd unsupported pixel array',
          message: `pixel buffer type = ${Object.prototype.toString.call(raw)}`,
          path: rec.relPath,
        });
        return;
      }
      pngBuf = await sharp(rgba, {
        raw: { width: composite.width, height: composite.height, channels: 4 },
      })
        .resize(resizeOpts)
        .png({ compressionLevel: 9 })
        .toBuffer();
    } else {
      pngBuf = await sharp(buf, { failOn: 'none' })
        .resize(resizeOpts)
        .png({ compressionLevel: 9 })
        .toBuffer();
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(pngBuf);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[tex] ${rec.relPath} (${ext}) failed: ${message}`);
    res
      .status(500)
      .json({ error: 'texture read failed', message, path: rec.relPath, ext });
  }
});

// Mesh streamer. Query: ?guid=<32 hex>
// Streams the raw FBX/OBJ/ASSET asset bytes so Three.js's FBXLoader/OBJLoader
// can parse it client-side. We do NOT do any transcoding here.
apiRouter.get('/assets/mesh', async (req: Request, res: Response) => {
  const guidRaw = typeof req.query.guid === 'string' ? req.query.guid : '';
  const guid = guidRaw.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(guid)) {
    res.status(400).json({ error: 'bad guid' });
    return;
  }

  // Bundle mode: mesh blobs are stored verbatim (no transcoding), so the
  // handler is just "stat + stream + correct content-type". The manifest
  // stashes a precomputed content-type string so we don't re-derive it
  // per request.
  if (bundleMode) {
    const blob = bundleIndex.getBlob(guid);
    const blobPath = blob ? bundleIndex.blobPath(guid) : null;
    if (!blob || !blobPath) {
      // Soft 200 with a JSON `{missing:true}` sentinel — same rationale
      // as the texture handler: 404s for missing-GUID assets piled up
      // in the platform proxy's error counter even though they're a
      // benign "asset not in bundle" case. The client checks
      // Content-Type / `missing` field and falls back to an empty
      // group instead of a hard error.
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Asset-Missing', '1');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(JSON.stringify({ missing: true, reason: 'guid not in bundle', guid }));
      return;
    }
    try {
      const buf = await fs.readFile(blobPath);
      if (isBundleLfsPointer(buf)) {
        // 200 + `status:'pending'` so the platform proxy doesn't
        // count the retry loop as a non-2xx error. The client's mesh
        // poller reads the JSON body to decide whether to retry.
        res.status(200).json({
          status: 'pending',
          error: 'lfs-pointer',
          hint: 'server host did not run `git lfs pull` for data/bundle',
          relPath: blob.originalRelPath,
        });
        return;
      }
      res.setHeader('Content-Type', blob.contentType);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'bundle blob read failed', message });
    }
    return;
  }

  const rec = assetIndex.get(guid);
  if (!rec) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Asset-Missing', '1');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(JSON.stringify({ missing: true, reason: 'guid not found', guid }));
    return;
  }
  const ext = rec.ext;
  const streamable = ['.fbx', '.obj', '.asset', '.mesh'];
  if (!streamable.includes(ext)) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Asset-Unsupported', ext);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(
      JSON.stringify({ missing: true, reason: 'unsupported mesh format', ext, guid }),
    );
    return;
  }
  try {
    let buf = await fs.readFile(rec.absPath);
    if (isLfsPointerBuf(buf)) {
      if (!bundleMode) {
        // Wait synchronously for a bounded window before giving up on
        // a pointer. 85 concurrent FBX requests at scene-open land on
        // this handler nearly simultaneously; the lazyLfs coalescer
        // merges them into a single batched `git lfs fetch`, so the
        // first request blocks ~5–15 s but the remaining 84 join that
        // same in-flight promise and complete in the same window.
        // Net result: one handler trip per FBX instead of the
        // previous 6× retry loop at 2.5 s each (~15 s) that often
        // gave up before the blob had landed on disk.
        const MESH_SYNC_WAIT_MS = 20_000;
        await ensureLfsFile(rec.absPath, getRepo2LocalDir(), MESH_SYNC_WAIT_MS);
        // Re-read after the wait; the file may now be a real blob.
        buf = await fs.readFile(rec.absPath);
      }
      if (isLfsPointerBuf(buf)) {
        // Still a pointer after the sync wait — return 200 with a
        // `status:'pending'` JSON body so the platform reverse proxy
        // doesn't classify the retry loop as an error. The client's
        // fbxCache poller checks the body for `status==='pending'`
        // and keeps polling on the same in-flight LFS batch.
        triggerLfsFetch(rec.absPath, getRepo2LocalDir());
        res.status(200).json({
          status: 'pending',
          error: 'lfs-pointer',
          hint: 'LFS fetch in progress or upstream blob missing — retry shortly',
          relPath: rec.relPath,
        });
        return;
      }
    }
    const contentType =
      ext === '.fbx'
        ? 'model/fbx'
        : ext === '.obj'
          ? 'model/obj'
          : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(buf);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'mesh read failed', message });
  }
});

/**
 * Character / standalone-FBX material bundle.
 *
 * Query: `?guid=<fbx_guid>`
 * Response: `{ materials: { [embeddedMaterialName]: MaterialJson } }`
 *
 * Unity imports FBX materials via `ModelImporter.externalObjects` —
 * each embedded material NAME (e.g. `m_striker.001`) is remapped to
 * an external `.mat` GUID. Scenes that reference the FBX already get
 * this info baked into `SceneJson.fbxExternalMaterials`, but the
 * player-character loader fetches the FBX directly (there's no parent
 * scene), so it needs the same `name → MaterialJson` table on its own.
 *
 * Rather than invent a second wire format, we reuse the existing
 * `MaterialJson` shape from `SceneJson.materials` so the client can
 * feed the result straight into its `buildMaterial` function.
 *
 * Fails soft: FBXes with no external remap return `{ materials: {} }`
 * (status 200). The caller is expected to fall back to the FBX's own
 * embedded material names + default grey, not to show a load error —
 * the avatar is still useful without perfect textures.
 */
apiRouter.get('/assets/fbx-character-materials', async (req: Request, res: Response) => {
  const guidRaw = typeof req.query.guid === 'string' ? req.query.guid : '';
  const guid = guidRaw.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(guid)) {
    res.status(400).json({ error: 'bad guid' });
    return;
  }

  // Bundle mode: material packs were pre-computed at bake time and live
  // as individual JSON files under `<bundleDir>/fbx-materials/<guid>.json`.
  // We stream the file verbatim; the schema is already the shape the
  // client expects (`{ materials: { [name]: MaterialJson } }`). FBXes
  // without any external-material remap were skipped during bake, so the
  // fallback is the same soft 200 the live path returns.
  if (bundleMode) {
    if (!bundleIndex.hasFbxMaterialPack(guid)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json({ materials: {} });
      return;
    }
    try {
      const buf = await fs.readFile(bundleIndex.fbxMaterialPackPath(guid), 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'bundle material pack read failed', message });
    }
    return;
  }

  const info = await getFbxMeshInfo(guid);
  if (!info) {
    // Soft 200 + empty material map. The client treats both 404 and
    // `{materials:{}}` identically (falls back to FBX-embedded
    // materials), so returning 200 keeps the response semantics while
    // not polluting the platform proxy's error counter for FBXes that
    // simply have no `.meta` material remap.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Asset-Missing', '1');
    res.json({ materials: {} });
    return;
  }
  const out: Record<string, ReturnType<typeof toMaterialJson>> = {};
  // Parse each unique material once — many characters share e.g. a
  // single `m_striker` mat across multiple `.001` / `.002` duplicates
  // created when the FBX re-imports splits submeshes. We iterate the
  // name table (not the GUID list) so the key the client sees matches
  // what `SkinnedMesh.material[i].name` will return from FBXLoader.
  const cache = new Map<string, ReturnType<typeof toMaterialJson> | null>();
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
    }
    if (json) out[name] = json;
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ materials: out });
});

// ===========================================================================
// Feedback / Aegisgram social layer
// ===========================================================================
//
// Feedback pins + posts are a shared artifact between every viewer
// hitting the same scene: the whole point of Aegisgram is that user A
// drops a pin and user B sees it next time they walk the level.
// We keep authoritative feedback state on the server (JSON file under
// `<repoRoot>/data/feedbacks.json`) and expose a dead-simple CRUD
// surface; the client caches + polls so the viewer stays reactive
// without websockets.
//
// Security posture: this server is trusted-internal (the only network
// it's ever exposed to is the team's LAN), so we don't implement auth
// or rate-limiting yet. Shape validation at the boundary is enough to
// keep garbage payloads from corrupting the store.

/**
 * Flatten every feedback across every scene, newest-first. Powers
 * the global social feed at `/feed`. Accepts an optional `?limit=N`
 * to cap response size; default 200 — plenty for the "what did the
 * team post this week" view without streaming megabytes of thumbnails
 * on every page load.
 *
 * Placed BEFORE the `/feedbacks` route handler because Express
 * route matching is definition-order: an exact path like
 * `/feedbacks/all` must be declared ahead of any pattern that would
 * otherwise capture it. As it stands both routes use distinct paths,
 * so ordering is cosmetic — but cheap insurance for future changes.
 */
apiRouter.get('/feedbacks/all', async (req: Request, res: Response) => {
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;
  try {
    const feedbacks = await listAllFeedbacks(limit);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ feedbacks });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** List every feedback attached to a scene, newest-first. */
apiRouter.get('/feedbacks', async (req: Request, res: Response) => {
  const scenePath = typeof req.query.scenePath === 'string' ? req.query.scenePath : '';
  if (!scenePath) {
    res.status(400).json({ error: 'missing scenePath' });
    return;
  }
  try {
    const feedbacks = await listFeedbacksForScene(scenePath);
    // Feedback changes often between requests (other users posting);
    // cache-control: no-store prevents browsers from serving a stale
    // snapshot when the poller fires. Still cheap — the whole file
    // is read once on boot and held in memory.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ feedbacks });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Upsert a feedback. Idempotent on `id` so a client retry after a
 *  network blip doesn't duplicate the post. */
apiRouter.post('/feedbacks', async (req: Request, res: Response) => {
  const body = req.body as unknown;
  if (!isFeedback(body)) {
    res.status(400).json({ error: 'bad feedback payload' });
    return;
  }
  try {
    await upsertFeedbackToStore(body);
    // Fire-and-forget realtime broadcast to every client currently
    // sitting in this scene's multiplayer room — their pins, panel,
    // and global feed update instantly instead of waiting for the
    // next 15 s poll tick.
    broadcastFeedbackAdded(body);
    res.json({ ok: true, id: body.id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Toggle a like on a feedback. Body: `{ scenePath, nickname }`.
 *
 * Returns the updated record so the client can reconcile its
 * optimistic UI (e.g. it replaced the heart icon with "filled"
 * before this call finished — if the server's truth differs we'll
 * snap back to the authoritative state on response).
 *
 * Each call flips the membership of `nickname` in `likes`: adds
 * it if absent, removes it if present. There is deliberately no
 * separate "unlike" endpoint — toggling is what the UI wants.
 */
apiRouter.post('/feedbacks/:id/like', async (req: Request, res: Response) => {
  const id = req.params.id;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const scenePath = typeof body.scenePath === 'string' ? body.scenePath : '';
  const nickname = sanitizeAuthor(body.nickname);
  if (!id || !scenePath || !nickname) {
    res.status(400).json({ error: 'missing id, scenePath, or nickname' });
    return;
  }
  try {
    const updated = await toggleLikeOnStore(scenePath, id, nickname);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    broadcastFeedbackUpdated(updated);
    res.json({ ok: true, feedback: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Append a comment. Body: `{ scenePath, commentId, author, text }`.
 *
 * `commentId` is a client-supplied UUID used as an idempotency key
 * — a retry after a network hiccup resolves to the same row rather
 * than creating a duplicate. The server back-stamps `createdAt` so
 * every comment's timestamp comes from the same clock regardless of
 * which browser posted it.
 */
apiRouter.post(
  '/feedbacks/:id/comment',
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scenePath = typeof body.scenePath === 'string' ? body.scenePath : '';
    const commentId = typeof body.commentId === 'string' ? body.commentId : '';
    const author = sanitizeAuthor(body.author);
    const text = sanitizeCommentText(body.text);
    if (!id || !scenePath || !commentId || !author || !text) {
      res.status(400).json({ error: 'missing fields' });
      return;
    }
    try {
      const updated = await addCommentToStore(scenePath, id, {
        id: commentId,
        author,
        text,
        createdAt: Date.now(),
      });
      if (!updated) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      broadcastFeedbackUpdated(updated);
      res.json({ ok: true, feedback: updated });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

/**
 * Delete a comment. Path: `/feedbacks/:id/comment/:commentId?scenePath=...`.
 *
 * No auth check — this server trusts its clients. The UI guards
 * the delete button to the comment's author, which is good enough
 * for the trusted-team use case.
 */
apiRouter.delete(
  '/feedbacks/:id/comment/:commentId',
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const commentId = req.params.commentId;
    const scenePath = typeof req.query.scenePath === 'string' ? req.query.scenePath : '';
    if (!id || !commentId || !scenePath) {
      res.status(400).json({ error: 'missing id, commentId, or scenePath' });
      return;
    }
    try {
      const updated = await removeCommentFromStore(scenePath, id, commentId);
      if (!updated) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      broadcastFeedbackUpdated(updated);
      res.json({ ok: true, feedback: updated });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

/**
 * Flip a feedback's review status. Body: `{ scenePath, status, nickname }`.
 *
 * `status` must be `'open'` or `'resolved'`. Anything else is
 * rejected at the boundary — the lifecycle is intentionally small
 * and we don't want typos sneaking into the JSON file.
 *
 * Marking resolved stamps `resolvedAt` / `resolvedBy` on the record;
 * re-opening clears them. Broadcasts `feedback_updated` so every
 * viewer in the scene sees the pin change colour, the card dim,
 * and the filter counts update without waiting for the next poll.
 */
apiRouter.post(
  '/feedbacks/:id/status',
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const scenePath = typeof body.scenePath === 'string' ? body.scenePath : '';
    const rawStatus = body.status;
    const nickname = sanitizeAuthor(body.nickname);
    if (!id || !scenePath || !nickname) {
      res.status(400).json({ error: 'missing id, scenePath, or nickname' });
      return;
    }
    if (rawStatus !== 'open' && rawStatus !== 'resolved') {
      res.status(400).json({ error: 'status must be "open" or "resolved"' });
      return;
    }
    try {
      const updated = await setFeedbackStatusOnStore(
        scenePath,
        id,
        rawStatus,
        nickname,
      );
      if (!updated) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      broadcastFeedbackUpdated(updated);
      res.json({ ok: true, feedback: updated });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

/** Delete a feedback by id. Returns 404 if nothing matched — the
 *  client uses this to decide whether to show "already gone" vs
 *  "actually removed by you just now". */
apiRouter.delete('/feedbacks', async (req: Request, res: Response) => {
  const scenePath = typeof req.query.scenePath === 'string' ? req.query.scenePath : '';
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!scenePath || !id) {
    res.status(400).json({ error: 'missing scenePath or id' });
    return;
  }
  try {
    const ok = await removeFeedbackFromStore(scenePath, id);
    if (!ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    broadcastFeedbackRemoved(scenePath, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** 1x1 fully transparent PNG (67 bytes). */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// Module-level tracking of the in-flight / last Git Sync. A sync can
// legitimately take 1–5 min (pull + reset + index rebuild + LFS
// prefetch), which blows past every HTTP reverse-proxy timeout we're
// likely to sit behind (nginx defaults to 60 s, the platform proxy
// killed us at ~30 s with a 504). So we treat /api/sync as a
// fire-and-forget trigger: start the work, return immediately, and
// let the client poll /api/lfs-status to see when it's done.
interface SyncState {
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
  action?: string;
  head?: string;
  error?: string;
}
let syncState: SyncState = { running: false };

apiRouter.post('/sync', (req: Request, res: Response) => {
  // In bundle mode the server never contacts the upstream Unity repo —
  // the content is baked at build time and `git lfs pull` on deploy is
  // the only "sync" operation that matters. Reflect that explicitly.
  if (bundleMode) {
    res.status(501).json({ error: 'sync is disabled in bundle mode' });
    return;
  }
  if (syncState.running) {
    // Idempotent: don't stack concurrent syncs. The client is polling
    // status anyway so "already running" is the right answer.
    res.status(202).json({ ...syncState, queued: false });
    return;
  }

  // Optional scene scope. When the client is viewing a specific scene
  // (`/level/<relPath>`), it passes that relPath here so the post-sync
  // LFS work is narrowed to JUST that scene's dependency graph. The
  // alternative — the repo-wide `bulkFetchMaterialsAndTextures` pass —
  // downloads every .mat and image pointer in the clone, which on a
  // large Unity project runs for several minutes and is the real
  // source of "why is sync still going after 5 minutes?" complaints
  // from reviewers who only care about the one map they opened.
  //
  // pullSparse is still repo-wide (git has no "pull just one file"),
  // but that completes in seconds once there's nothing to apply — the
  // minutes-long tail was always the bulk LFS fetch, not the pull.
  const body = (req.body ?? {}) as { scenePath?: unknown };
  const scenePathRaw =
    typeof body.scenePath === 'string' && body.scenePath.length > 0
      ? body.scenePath
      : undefined;
  let scopedScenePath: string | undefined;
  if (scenePathRaw) {
    // Sanitise: same rules as the /api/levels/* handler — relative,
    // forward-slash, no traversal. Silently drop invalid input and
    // fall back to full sync rather than rejecting; we'd rather
    // complete a too-broad sync than no sync at all.
    const clean = scenePathRaw.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean.includes('..') && clean.toLowerCase().endsWith('.unity')) {
      scopedScenePath = clean;
    }
  }

  syncState = { running: true, startedAt: Date.now() };
  res.status(202).json({ ...syncState, queued: true, scopedTo: scopedScenePath });

  // Fire-and-forget. Any error is captured into syncState so the UI
  // can surface it on the next /api/lfs-status poll; never rethrown
  // past this boundary.
  (async () => {
    try {
      const result = await syncUnityRepo({ force: true });
      console.log(
        `[server] manual sync: ${result.action}${result.head ? ` @ ${result.head}` : ''}` +
          (scopedScenePath ? ` (scope: ${scopedScenePath})` : ' (scope: full)'),
      );
      await assetIndex.build();
      syncState = {
        ...syncState,
        running: false,
        finishedAt: Date.now(),
        action: result.action,
        head: result.head,
      };
      // Targeted warm-up: if the pull advanced HEAD, the gitSync layer
      // already handed us the list of files that changed. Feed them
      // straight to lazyLfs so the exact scenes a reviewer is about
      // to click land in the LFS cache before the first click hits.
      if (result.changedPaths && result.changedPaths.length > 0) {
        warmChangedPaths(getRepo2LocalDir(), result.changedPaths);
      }

      if (scopedScenePath) {
        // Scene-scoped post-sync work: materialise the scene YAML itself
        // (in case it arrived in this pull or was never smudged) and
        // queue every LFS-tracked asset it references. Everything else
        // in the repo stays lazy — reviewers explicitly said they'd
        // rather see a fast, focused "done" than a background queue
        // churning for 5+ minutes on assets they'll never look at.
        const repoDir = getRepo2LocalDir();
        const sceneAbs = path.join(repoDir, scopedScenePath);
        void (async () => {
          try {
            await ensureLfsFile(sceneAbs, repoDir, 30_000);
            triggerLazyLfsForScene(sceneAbs, repoDir);
            await ensureSceneYamlPointersReady(sceneAbs, repoDir, 15_000).catch(
              () => undefined,
            );
            console.log(
              `[server] post-sync scene warm complete: ${scopedScenePath}`,
            );
          } catch (err) {
            console.warn(
              `[server] post-sync scene warm failed for ${scopedScenePath}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
      } else {
        // Unscoped: full bulk prefetch so every .mat / image pointer
        // in the repo lands. Only kicked off when the user is on the
        // level grid (no specific scene context), where they may be
        // about to click any tile and we want all of them warm.
        bulkFetchMaterialsAndTextures(getRepo2LocalDir(), assetIndex).catch(
          (err) => {
            console.warn('[server] post-sync bulk LFS prefetch error (non-fatal):', err);
          },
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[server] manual sync failed:', message);
      syncState = {
        ...syncState,
        running: false,
        finishedAt: Date.now(),
        error: message,
      };
    }
  })();
});

/**
 * Current state of the background `.mat` + image bulk LFS prefetch
 * AND the manual Git Sync. Client polls this to render a header
 * badge ("Syncing…" / "Assets 450 / 1200") so the user understands
 * why some scenes still show magenta surfaces right after a cold
 * deploy or a Git Sync click — and can see the remaining work
 * draining in real time. Combining both pieces of state in one
 * endpoint keeps the client's polling overhead minimal.
 */
apiRouter.get('/lfs-status', (_req: Request, res: Response) => {
  if (bundleMode) {
    // In bundle mode no LFS fetch ever runs from the server; clients
    // that care about this endpoint are always live-mode clients, but
    // we still return a well-formed stub so the UI code path is
    // uniform. We still surface `health` so an ops dashboard can
    // distinguish "bundle mode, nothing to report" from "live mode,
    // everything broken".
    res.json({
      running: false,
      total: 0,
      done: 0,
      filesDone: 0,
      sync: { running: false },
      mode: 'bundle',
      health: getLfsHealth(),
    });
    return;
  }
  // Include per-process LFS runtime health so operators and the in-page
  // diagnostic panel can tell `git-lfs` installation/credential issues
  // from slow-but-working fetches without shell access to the host.
  res.json({
    ...getBulkPrefetchProgress(),
    sync: syncState,
    mode: 'live',
    health: getLfsHealth(),
  });
});
