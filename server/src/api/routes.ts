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
import { parseScene } from '../unity/sceneParser.js';
import { assetIndex } from '../unity/assetIndex.js';
import { syncUnityRepo } from '../git/gitSync.js';
import { getAssetsDir } from '../config.js';
import {
  bakedJsonPathFor,
  getBatchStatus,
  runUnityExport,
} from '../unity/batchRunner.js';

export const apiRouter: Router = Router();

apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    assetsDir: getAssetsDir(),
    assetIndexBuilt: assetIndex.isBuilt(),
    indexedAssets: assetIndex.size(),
  });
});

apiRouter.get('/levels', async (_req: Request, res: Response) => {
  try {
    const scenes = await listScenes();
    res.json(
      scenes.map((s) => ({ name: s.name, relPath: s.relPath, category: s.category })),
    );
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
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

  try {
    const parsed = await parseScene(absPath, relPath);
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
  const rec = assetIndex.get(guid);
  if (!rec) {
    res.status(404).json({ error: 'guid not found' });
    return;
  }
  const ext = rec.ext;
  const streamable = ['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.webp', '.gif', '.psd'];
  if (!streamable.includes(ext)) {
    res.status(415).json({ error: 'unsupported texture format', ext });
    return;
  }
  try {
    const buf = await fs.readFile(rec.absPath);
    // Detect unresolved Git LFS pointers. Instead of a 404 (which produces
    // noisy console errors and, worse, can crash older TextureLoader-based
    // client code), serve a small transparent placeholder PNG with 200 OK so
    // the material falls back to flat-color without any fetch failure.
    if (isLfsPointer(buf)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Lfs-Placeholder', '1');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.end(PLACEHOLDER_PNG);
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

function isLfsPointer(buf: Buffer): boolean {
  if (buf.length > 1024) return false;
  const head = buf.slice(0, 64).toString('utf8');
  return head.startsWith('version https://git-lfs.github.com/spec/');
}

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
  const rec = assetIndex.get(guid);
  if (!rec) {
    res.status(404).json({ error: 'guid not found' });
    return;
  }
  const ext = rec.ext;
  const streamable = ['.fbx', '.obj', '.asset', '.mesh'];
  if (!streamable.includes(ext)) {
    res.status(415).json({ error: 'unsupported mesh format', ext });
    return;
  }
  try {
    const buf = await fs.readFile(rec.absPath);
    if (isLfsPointer(buf)) {
      // The FBX hasn't been pulled via Git LFS. Tell the client explicitly so
      // it can show a placeholder box instead of trying to parse a 130-byte
      // text file as FBX (which would throw a cryptic loader error).
      res.status(409).json({
        error: 'lfs-pointer',
        hint: 'set LEVEL_VIEWER_GIT_FETCH_LFS=true and re-sync (/api/sync)',
        relPath: rec.relPath,
      });
      return;
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

/** 1x1 fully transparent PNG (67 bytes). */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

apiRouter.post('/sync', async (_req: Request, res: Response) => {
  try {
    const result = await syncUnityRepo({ force: true });
    // Rebuild index after pull.
    await assetIndex.build();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
