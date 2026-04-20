import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';
import {
  config,
  getAuthenticatedRepoUrl,
  getRepo2LocalDir,
  getSparsePaths,
} from '../config.js';

export interface SyncResult {
  action: 'cloned' | 'pulled' | 'skipped';
  localDir: string;
  head?: string;
  message?: string;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

async function cloneSparse(targetDir: string): Promise<void> {
  const parent = path.dirname(targetDir);
  ensureDir(parent);

  const url = getAuthenticatedRepoUrl();
  const folderName = path.basename(targetDir);
  const branch = config.gitBranch;
  const sparsePaths = getSparsePaths();

  // Skip LFS smudge on checkout so the clone is fast. We fetch LFS on demand
  // afterwards via fetchLfsAssets().
  const lfsEnv = { GIT_LFS_SKIP_SMUDGE: '1' } as Record<string, string>;

  const git = simpleGit(parent).env(lfsEnv);
  await git.clone(url, folderName, [
    '-c',
    'core.longpaths=true',
    '--filter=blob:none',
    '--no-checkout',
    '--depth',
    '1',
    '--branch',
    branch,
    '--single-branch',
  ]);

  // Make the long-paths setting persistent on the local clone.
  const inner: SimpleGit = simpleGit(targetDir).env(lfsEnv);
  await inner.raw(['config', 'core.longpaths', 'true']);
  await inner.raw(['sparse-checkout', 'init', '--no-cone']);
  await inner.raw(['sparse-checkout', 'set', ...sparsePaths]);
  await inner.raw(['checkout', branch]);

  await fetchLfsAssets(targetDir);
}

/**
 * Fetch the LFS blobs we actually need. Project Aegis tracks .unity / .mat /
 * .prefab / .asset / .controller / .anim via LFS, so without this the scene
 * files we checked out remain as 130-byte pointer files and parsing yields
 * zero GameObjects.
 *
 * When `gitFetchLfs` is enabled we do a full `lfs pull` which also includes
 * textures and other binary blobs.
 */
async function fetchLfsAssets(targetDir: string): Promise<void> {
  try {
    if (config.gitFetchLfs) {
      console.log('[gitSync] lfs pull (full)...');
      await simpleGit(targetDir).raw(['lfs', 'pull']);
      return;
    }
    // Text-based Unity YAML assets needed for scene parsing.
    const include = '*.unity,*.mat,*.prefab,*.asset,*.controller,*.anim,*.physicMaterial';
    console.log(`[gitSync] lfs pull --include="${include}"`);
    await simpleGit(targetDir).raw(['lfs', 'pull', '--include', include]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[gitSync] lfs pull failed (non-fatal): ${msg}`);
  }
}

async function pullSparse(targetDir: string): Promise<void> {
  const lfsEnv = { GIT_LFS_SKIP_SMUDGE: '1' } as Record<string, string>;
  const inner = simpleGit(targetDir).env(lfsEnv);
  const branch = config.gitBranch;
  const sparsePaths = getSparsePaths();

  // Idempotent local config so subsequent raw checkouts don't hit MAX_PATH.
  try {
    await inner.raw(['config', 'core.longpaths', 'true']);
  } catch {
    // ignore
  }

  try {
    await inner.raw(['sparse-checkout', 'set', ...sparsePaths]);
  } catch {
    // Non-fatal; repo may not have sparse-checkout enabled for some reason.
  }

  // Fetch the branch (creating/updating the remote ref), then hard-reset.
  // This avoids all "unrelated histories" / "merge" semantics and gives us a
  // deterministic checkout of origin/<branch>.
  try {
    await inner.fetch(['--depth', '1', 'origin', `${branch}:refs/remotes/origin/${branch}`]);
  } catch {
    // Non-fatal; retry without refspec (covers case where remote ref exists).
    try {
      await inner.fetch(['--depth', '1', 'origin', branch]);
    } catch {
      // ignore, the reset below may still succeed against a locally cached ref
    }
  }
  await inner.raw(['reset', '--hard', `origin/${branch}`]);

  await fetchLfsAssets(targetDir);
}

/**
 * Clone (if needed) or pull the Unity repo with sparse checkout on Assets/ and ProjectSettings/.
 */
export async function syncUnityRepo(opts: { force?: boolean } = {}): Promise<SyncResult> {
  const localDir = getRepo2LocalDir();

  if (!fs.existsSync(localDir) || !isGitRepo(localDir)) {
    console.log(`[gitSync] Cloning ${config.gitlabRepo2Url} -> ${localDir}`);
    try {
      await cloneSparse(localDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[gitSync] Clone failed:', message);
      return { action: 'skipped', localDir, message: `clone failed: ${message}` };
    }
    const head = await headShort(localDir);
    return { action: 'cloned', localDir, head };
  }

  if (!opts.force && !config.autoSyncOnStart) {
    return { action: 'skipped', localDir, message: 'auto-sync disabled' };
  }

  try {
    console.log(`[gitSync] Pulling ${localDir}`);
    await pullSparse(localDir);
    const head = await headShort(localDir);
    return { action: 'pulled', localDir, head };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[gitSync] Pull failed:', message);
    return { action: 'skipped', localDir, message: `pull failed: ${message}` };
  }
}

async function headShort(dir: string): Promise<string | undefined> {
  try {
    const out = await simpleGit(dir).revparse(['--short', 'HEAD']);
    return out.trim();
  } catch {
    return undefined;
  }
}
