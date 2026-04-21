/**
 * Lazy, on-demand LFS fetcher for live mode.
 *
 * The full `git lfs fetch` of an entire Unity repo (textures + FBX +
 * everything) takes 20–40 min on a fresh clone. This module replaces
 * that wall-of-time with two lighter strategies that together give a
 * usable viewer within seconds of requesting a scene:
 *
 * 1. **Scene-level pre-fetch** (`triggerLazyLfsForScene`):
 *    Called (without await) the moment a scene request arrives. Reads
 *    the raw .unity YAML, extracts every referenced GUID, maps them to
 *    file paths via the assetIndex, filters to LFS pointers, and queues
 *    a `git lfs fetch --include=<paths>` for exactly those files. By
 *    the time Three.js finishes parsing the scene JSON and fires its
 *    first /api/assets/* requests, many of the binaries are already in
 *    the local LFS object store.
 *
 * 2. **Per-asset blocking wait** (`ensureLfsFile`):
 *    Called when an /api/assets/texture or /api/assets/mesh request
 *    lands on a file that is still a pointer. If the scene-level
 *    pre-fetch already queued this file, we await that in-flight
 *    promise (capped at `timeoutMs`). If not, we start a single-file
 *    fetch immediately. Either way the caller gets a concrete answer
 *    within the timeout window — it then re-reads the file and either
 *    serves real bytes or falls back to the placeholder.
 *
 * Concurrency model:
 * - `inFlight`: Map<absPath, Promise<void>>  — per-file deduplication.
 *   Multiple simultaneous requests for the same file share one fetch.
 * - `repoChain`: a sequential Promise chain — only one `git lfs fetch`
 *   process runs at a time per repo. git-lfs serialises internally too,
 *   but launching dozens of processes concurrently wastes handles and
 *   saturates the LFS HTTP connection pool.
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { assetIndex } from '../unity/assetIndex.js';
import { scheduleInRepo } from './repoLock.js';

// ---------------------------------------------------------------------------
// LFS pointer detection
// ---------------------------------------------------------------------------

const LFS_HEAD = 'version https://git-lfs.github.com/spec/';

export function isLfsPointerBuf(buf: Buffer): boolean {
  if (buf.length > 1024) return false;
  return buf.slice(0, 64).toString('utf8').startsWith(LFS_HEAD);
}

function isLfsPointerSync(absPath: string): boolean {
  try {
    const buf = fsSync.readFileSync(absPath);
    return isLfsPointerBuf(buf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GUID extraction (fast regex scan — no full YAML parse needed)
// ---------------------------------------------------------------------------

/** Extensions whose LFS-status we care about for 3D rendering. */
const BINARY_EXTS = new Set([
  '.fbx', '.obj',
  '.png', '.jpg', '.jpeg', '.tga', '.psd', '.bmp', '.webp', '.gif', '.hdr', '.exr',
]);

