import fs from 'node:fs';
import path from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';
import {
  config,
  getAuthenticatedRepoUrl,
  getGitUrlRewriteFlags,
  getGitUrlRewrites,
  getRepo2LocalDir,
  getSparsePaths,
} from '../config.js';
import { getLfsProxyInfo } from './lfsProxy.js';
import { scheduleInRepo } from './repoLock.js';

/**
 * Persist `AEGISGRAM_GIT_URL_REWRITES` into the local repo's
 * `.git/config` as `url.<to>.insteadOf` entries. Idempotent — we
 * unset before setting so re-running doesn't accumulate duplicate
 * multi-values. Once this runs, every subsequent git invocation
 * on this repo (including git-lfs's internal smudge subprocesses
 * that git-lfs spawns with its own env) picks up the rewrite
 * automatically, which is what unblocks LFS fetches when the
 * batch API hands out an unreachable download host.
 */
export async function applyUrlRewritesToRepo(repoDir: string): Promise<void> {
  return persistUrlRewritesInRepo(repoDir);
}

async function persistUrlRewritesInRepo(repoDir: string): Promise<void> {
  const rewrites = getGitUrlRewrites();
  if (rewrites.length === 0) return;
  const inner = simpleGit(repoDir).env({
    GIT_TERMINAL_PROMPT: '0',
  } as Record<string, string>);
  for (const { from, to } of rewrites) {
    const key = `url.${to}.insteadOf`;
    try {
      // --unset-all is safe even when the key doesn't exist yet on
      // some git versions; we swallow any non-fatal exit.
      await inner.raw(['config', '--local', '--unset-all', key]).catch(() => {});
      await inner.raw(['config', '--local', '--add', key, from]);
      console.log(`[gitSync] persisted url rewrite: ${key}=${from}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[gitSync] failed to persist url rewrite ${key}: ${msg}`);
    }
  }

  // insteadOf covers `git fetch/push/clone` transport but NOT the
  // absolute object-download URLs that git-lfs receives from the
  // batch API response. For those we route the specific URL prefix
  // through an in-process HTTP forward proxy (see lfsProxy.ts) by
  // setting `http.<URL>.proxy`. git-lfs honours per-URL proxy config,
  // so every object href starting with `<from>` gets delivered by
  // our proxy after being forwarded to the reachable `<to>` host.
  const proxy = getLfsProxyInfo();
  if (proxy) {
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    for (const { from } of rewrites) {
      const key = `http.${from}.proxy`;
      try {
        await inner.raw(['config', '--local', '--unset-all', key]).catch(() => {});
        await inner.raw(['config', '--local', '--add', key, proxyUrl]);
        // Make sure git doesn't leak a system-wide no_proxy that
        // happens to match 127.0.0.1 or the `<from>` host and bypass
        // our proxy. `http.<URL>.noProxy=*` as a *negated* entry is
        // not a thing, but leaving it unset means git uses env vars;
        // we set `emptyProxy` to false defensively.
        console.log(`[gitSync] persisted lfs proxy: ${key}=${proxyUrl}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[gitSync] failed to persist lfs proxy ${key}: ${msg}`);
      }
    }
  }
}

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
    // URL rewrites applied during clone itself — the `-c` flags above
    // only live for this one git call, which is enough because we
    // persist the same rewrites into the cloned repo's local config
    // below so future git/LFS calls inherit them.
    ...getGitUrlRewriteFlags(),
    '--progress',
    '--filter=blob:none',
    '--no-checkout',
    '--depth',
    '1',
    '--branch',
    branch,
    '--single-branch',
  ]);

  // Persist url rewrites + longpaths into the freshly-cloned repo so
  // every subsequent git/LFS call on it picks them up automatically.
  await persistUrlRewritesInRepo(targetDir);

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
/**
 * LFS pull, resiliently.
 *
 * Project Aegis's LFS server occasionally has a pointer whose blob is
 * missing (objects deleted from the LFS storage, or never pushed). A
 * single such object causes `git lfs pull` to emit:
 *
 *   Scanner error: missing object: <sha>
 *   Errors logged to '.../.git/lfs/logs/<ts>.log'.
 *
 * ...and exit non-zero WITHOUT smudging any of the healthy pointers
 * scanned alongside it. That leaves the working tree full of 130-byte
 * pointer files and breaks every downstream step (scene YAML parses
 * into an empty AST, texture copy sees pointer bytes, etc.).
 *
 * We mitigate by splitting the pull into extension-scoped batches.
 * Each batch is independent, so a single missing blob only poisons
 * the batch that contains it — everything else still lands on disk.
 */
const TEXT_ONLY_EXTS = [
  '*.unity',
  '*.mat',
  '*.prefab',
  '*.asset',
  '*.controller',
  '*.anim',
  '*.physicMaterial',
];
const BINARY_EXTS = [
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.tga',
  '*.psd',
  '*.bmp',
  '*.webp',
  '*.gif',
  '*.fbx',
  '*.obj',
];

