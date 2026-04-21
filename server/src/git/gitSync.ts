import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';
import {
  config,
  getAuthenticatedRepoUrl,
  getRepo2LocalDir,
  getSparsePaths,
} from '../config.js';

/**
 * Pipe a git subprocess's stdout+stderr to our own stdout with a `[git]`
 * prefix. Without this, simple-git's `.clone()` and `.raw()` swallow
 * everything the git CLI prints, so a silent hang on a credential prompt
 * or a fatal error from the remote is indistinguishable from "still
 * cloning" in the caller's logs. Everything goes to STDOUT deliberately
 * — platform log viewers frequently show only stdout, and git's
 * progress output on stderr is informational, not error-level.
 *
 * simple-git's public `outputHandler` types are ambiguous across
 * versions (some typed against Node `Readable`, others against the
 * DOM `ReadableStream`). At runtime the streams are always Node
 * Readables and expose `.on('data', ...)`, so we cast to `unknown`
 * then to our expected shape to stay compatible with the installed
 * version regardless of which `.d.ts` it shipped.
 */
interface NodeLikeReadable {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}
type GitOutputHandler = (
  command: string,
  stdout: NodeLikeReadable,
  stderr: NodeLikeReadable,
  args: string[],
) => void;

function attachGitStreamLogger(git: SimpleGit): void {
  const handler: GitOutputHandler = (_command, stdout, stderr) => {
    const relay = (label: string) => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        process.stdout.write(`[git ${label}] ${line}\n`);
      }
    };
    stdout.on('data', relay('out'));
    stderr.on('data', relay('err'));
  };
  (git as unknown as {
    outputHandler: (h: GitOutputHandler) => SimpleGit;
  }).outputHandler(handler);
}

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

  // Disable the credential helper and terminal prompt so a missing
  // token surfaces as an immediate authentication failure instead of
  // a silent hang on a non-interactive host. `GIT_TERMINAL_PROMPT=0`
  // makes git fail fast with "could not read Username", which is
  // clearly visible through our outputHandler below.
  const git = simpleGit(parent).env({
    ...lfsEnv,
    GIT_TERMINAL_PROMPT: '0',
  } as Record<string, string>);
  attachGitStreamLogger(git);
  await git.clone(url, folderName, [
    '-c',
    'core.longpaths=true',
    '-c',
    'credential.helper=',
    '--progress',
    '--filter=blob:none',
    '--no-checkout',
    '--depth',
    '1',
    '--branch',
    branch,
    '--single-branch',
  ]);

  // Make the long-paths setting persistent on the local clone.
  const inner: SimpleGit = simpleGit(targetDir).env({
    ...lfsEnv,
    GIT_TERMINAL_PROMPT: '0',
  } as Record<string, string>);
  attachGitStreamLogger(inner);
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
    const lfsGit = simpleGit(targetDir).env({
      GIT_TERMINAL_PROMPT: '0',
    } as Record<string, string>);
    attachGitStreamLogger(lfsGit);
    if (config.gitFetchLfs) {
      console.log('[gitSync] lfs pull (full)...');
      await lfsGit.raw(['lfs', 'pull']);
      return;
    }
    // Text-based Unity YAML assets needed for scene parsing.
    const include = '*.unity,*.mat,*.prefab,*.asset,*.controller,*.anim,*.physicMaterial';
    console.log(`[gitSync] lfs pull --include="${include}"`);
    await lfsGit.raw(['lfs', 'pull', '--include', include]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[gitSync] lfs pull failed (non-fatal): ${msg}`);
  }
}

async function pullSparse(targetDir: string): Promise<void> {
  const lfsEnv = {
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_TERMINAL_PROMPT: '0',
  } as Record<string, string>;
  const inner = simpleGit(targetDir).env(lfsEnv);
  attachGitStreamLogger(inner);
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
    // URL in the log intentionally omits embedded credentials to avoid
    // leaking tokens into platform log stores.
    const safeUrl = redactUrl(config.gitlabRepo2Url);
    console.log(`[gitSync] Cloning ${safeUrl} -> ${localDir}`);
    try {
      await cloneSparse(localDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Use console.log (not error) — some platform log viewers show
      // stdout only, and this failure is the single most actionable
      // line a deploy operator needs to see.
      console.log(`[gitSync] Clone failed: ${message}`);
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

function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return raw;
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