function extractGuidsFromFile(absPath: string): string[] {
  try {
    const text = fsSync.readFileSync(absPath, 'utf8');
    const guids = new Set<string>();
    const re = /guid:\s*([0-9a-f]{32})/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) guids.add(m[1].toLowerCase());
    return [...guids];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Concurrency primitives
// ---------------------------------------------------------------------------

/** Per-absolute-path in-flight deduplication. */
const inFlight = new Map<string, Promise<void>>();

/** Has `git lfs env` diagnostic already been emitted? First failure is
 *  usually all we need to diagnose endpoint/auth issues. */
let lfsEnvReported = false;

async function reportLfsEnvOnce(repoDir: string): Promise<void> {
  if (lfsEnvReported) return;
  lfsEnvReported = true;

  const scrubCreds = (s: string): string =>
    s.replace(/(oauth2|x-access-token|git):([^@\s]+)@/g, '$1:***@');

  try {
    const git = simpleGit(repoDir).env({
      GIT_TERMINAL_PROMPT: '0',
    } as Record<string, string>);
    const out = await git.raw(['lfs', 'env']);
    const scrubbed = scrubCreds(String(out));
    console.log('[lazyLfs] === git lfs env (one-time diagnostic) ===');
    for (const line of scrubbed.split('\n')) {
      if (line.trim().length > 0) console.log(`[lazyLfs]   ${line}`);
    }
    console.log('[lazyLfs] === end git lfs env ===');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[lazyLfs] git lfs env diagnostic failed: ${msg}`);
  }

  // Dump the most recent `.git/lfs/logs/*.log` file. When git-lfs runs
  // with `skipdownloaderrors=true`, per-object errors (HTTP 401 / 404 /
  // batch rejection) are NOT raised — the command exits 0 and records
  // everything to these per-run log files. This is usually where the
  // real reason (bad credentials, LFS server URL unreachable, missing
  // blob upstream, wrong LFS endpoint) shows up.
  try {
    const logsDir = path.join(repoDir, '.git', 'lfs', 'logs');
    if (!fsSync.existsSync(logsDir)) {
      console.log('[lazyLfs] no .git/lfs/logs/ directory — git-lfs may not have attempted a transfer yet');
      return;
    }
    const entries = fsSync
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, t: fsSync.statSync(path.join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (entries.length === 0) {
      console.log('[lazyLfs] no .log files in .git/lfs/logs/');
      return;
    }
    const newest = entries[0];
    const fullPath = path.join(logsDir, newest.f);
    const raw = fsSync.readFileSync(fullPath, 'utf8');
    const scrubbed = scrubCreds(raw);
    const truncated = scrubbed.length > 4000
      ? `${scrubbed.slice(0, 4000)}\n…(truncated, see ${fullPath})`
      : scrubbed;
    console.log(`[lazyLfs] === most recent LFS log: ${newest.f} ===`);
    for (const line of truncated.split('\n')) {
      if (line.length > 0) console.log(`[lazyLfs]   ${line}`);
    }
    console.log('[lazyLfs] === end LFS log ===');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[lazyLfs] LFS log dump failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Core fetch logic
// ---------------------------------------------------------------------------

const BATCH_SIZE = 80; // paths per git lfs fetch call (avoid arg-list limit)

async function doFetchBatch(absFilePaths: string[], repoDir: string): Promise<void> {
  const relPaths = absFilePaths
    .map((p) => path.relative(repoDir, p).replace(/\\/g, '/'))
    .filter((p) => p.length > 0 && !p.startsWith('..'));

  if (relPaths.length === 0) return;

  const git = simpleGit(repoDir).env({
    GIT_TERMINAL_PROMPT: '0',
  } as Record<string, string>);

  for (let i = 0; i < relPaths.length; i += BATCH_SIZE) {
    const batch = relPaths.slice(i, i + BATCH_SIZE);
    const include = batch.join(',');
    try {
      console.log(`[lazyLfs] fetching ${batch.length} file(s) from LFS…`);
      if (batch.length <= 5) {
        for (const p of batch) console.log(`[lazyLfs]   - ${p}`);
      }
      // Deliberately do NOT pass `lfs.skipdownloaderrors=true` here.
      // Under skipdownloaderrors, git-lfs swallows per-object failures
      // (401 / 404 / timeout) and exits 0 with no blob on disk — we
      // get silent breakage that looks like a successful fetch. For
      // lazy, single-file fetches we'd rather see the real error so
      // it surfaces in the catch block below and we can act on it.
      // `lfs.transfer.maxretries=1` shortens the wall-time of an
      // unreachable LFS endpoint from minutes to seconds — lazy LFS
      // is on the user's request path, so we can't afford to hang.
      //
      // Wall-clock timeout (90 s) is belt-and-suspenders: if git-lfs
      // somehow wedges despite its own activitytimeout, we reject the
      // chain so subsequent requests don't queue behind a dead fetch.
      const FETCH_TIMEOUT_MS = 90_000;
      // URL rewrites (`url.X.insteadOf`) are persisted in the repo's
      // local config by gitSync.persistUrlRewritesInRepo, so this
      // call inherits them automatically — no env/flag injection
      // needed here, which matters because git/simple-git block
      // `GIT_CONFIG_COUNT` env as "unsafe", and `-c` flags don't
      // reliably propagate into git-lfs's internal smudge/filter
      // subprocesses anyway.
      const fetchPromise = git.raw([
        '-c', 'lfs.transfer.maxretries=1',
        'lfs', 'fetch', '--include', include,
      ]);
      await Promise.race([
        fetchPromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`git lfs fetch wall-clock timeout (${FETCH_TIMEOUT_MS}ms)`)),
            FETCH_TIMEOUT_MS,
          ),
        ),
      ]);
      // Smudge pass: materialise cached objects into the working tree.
      // `git lfs checkout` (no file args) smudges every pointer whose
      // blob is now in `.git/lfs/objects` — safe to run after each
      // fetch batch even if some blobs were missing upstream.
      await git.raw(['lfs', 'checkout']);
      console.log(`[lazyLfs] smudged ${batch.length} file(s)`);
      // Verify: if the first path in the batch is STILL a pointer after
      // smudge, something went wrong upstream — surface that clearly so
      // we don't silently serve empty scene data. This is the common
      // path when `lfs.skipdownloaderrors=true` hides real failures:
      // git-lfs exits 0 but no blob landed on disk.
      if (batch.length > 0) {
        const firstAbs = absFilePaths[i];
        if (firstAbs && fsSync.existsSync(firstAbs) && isLfsPointerSync(firstAbs)) {
          console.warn(
            `[lazyLfs] post-smudge check: ${batch[0]} is STILL an LFS ` +
              `pointer — LFS server silently rejected the batch ` +
              `(auth/network/missing). See LFS log dump below for the ` +
              `real error.`,
          );
          // Fire the one-shot diagnostic — both `git lfs env` and the
          // most recent `.git/lfs/logs/*.log` dump. Async but we don't
          // await it so we don't block the fetch chain on diagnostics.
          reportLfsEnvOnce(repoDir).catch(() => {});
        }
      }
    } catch (err) {
      // Full multi-line error dump — the first line is usually git-lfs's
      // "Fetching reference refs/heads/..." progress noise, and the real
      // cause (auth failure, endpoint unreachable, pointer missing) is
      // on a later line. Log everything so the platform operator can
      // see what git-lfs actually complained about.
      const full = err instanceof Error ? (err.message || String(err)) : String(err);
      const trimmed = full.length > 2000 ? `${full.slice(0, 2000)}\n…(truncated)` : full;
      console.warn(`[lazyLfs] batch failed (non-fatal):\n${trimmed}`);
      // Best-effort: dump LFS env once so we can see the endpoint and
      // auth mode the platform is using. Async but we don't await it.
      reportLfsEnvOnce(repoDir).catch(() => {});
    }
  }
}

/**
 * Register a set of absolute paths for lazy LFS fetch.
 * New paths are queued behind the repo's sequential lock.
 * Paths already in-flight share the existing promise.
 */
function registerBatch(absPaths: string[], repoDir: string): Promise<void> {
  const newPaths = absPaths.filter((p) => !inFlight.has(p));

  if (newPaths.length === 0) {
    // All already in-flight — return any one as a representative.
    return inFlight.get(absPaths[0]) ?? Promise.resolve();
  }

  const batchDone = scheduleInRepo(() => doFetchBatch(newPaths, repoDir));

  // Register each new path under the shared promise; clean up when done.
  const cleanup = batchDone.finally(() => {
    for (const p of newPaths) inFlight.delete(p);
  });

  for (const p of newPaths) inFlight.set(p, cleanup);

  return batchDone;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: scan a .unity file for referenced binary asset GUIDs,
 * detect which are still LFS pointers, and start downloading them in the
 * background. Does NOT block the caller — the scene handler returns its
 * JSON immediately and the download races the browser's render pipeline.
 *
 * @param sceneAbsPath  Absolute path to the .unity file.
 * @param repoDir       Root of the git clone (from `getRepo2LocalDir()`).
 */
export function triggerLazyLfsForScene(sceneAbsPath: string, repoDir: string): void {
  const guids = extractGuidsFromFile(sceneAbsPath);
  if (guids.length === 0) return;

  const pointerPaths: string[] = [];
  for (const guid of guids) {
    const rec = assetIndex.get(guid);
    if (!rec) continue;
    if (!BINARY_EXTS.has(rec.ext)) continue;
    if (isLfsPointerSync(rec.absPath)) pointerPaths.push(rec.absPath);
  }

  if (pointerPaths.length === 0) return;

  console.log(
    `[lazyLfs] scene ${path.basename(sceneAbsPath)}: ` +
      `queuing ${pointerPaths.length} LFS pointer(s) for background fetch`,
  );
  registerBatch(pointerPaths, repoDir); // intentionally not awaited
}

/**
 * Fire-and-forget variant of `ensureLfsFile`. Guarantees that a single
 * file is registered for LFS fetch (joining an existing in-flight batch
 * or starting a new one), but returns immediately without awaiting the
 * fetch itself. Use this from HTTP handlers that must respond inside
 * the reverse-proxy's timeout (typically 30 s): the handler returns a
 * 409 "lfs-pointer, retry shortly" hint and the client polls.
 *
 * Returns `true` if the caller should treat the file as in-flight (was
 * or is now being fetched), `false` if the file is already a real blob
 * on disk (no work needed).
 */
export function triggerLfsFetch(absPath: string, repoDir: string): boolean {
  if (inFlight.has(absPath)) return true;
  if (!isLfsPointerSync(absPath)) return false;
  registerBatch([absPath], repoDir);
  return true;
}

/**
 * Ensure a single asset file is available (not a pointer). Returns a
 * Promise that resolves when the file is ready *or* when the timeout
 * elapses — callers should re-read and re-check after awaiting.
 *
 * - Already a real file   → resolves immediately (no I/O beyond a tiny peek).
 * - In-flight from scene  → awaits existing promise (no duplicate download).
 * - New pointer           → starts a dedicated single-file fetch, awaits it.
 *
 * Never rejects; callers use `isLfsPointerBuf` after awaiting to decide
 * whether to serve real bytes or a placeholder.
 *
 * @param absPath    Absolute path to the asset file.
 * @param repoDir    Root of the git clone.
 * @param timeoutMs  Max wait (ms). Default 45 s — enough for a single FBX
 *                   on a reasonable connection; prevents request hangs.
 */
export async function ensureLfsFile(
  absPath: string,
  repoDir: string,
  timeoutMs = 45_000,
): Promise<void> {
  // Fast path: file is already materialised.
  const existing = inFlight.get(absPath);
  if (!existing) {
    try {
      const buf = await fs.readFile(absPath);
      if (!isLfsPointerBuf(buf)) return;
    } catch {
      return; // file gone or unreadable — let the caller handle it
    }
  }

  // Either in-flight or we just confirmed it's a pointer — ensure registered.
  const fetching = existing ?? registerBatch([absPath], repoDir);

  // Race the fetch against a timeout so the HTTP handler always responds.
  await Promise.race([
    fetching,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
