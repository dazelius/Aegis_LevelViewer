import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { SceneCategory } from '../unity/sceneScanner.js';

/**
 * Schema of `data/bundle/manifest.json`. Produced by `scripts/bake-bundle.ts`
 * and consumed exclusively by the server when running in bundle mode (i.e.
 * a production / platform deploy where we don't want to contact GitLab or
 * re-run Unity at runtime).
 *
 * Forward compatibility: the server treats unknown fields as opaque pass-
 * through, so adding new keys to the bake script doesn't require a server
 * update. Breaking changes bump `version` and a startup assertion warns /
 * fails loud rather than silently misbehaving.
 */
export interface BundleManifest {
  version: 1;
  bakedAt: string;
  gitHead?: string;
  scenes: BundleSceneEntry[];
  /**
   * Maps a 32-char lowercase GUID to the bundled blob that holds that
   * asset's binary bytes. `ext` is the ORIGINAL file extension (e.g.
   * `.tga`, `.fbx`, `.psd`); texture blobs are re-encoded to PNG at bake
   * time but we preserve the original ext for debugging / introspection.
   * `blobExt` is the on-disk extension (post-bake) — `.png` for textures,
   * identical to `ext` for meshes.
   */
  guidToBlob: Record<string, BundleBlobEntry>;
  /**
   * FBX GUIDs for which a pre-computed external-material pack was written
   * to `fbx-materials/<guid>.json`. The client's
   * `/api/assets/fbx-character-materials` endpoint reads these directly.
   */
  fbxMaterialPacks: string[];
}

export interface BundleSceneEntry {
  name: string;
  relPath: string;
  category: SceneCategory;
}

export interface BundleBlobEntry {
  /** Original source file extension (lowercased, with leading dot). */
  ext: string;
  /** On-disk extension inside `data/bundle/blobs/` (may be `.png` for
   *  textures that were re-encoded from e.g. `.tga` / `.psd`). */
  blobExt: string;
  /** Original source root + path, kept for debugging only. */
  originalRelPath: string;
  /** Precomputed content-type string to avoid a second lookup in the
   *  serving path. */
  contentType: string;
}

const LFS_POINTER_HEAD = 'version https://git-lfs.github.com/spec/';

/**
 * In-memory view of the bundle. Loaded once at startup when `bundleMode`
 * is true. All lookups are O(1) against the in-memory manifest; on-disk
 * access is limited to streaming the blob bytes themselves.
 */
class BundleIndex {
  private manifest: BundleManifest | null = null;
  private sceneByRelPath = new Map<string, BundleSceneEntry>();

  /**
   * Read `<bundleDir>/manifest.json` and populate in-memory maps.
   * Throws (fatal) if:
   *   - the file is missing (caller is expected to only call in bundle mode)
   *   - the file is an unresolved Git LFS pointer (bake artifact wasn't
   *     pulled by the deploy host — `git lfs pull` is missing from the
   *     platform's build steps)
   *   - JSON is malformed / schema version mismatched
   * We fail loud rather than fall back to zero-asset serving because a
   * silent "empty level list" would look like a feature, not a bug.
   */
  async load(): Promise<void> {
    const manifestPath = path.join(config.bundleDir, 'manifest.json');
    const raw = await fs.readFile(manifestPath, 'utf8');

    if (raw.startsWith(LFS_POINTER_HEAD)) {
      throw new Error(
        `[bundleIndex] manifest.json is an unresolved Git LFS pointer at ${manifestPath}. ` +
          `Run \`git lfs install && git lfs pull\` (or configure the platform build step to do so) ` +
          `before starting the server.`,
      );
    }

    let parsed: BundleManifest;
    try {
      parsed = JSON.parse(raw) as BundleManifest;
    } catch (err) {
      throw new Error(
        `[bundleIndex] malformed manifest.json at ${manifestPath}: ${(err as Error).message}`,
      );
    }

    if (parsed.version !== 1) {
      throw new Error(
        `[bundleIndex] unsupported manifest version ${parsed.version} — server expects version 1. ` +
          `Re-run \`npm run bake\` to regenerate the bundle.`,
      );
    }

    this.manifest = parsed;
    this.sceneByRelPath.clear();
    for (const scene of parsed.scenes) {
      this.sceneByRelPath.set(scene.relPath, scene);
    }

    // Sample-probe the actual blobs for LFS-pointer leakage.
    //
    // Manifest is small (<1 MB) and some LFS configs (e.g. Vercel builds
    // without LFS) silently let small files through as pointers anyway;
    // conversely, big binary blobs are exactly what misses when the
    // deploy step omits `git lfs pull`. Probing just the manifest above
    // would have a false-negative rate of "basically always".
    //
    // We read the first 128 bytes of up to 3 blobs (the first scene JSON,
    // the first binary blob, the first FBX material pack) and fail fast
    // with an actionable message. `openFile + read 128 + close` is
    // trivially cheap — <10 ms total even on slow disk — so we do it
    // unconditionally on startup.
    await this.probeForLfsPointers();

    console.log(
      `[bundleIndex] loaded: ${parsed.scenes.length} scenes, ` +
        `${Object.keys(parsed.guidToBlob).length} blobs, ` +
        `${parsed.fbxMaterialPacks.length} fbx-material packs ` +
        `(baked ${parsed.bakedAt}${parsed.gitHead ? ` @ ${parsed.gitHead}` : ''})`,
    );
  }

