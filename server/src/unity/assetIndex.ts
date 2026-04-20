import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { getAssetsDir, getUnityAssetRoots } from '../config.js';

export interface AssetRecord {
  guid: string;
  /** absolute path to the actual asset (without the .meta suffix) */
  absPath: string;
  /**
   * Path relative to the Unity project root, prefixed by the originating
   * root name (e.g. `Assets/Foo/bar.png`, `Packages/com.example/baz.prefab`,
   * `Library/PackageCache/com.unity.urp@.../Lit.mat`).
   *
   * The prefix preserves which namespace the asset came from — important
   * because `Assets/` and `Library/PackageCache/` occasionally contain files
   * with identical tail paths.
   */
  relPath: string;
  /** lowercased file extension, e.g. ".png" or ".mat" or ".unity" */
  ext: string;
  /** Short label of the root this record was discovered under. */
  source: 'Assets' | 'Packages' | 'Library/PackageCache';
}

/**
 * In-memory index of Unity assets, keyed by GUID.
 *
 * Unity scenes reference external assets (textures, materials, meshes, prefabs)
 * by a 32-char GUID which lives in the sibling `<asset>.meta` file. We scan
 * every `.meta` file under the Unity project's three canonical asset roots
 * (Assets, Packages, Library/PackageCache) once at startup and store a reverse
 * map. This matches how the Unity editor itself resolves GUIDs — scenes
 * routinely reference defaults like URP's `Lit.mat` that live under
 * `Library/PackageCache/com.unity.render-pipelines.universal@.../Runtime/Materials/Lit.mat`.
 */
class AssetIndex {
  private byGuid = new Map<string, AssetRecord>();
  private rootsAbs: { name: AssetRecord['source']; absPath: string }[] = [];
  private built = false;

  /**
   * Scan every configured root for `.meta` files. If `assetsRoot` is passed
   * explicitly (test harness / bespoke layout), only that single path is
   * scanned under the `Assets` label — preserves the previous single-root
   * behaviour for callers that still use the old signature.
   */
  async build(assetsRoot?: string): Promise<void> {
    const roots =
      assetsRoot === undefined
        ? getUnityAssetRoots()
        : [{ name: 'Assets' as const, absPath: path.resolve(assetsRoot) }];

    this.rootsAbs = [];
    this.byGuid.clear();

    type QueueEntry = { metaPath: string; root: (typeof roots)[number] };
    const allFiles: QueueEntry[] = [];

    for (const root of roots) {
      const absRoot = path.resolve(root.absPath);
      let exists = false;
      try {
        const st = await fs.stat(absRoot);
        exists = st.isDirectory();
      } catch {
        exists = false;
      }
      if (!exists) {
        // Packages/ and Library/PackageCache/ are optional — a fresh clone
        // without Unity having ever opened the project won't have the cache.
        console.log(`[assetIndex] skipping missing root: ${root.name}`);
        continue;
      }
      this.rootsAbs.push({ name: root.name as AssetRecord['source'], absPath: absRoot });

      let metaFiles: string[] = [];
      try {
        metaFiles = await fg('**/*.meta', {
          cwd: absRoot,
          absolute: true,
          dot: false,
          onlyFiles: true,
          followSymbolicLinks: false,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[assetIndex] scan failed at ${absRoot}: ${msg}`);
        continue;
      }
      for (const metaPath of metaFiles) {
        allFiles.push({
          metaPath,
          root: { name: root.name as AssetRecord['source'], absPath: absRoot },
        });
      }
    }

    // Match guid: <32 hex> at the start of a line. Using a per-file new RegExp
    // to keep lastIndex state isolated; match on \r?\n tolerant text.
    const GUID_RE = /^guid:\s*([0-9a-fA-F]{32})/m;

    // Concurrency-limited scan. Opening ~40k files at once exhausts Windows
    // file handles silently and drops ~half the index.
    const CONCURRENCY = 32;
    let cursor = 0;

    const processOne = async (entry: QueueEntry): Promise<AssetRecord | null> => {
      try {
        const head = await fs.readFile(entry.metaPath, { encoding: 'utf8' });
        const m = GUID_RE.exec(head);
        if (!m) return null;
        const guid = m[1].toLowerCase();

        const absPath = entry.metaPath.slice(0, -'.meta'.length);
        const rootRel = path
          .relative(entry.root.absPath, absPath)
          .split(path.sep)
          .join('/');
        const relPath = `${entry.root.name}/${rootRel}`;
        const ext = path.extname(absPath).toLowerCase();
        return { guid, absPath, relPath, ext, source: entry.root.name };
      } catch {
        return null;
      }
    };

    const perRootCounts: Record<string, number> = {};

    const worker = async (): Promise<void> => {
      while (true) {
        const i = cursor++;
        if (i >= allFiles.length) return;
        const rec = await processOne(allFiles[i]);
        if (!rec) continue;
        // First-writer wins — if an identical GUID appears in two roots
        // (shouldn't happen in practice; Unity enforces uniqueness), we keep
        // whichever we hit first. The scan order iterates Assets → Packages
        // → PackageCache, matching how Unity itself resolves conflicts.
        if (!this.byGuid.has(rec.guid)) {
          this.byGuid.set(rec.guid, rec);
          perRootCounts[rec.source] = (perRootCounts[rec.source] ?? 0) + 1;
        }
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i += 1) workers.push(worker());
    await Promise.all(workers);
    this.built = true;

    const breakdown = Object.entries(perRootCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    console.log(
      `[assetIndex] built: ${this.byGuid.size} guids from ${allFiles.length} .meta files (${breakdown})`,
    );
  }

  isBuilt(): boolean {
    return this.built;
  }

  size(): number {
    return this.byGuid.size;
  }

  get(guid: string): AssetRecord | undefined {
    if (!guid) return undefined;
    return this.byGuid.get(guid.toLowerCase());
  }

  /**
   * Enumerate every asset with the given extension. The extension must be
   * lowercased and include the leading dot (e.g. `".mat"`, `".prefab"`).
   * Order is insertion order (Assets → Packages → PackageCache). Returns a
   * fresh array; callers can mutate without affecting the index.
   */
  allByExt(ext: string): AssetRecord[] {
    const target = ext.toLowerCase();
    const out: AssetRecord[] = [];
    for (const rec of this.byGuid.values()) {
      if (rec.ext === target) out.push(rec);
    }
    return out;
  }

  /**
   * Returns the original Assets root, preserved for backwards compatibility
   * with any caller (tests, server endpoints) that expected a single root.
   */
  getAssetsRoot(): string {
    const assetsRoot = this.rootsAbs.find((r) => r.name === 'Assets');
    return assetsRoot?.absPath ?? path.resolve(getAssetsDir());
  }
}

export const assetIndex = new AssetIndex();
