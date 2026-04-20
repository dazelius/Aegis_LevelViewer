import path from 'node:path';
import fg from 'fast-glob';
import { config, getAssetsDir } from '../config.js';

/**
 * Broad bucket indicating where a scene lives in the Unity project.
 *
 * - `production` — scenes shipped with the game (e.g. `GameContents/Map/...`).
 *   These are the "official" levels the team signs off on.
 * - `dev-only` — scenes authored in the environment artists' sandbox
 *   (`DevAssets(not packed)/_DevArt/...`). Not part of the shipping build,
 *   so we flag them so that reviewers can tell at a glance which scenes
 *   are production-ready versus work-in-progress.
 */
export type SceneCategory = 'production' | 'dev-only';

export interface SceneInfo {
  /** Scene file name without extension, e.g. "MainLevel" */
  name: string;
  /** Absolute filesystem path to the .unity file */
  absPath: string;
  /** Path relative to Unity Assets root, with forward slashes */
  relPath: string;
  /** Classification derived from the relPath (see SceneCategory). */
  category: SceneCategory;
}

/**
 * Normalize a subpath into a forward-slashed, trimmed, leading/trailing-slash-
 * free string. Empty string means "no filter".
 */
function normalizeSubpath(s: string): string {
  return s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
}

/**
 * Parse `config.sceneSubpath` (comma-separated) into the list of subpaths
 * the scanner should walk. Empty string / no entries → `['']` which scans
 * the entire `Assets/` tree.
 */
function parseSceneSubpaths(raw: string): string[] {
  const parts = raw.split(',').map(normalizeSubpath).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [''];
}

export async function listScenes(assetsRoot: string = getAssetsDir()): Promise<SceneInfo[]> {
  const root = path.resolve(assetsRoot);
  const subpaths = parseSceneSubpaths(config.sceneSubpath);

  // Glob each subpath by ROOTING fast-glob at that directory rather than
  // embedding the subpath in the pattern itself. Folder names in this
  // repo include glob metacharacters (`DevAssets(not packed)/...`), and
  // fast-glob interprets `(not packed)` as an extglob alternation which
  // silently matches nothing. Using `cwd = <absolute-subpath>` sidesteps
  // the whole class of escaping bugs — the pattern is just a literal
  // `**/*.unity` against a fixed directory.
  const allFiles = new Set<string>();
  for (const sp of subpaths) {
    const subRoot = sp ? path.join(root, sp) : root;
    let files: string[] = [];
    try {
      files = await fg('**/*.unity', {
        cwd: subRoot,
        absolute: true,
        onlyFiles: true,
        followSymbolicLinks: false,
      });
    } catch {
      continue;
    }
    for (const f of files) allFiles.add(f);
  }

  const scenes: SceneInfo[] = Array.from(allFiles).map((abs) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    return {
      name: path.basename(abs, '.unity'),
      absPath: abs,
      relPath: rel,
      category: categorizeScene(rel),
    };
  });

  scenes.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return scenes;
}

/**
 * Derive the scene's category from its path relative to `Assets/`.
 *
 * Heuristic: any scene whose path contains `_DevArt` or that lives under
 * `DevAssets(not packed)` is a sandbox/work-in-progress scene. Everything
 * else — realistically scenes under `GameContents/...` — is treated as
 * production. The substrings are matched case-insensitively because team
 * conventions around `DevAssets` vs `devassets` are not enforced.
 */
function categorizeScene(rel: string): SceneCategory {
  const lower = rel.toLowerCase();
  if (lower.includes('_devart') || lower.includes('devassets')) {
    return 'dev-only';
  }
  return 'production';
}