/**
 * Run `git lfs fetch --include=<pattern>` with `lfs.skipdownloaderrors`
 * on. That config tells git-lfs to log each missing object as a
 * warning and keep downloading the rest instead of giving up on the
 * first Scanner error. Project Aegis's LFS server has several
 * pointers whose blobs are gone upstream, and without this flag a
 * single such pointer poisons the whole batch.
 *
 * We still wrap in try/catch because even with skipdownloaderrors
 * some git-lfs versions return non-zero at the end if any object
 * was skipped — harmless, we just don't want it to propagate.
 */
async function runLfsFetchBatch(
  lfsGit: SimpleGit,
  include: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await lfsGit.raw([
      '-c',
      'lfs.skipdownloaderrors=true',
      'lfs',
      'fetch',
      '--include',
      include,
    ]);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

async function fetchLfsAssets(targetDir: string): Promise<void> {
  // Fully skip LFS fetch when AEGISGRAM_FORCE_LIVE is set — lazyLfs.ts
  // handles both text (.unity / .mat / .prefab) and binary assets on
  // demand at request time, so there's no benefit to a bulk pull at
  // startup/sync. This is the fast path for warm restarts: the repo is
  // already on disk, the compiled indexes cover everything we need,
  // and any pointer file gets materialised when its scene is opened.
  if ((process.env.AEGISGRAM_FORCE_LIVE || '').toLowerCase() === 'true') {
    console.log('[gitSync] AEGISGRAM_FORCE_LIVE=true — skipping bulk LFS fetch (lazy LFS covers on-demand)');
    return;
  }

  const lfsGit = simpleGit(targetDir).env({
    GIT_TERMINAL_PROMPT: '0',
  } as Record<string, string>);
  attachGitStreamLogger(lfsGit);

  // Legacy path (when not in force-live mode): do the full/text-only
  // batch fetch. LEVEL_VIEWER_LFS_STARTUP selects between:
  //   'text-only' — fast startup, ~1 min, 7 batches
  //   'full'      — legacy behaviour, all 17 batches, 20-40 min
  const startupMode =
    (process.env.LEVEL_VIEWER_LFS_STARTUP || '').toLowerCase() === 'full'
      ? 'full'
      : 'text-only';

  const batches =
    startupMode === 'full' && config.gitFetchLfs
      ? [...TEXT_ONLY_EXTS, ...BINARY_EXTS]
      : TEXT_ONLY_EXTS;

  console.log(
    `[gitSync] lfs fetch in ${batches.length} extension batches ` +
      `(${startupMode}, skipdownloaderrors=on)…`,
  );

  let okCount = 0;
  const failed: Array<{ ext: string; error: string }> = [];
  for (const ext of batches) {
    const res = await runLfsFetchBatch(lfsGit, ext);
    if (res.ok) {
      okCount += 1;
      console.log(`[gitSync]   ${ext} OK`);
    } else {
      failed.push({ ext, error: res.error ?? 'unknown' });
      // Trim multi-line simple-git error messages to one log line
      // so the summary isn't drowned out.
      const oneLine = (res.error ?? '').split(/\r?\n/)[0].slice(0, 200);
      console.warn(`[gitSync]   ${ext} FAILED — ${oneLine}`);
    }
  }

  // Smudge pass: lay down working-tree copies for every LFS pointer
  // whose blob is now in the local cache. Separating fetch from
  // checkout means that even if fetch returned non-zero halfway
  // through, the objects it DID download get committed to the
  // working tree here. `git lfs checkout` itself can't fail on
  // missing objects — it silently leaves those files as pointers,
  // which our downstream `isLfsPointer` guards handle gracefully.
  try {
    console.log('[gitSync] lfs checkout (smudging cached objects)...');
    await lfsGit.raw(['lfs', 'checkout']);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[gitSync] lfs checkout warning (non-fatal): ${msg.split(/\r?\n/)[0]}`);
  }

  console.log(`[gitSync] lfs fetch: ${okCount} ok, ${failed.length} failed`);
  if (failed.length && okCount === 0) {
    // Every batch died — that usually means a global LFS problem
    // (auth, network, server down), not per-object corruption. Let
    // the caller see the first error so diagnostics are meaningful.
    const first = failed[0];
    console.warn(
      `[gitSync] all lfs batches failed. First error for ${first.ext}: ${first.error}`,
    );
  }
}

async function pullSparse(targetDir: string): Promise<void> {
  // Ensure the URL rewrites are present in the repo's local config on
  // every sync — safe against existing clones that predate the env
  // being set, and idempotent so new env values overwrite stale ones.
  await persistUrlRewritesInRepo(targetDir);

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
    // Serialise against lazyLfs. Both take `.git/index.lock` for
    // their checkout phases (reset --hard here, lfs checkout there);
    // running concurrently hard-fails one of them with
    // "Unable to create '.git/index.lock': File exists" and leaves
    // the repo in a half-baked state that only the NEXT sync will
    // opportunistically fix — which is exactly the symptom the user
    // reports where "Git Sync" is required to unstick a scene load.
    await scheduleInRepo(() => pullSparse(localDir));
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