  /**
   * Probe representative files inside the bundle for Git LFS pointer
   * leakage. Throws with a clear "run `git lfs pull`" message on the
   * first pointer found. Silent success on empty bundles (e.g. fresh
   * install before a bake has ever run — that's an operator error
   * surfaced elsewhere).
   */
  private async probeForLfsPointers(): Promise<void> {
    if (!this.manifest) return;
    const probes: string[] = [];
    if (this.manifest.scenes[0]) {
      probes.push(this.sceneJsonPath(this.manifest.scenes[0].relPath));
    }
    const firstBlobGuid = Object.keys(this.manifest.guidToBlob)[0];
    if (firstBlobGuid) {
      const p = this.blobPath(firstBlobGuid);
      if (p) probes.push(p);
    }
    const firstFbxPack = this.manifest.fbxMaterialPacks[0];
    if (firstFbxPack) {
      probes.push(this.fbxMaterialPackPath(firstFbxPack));
    }
    for (const p of probes) {
      try {
        const fh = await fs.open(p, 'r');
        try {
          const buf = Buffer.alloc(128);
          const { bytesRead } = await fh.read(buf, 0, 128, 0);
          if (isBundleLfsPointer(buf.subarray(0, bytesRead))) {
            throw new Error(
              `[bundleIndex] bundle file ${p} is an unresolved Git LFS pointer. ` +
                `The deploy host did not run \`git lfs pull\` — run it (or configure ` +
                `the platform build step to do so) before starting the server.`,
            );
          }
        } finally {
          await fh.close();
        }
      } catch (err) {
        // fs errors (missing file) are handled by individual route handlers
        // returning 404 later; only rethrow the LFS-specific error here.
        if (err instanceof Error && err.message.includes('unresolved Git LFS pointer')) {
          throw err;
        }
      }
    }
  }

  isLoaded(): boolean {
    return this.manifest !== null;
  }

  listScenes(): BundleSceneEntry[] {
    if (!this.manifest) return [];
    return this.manifest.scenes.slice();
  }

  getScene(relPath: string): BundleSceneEntry | undefined {
    return this.sceneByRelPath.get(relPath);
  }

  /**
   * Absolute path to the baked scene JSON for `relPath`. The file may or
   * may not exist — callers should `fs.stat` before reading. We build the
   * path by convention rather than storing it in the manifest to keep the
   * manifest compact (one entry per scene is redundant if the layout is
   * fixed).
   */
  sceneJsonPath(relPath: string): string {
    const normalized = relPath.replace(/\\/g, '/').replace(/\.unity$/i, '');
    return path.join(config.bundleDir, 'scenes', normalized + '.json');
  }

  getBlob(guid: string): BundleBlobEntry | undefined {
    if (!this.manifest) return undefined;
    return this.manifest.guidToBlob[guid.toLowerCase()];
  }

  /** Absolute path to the on-disk blob for `guid`, or undefined if absent. */
  blobPath(guid: string): string | undefined {
    const entry = this.getBlob(guid);
    if (!entry) return undefined;
    return path.join(config.bundleDir, 'blobs', `${guid.toLowerCase()}${entry.blobExt}`);
  }

  hasFbxMaterialPack(guid: string): boolean {
    if (!this.manifest) return false;
    return this.manifest.fbxMaterialPacks.includes(guid.toLowerCase());
  }

  /** Absolute path to the FBX external-materials pack for `guid`. */
  fbxMaterialPackPath(guid: string): string {
    return path.join(config.bundleDir, 'fbx-materials', `${guid.toLowerCase()}.json`);
  }

}

export const bundleIndex = new BundleIndex();

/**
 * Quick self-check for Git LFS pointer files masquerading as real blobs.
 * Called by the texture/mesh routes before streaming so we can return a
 * friendly placeholder/503 instead of a confusing decode error downstream.
 * Reads only the first 64 bytes to stay cheap on hot paths.
 */
export function isBundleLfsPointer(head: Buffer): boolean {
  if (head.length > 1024) return false;
  return head.slice(0, 64).toString('utf8').startsWith(LFS_POINTER_HEAD);
}
