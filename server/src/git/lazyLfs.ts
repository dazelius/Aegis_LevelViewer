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

/**
 * Extensions that are YAML text in theory but LFS-tracked in practice on
 * this project. If any of these is still a pointer when scene parsing
 * runs, the server silently produces a scene with missing materials /
 * prefab contents — the viewer then paints every surface magenta because
 * three.js falls back to its default material when ours returns
 * undefined. These MUST be materialised before `parseScene` is called,
 * so they have their own pre-parse synchronous fetch pass
 * (`ensureSceneYamlPointersReady` below).
 */
const SCENE_YAML_EXTS = new Set(['.mat', '.prefab', '.asset', '.controller']);

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

// ---------------------------------------------------------------------------
// Bulk prefetch progress (materials + textures)
// ---------------------------------------------------------------------------
//
// `.mat` and image files are small and shared across scenes, so the
// per-scene lazy fetch pattern we use for FBX meshes is wasteful for
// them. On startup / after a Git Sync we instead kick off a single
// bulk prefetch that materialises every `.mat` + image LFS pointer in
// the repo in one background pass. UI polls `/api/lfs-status` (see
// getBulkPrefetchProgress below) to show a small "Assets: X / Y"
// badge while it runs.
interface BulkProgress {
  /** Is a bulk prefetch currently running? */
  running: boolean;
  /** Total pointer paths we decided to fetch. */
  total: number;
  /** How many batches have completed (success or failure). */
  done: number;
  /** Number of individual paths in completed batches. */
  filesDone: number;
  /** Monotonic ms timestamp when the current run started. */
  startedAt: number;
  /** When non-empty, the most recent batch error (rotates). */
  lastError?: string;
}

let bulkProgress: BulkProgress = {
  running: false,
  total: 0,
  done: 0,
  filesDone: 0,
  startedAt: 0,
};

export function getBulkPrefetchProgress(): BulkProgress {
  return { ...bulkProgress };
}

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
      // get silent breakage that looks like a successful fetch.
      //
      // `lfs.transfer.maxretries=3`: enough retries for transient
      // network blips without turning a dead endpoint into a minute-
      // long hang. Critically, within a single `git lfs fetch` call,
      // a retry after a partial download reads the existing bytes in
      // `.git/lfs/tmp/<oid>` and resumes the HTTP transfer with a
      // `Range:` header — this is how you actually get "이어받기"
      // semantics for a big blob that failed halfway. Between
      // separate fetches the same tmp file is also honoured, so
      // killing the process (including our wall-clock timeout below)
      // doesn't discard partial progress.
      //
      // Wall-clock timeout 240 s for bulk/batched calls: a single
      // 2 GB blob on a 100 Mbps internal link takes ~180 s — we need
      // head-room above that so resume actually has a chance to
      // complete instead of looping forever. If git-lfs wedges
      // completely, this still rejects the chain so subsequent
      // requests don't queue behind a dead fetch.
      const FETCH_TIMEOUT_MS = 240_000;
      // Log any currently-cached partial downloads in .git/lfs/tmp/
      // so operators can see what's being resumed vs started fresh.
      // Best-effort; never blocks the fetch on filesystem errors.
      const tmpDir = path.join(repoDir, '.git', 'lfs', 'tmp');
      let resumingCount = 0;
      let resumingBytes = 0;
      try {
        const entries = fsSync.readdirSync(tmpDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile()) continue;
          try {
            const st = fsSync.statSync(path.join(tmpDir, e.name));
            if (st.size > 0) {
              resumingCount += 1;
              resumingBytes += st.size;
            }
          } catch {
            // transient stat error — skip
          }
        }
      } catch {
        // tmp dir may not exist yet on a fresh repo
      }
      if (resumingCount > 0) {
        console.log(
          `[lazyLfs] resuming ${resumingCount} partial LFS download(s) ` +
            `(${(resumingBytes / (1024 * 1024)).toFixed(1)} MB already cached)`,
        );
      }
      // URL rewrites (`url.X.insteadOf`) are persisted in the repo's
      // local config by gitSync.persistUrlRewritesInRepo, so this
      // call inherits them automatically — no env/flag injection
      // needed here, which matters because git/simple-git block
      // `GIT_CONFIG_COUNT` env as "unsafe", and `-c` flags don't
      // reliably propagate into git-lfs's internal smudge/filter
      // subprocesses anyway.
      const fetchPromise = git.raw([
        '-c', 'lfs.transfer.maxretries=3',
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
 * Coalesce bursts of per-asset `enqueueLazyFetch` calls into a single
 * larger `registerBatch`. Without this, 85 parallel `/api/assets/mesh`
 * requests each call `registerBatch([onePath])` which each schedule a
 * SEPARATE git-lfs fetch through repoChain — serialising them one at
 * a time and wasting our `lfs.concurrenttransfers=16` entirely. By
 * waiting `COALESCE_WINDOW_MS` after the first request in a burst we
 * collect the whole wave into one fetch and let git-lfs parallelise
 * 16 at a time internally. Typical burst (scene open) collapses from
 * ~85 serial fetches to ~6 batched fetches — ~14× speedup.
 */
const COALESCE_WINDOW_MS = 150;

interface PendingCoalesced {
  paths: Set<string>;
  repoDir: string;
  deferred: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let pendingCoalesced: PendingCoalesced | null = null;

function flushPendingCoalesced(): void {
  const batch = pendingCoalesced;
  pendingCoalesced = null;
  if (!batch) return;
  clearTimeout(batch.timer);
  const paths = Array.from(batch.paths);
  if (paths.length === 0) {
    batch.resolve();
    return;
  }
  // Hand off to registerBatch which owns in-flight dedup, scheduleInRepo
  // serialisation, and the actual git-lfs fetch.
  registerBatch(paths, batch.repoDir).then(batch.resolve, batch.reject);
}

/**
 * Queue a single path for the next coalesced git-lfs fetch batch.
 * Returns a promise that resolves when the coalesced batch completes
 * (success or failure of the underlying git-lfs call). Used on the
 * request path (one /api/assets/mesh or /api/assets/texture call per
 * asset GUID); bulk callers that already have many paths should keep
 * using `registerBatch` directly.
 */
function enqueueLazyFetch(absPath: string, repoDir: string): Promise<void> {
  // Already being fetched in an earlier batch — piggy-back on that.
  const existing = inFlight.get(absPath);
  if (existing) return existing;

  if (!pendingCoalesced) {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const deferred = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pendingCoalesced = {
      paths: new Set<string>(),
      repoDir,
      deferred,
      resolve,
      reject,
      timer: setTimeout(flushPendingCoalesced, COALESCE_WINDOW_MS),
    };
  }

  pendingCoalesced.paths.add(absPath);
  // Register the pending deferred so further concurrent callers for
  // the same path don't also queue it.
  inFlight.set(absPath, pendingCoalesced.deferred);
  return pendingCoalesced.deferred;
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
/**
 * Synchronously materialise every `.mat` / `.prefab` / `.asset`
 * referenced (transitively via GUID) by a scene file that is still an
 * LFS pointer on disk. This MUST be called right after the scene file
 * itself is smudged and BEFORE `parseScene` runs — otherwise the
 * material parser reads pointer-text, silently produces no materials,
 * and the renderer paints every surface magenta (three.js's default
 * material when ours returns undefined).
 *
 * Race-bounded by `timeoutMs`: if the LFS endpoint is slow we stop
 * blocking and let the caller serve the scene with whatever materials
 * did land. On a subsequent request the inFlight map will have those
 * pointers registered so the next parse picks them up.
 *
 * First-pass only — does not recurse into fetched .prefab files to
 * pull in their own referenced .mat pointers. That's a deliberate
 * trade-off against the proxy timeout; nested prefab material chains
 * are rare enough that one pass covers the common case.
 *
 * @returns Number of pointer paths queued (0 == nothing to do).
 */
export async function ensureSceneYamlPointersReady(
  sceneAbsPath: string,
  repoDir: string,
  timeoutMs: number,
): Promise<number> {
  const guids = extractGuidsFromFile(sceneAbsPath);
  if (guids.length === 0) return 0;

  const pointerPaths: string[] = [];
  for (const guid of guids) {
    const rec = assetIndex.get(guid);
    if (!rec) continue;
    if (!SCENE_YAML_EXTS.has(rec.ext)) continue;
    if (isLfsPointerSync(rec.absPath)) pointerPaths.push(rec.absPath);
  }

  if (pointerPaths.length === 0) return 0;

  console.log(
    `[lazyLfs] scene ${path.basename(sceneAbsPath)}: ` +
      `pre-parse fetch of ${pointerPaths.length} YAML pointer(s) ` +
      `(.mat/.prefab/.asset) — blocking up to ${timeoutMs}ms`,
  );

  const batchDone = registerBatch(pointerPaths, repoDir);
  await Promise.race([
    batchDone.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return pointerPaths.length;
}

/**
 * Image file extensions we want eagerly fetched (not lazy per-scene):
 * textures are small, reused across scenes, and the first paint looks
 * awful without them (flat-colour everything).
 *
 * FBX / OBJ intentionally stay on the per-scene lazy path — a single
 * mesh can be 100s of MB and pulling them all at startup blocks the
 * server for 20+ minutes on a cold deploy.
 */
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.tga', '.psd', '.bmp', '.webp', '.gif', '.hdr', '.exr',
]);

/**
 * Background fetch of every `.mat` + image LFS pointer in the repo.
 * Fire-and-forget: resolves when all batches have run (success or
 * failure), but callers don't await it.
 *
 * Safe to call multiple times — if a run is already in progress the
 * second call is a no-op (returns the in-flight promise). That's the
 * right semantics for both startup and post-sync invocations.
 */
let bulkInFlight: Promise<void> | null = null;

/**
 * Batch size specifically for bulk prefetch. Smaller than the shared
 * {@link BATCH_SIZE} because bulk is on a background path where the
 * UI polls per-batch progress — if a single batch is too big, an
 * individual fetch can take 30–90 s on an internal LFS endpoint and
 * the user sees the counter "stuck" for that whole window. 25 gives
 * a visible tick roughly every few seconds on a typical network and
 * still keeps per-batch git-lfs overhead amortised.
 */
const BULK_BATCH_SIZE = 25;

export function bulkFetchMaterialsAndTextures(
  repoDir: string,
  assetIndex: {
    allByExt: (ext: string) => Array<{ absPath: string; ext: string; relPath: string }>;
  },
): Promise<void> {
  if (bulkInFlight) return bulkInFlight;

  const scan = async (): Promise<void> => {
    // Gather every pointer we care about. We re-stat rather than
    // trusting the asset index because LFS status changes over time
    // (lazy-per-scene fetches may have already smudged some files).
    const candidates: string[] = [];
    for (const rec of assetIndex.allByExt('.mat')) {
      if (isLfsPointerSync(rec.absPath)) candidates.push(rec.absPath);
    }
    for (const ext of IMAGE_EXTS) {
      for (const rec of assetIndex.allByExt(ext)) {
        if (isLfsPointerSync(rec.absPath)) candidates.push(rec.absPath);
      }
    }

    if (candidates.length === 0) {
      console.log('[lazyLfs] bulk prefetch: nothing to do (no .mat / image pointers)');
      return;
    }

    const totalBatches = Math.ceil(candidates.length / BULK_BATCH_SIZE);
    console.log(
      `[lazyLfs] bulk prefetch: ${candidates.length} pointer(s) ` +
        `(.mat + images) — ${totalBatches} batch(es) of up to ${BULK_BATCH_SIZE}`,
    );

    bulkProgress = {
      running: true,
      total: candidates.length,
      done: 0,
      filesDone: 0,
      startedAt: Date.now(),
    };

    for (let i = 0; i < candidates.length; i += BULK_BATCH_SIZE) {
      const chunk = candidates.slice(i, i + BULK_BATCH_SIZE);
      const batchIdx = Math.floor(i / BULK_BATCH_SIZE) + 1;

      // Filter out paths materialised by a concurrent lazy fetch
      // between scan time and now — saves work and log noise.
      const stillPointers = chunk.filter((p) => isLfsPointerSync(p));
      if (stillPointers.length === 0) {
        bulkProgress = {
          ...bulkProgress,
          done: bulkProgress.done + 1,
          filesDone: bulkProgress.filesDone + chunk.length,
        };
        continue;
      }

      const batchStart = Date.now();
      console.log(
        `[lazyLfs] bulk batch ${batchIdx}/${totalBatches}: fetching ${stillPointers.length} file(s)…`,
      );
      try {
        await registerBatch(stillPointers, repoDir);
        const took = ((Date.now() - batchStart) / 1000).toFixed(1);
        console.log(
          `[lazyLfs] bulk batch ${batchIdx}/${totalBatches}: done in ${took}s`,
        );
      } catch (err) {
        const took = ((Date.now() - batchStart) / 1000).toFixed(1);
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[lazyLfs] bulk batch ${batchIdx}/${totalBatches}: failed after ${took}s — ${msg.split(/\r?\n/)[0]}`,
        );
        bulkProgress = { ...bulkProgress, lastError: msg };
      }
      bulkProgress = {
        ...bulkProgress,
        done: bulkProgress.done + 1,
        filesDone: bulkProgress.filesDone + chunk.length,
      };
    }

    const elapsedSec = ((Date.now() - bulkProgress.startedAt) / 1000).toFixed(1);
    console.log(
      `[lazyLfs] bulk prefetch done in ${elapsedSec}s — ` +
        `${bulkProgress.filesDone} file(s) across ${bulkProgress.done} batch(es)`,
    );
    bulkProgress = { ...bulkProgress, running: false };
  };

  bulkInFlight = scan().finally(() => {
    bulkInFlight = null;
  });
  return bulkInFlight;
}

/**
 * Warm the LFS cache for a freshly-synced set of repo-relative paths.
 *
 * Called from the post-`syncUnityRepo` fire-and-forget pipeline after
 * we've diffed old..new HEAD. We only care about files that:
 *   - live under the sparse tree on disk (skips tombstones/deletes),
 *   - are tracked by LFS (pointer on disk right now),
 *   - and are either scene-level YAML, materials, or scenes themselves.
 *
 * Each matched scene (`.unity`) also has its referenced binaries
 * queued via the existing scene-level walker, so a reviewer opening
 * the just-changed scene finds everything in the local LFS cache.
 *
 * Fire-and-forget: caller does not need to await.
 */
export function warmChangedPaths(repoDir: string, changedRepoRelPaths: string[]): void {
  if (changedRepoRelPaths.length === 0) return;

  const sceneAbsPaths: string[] = [];
  const otherPointers: string[] = [];

  for (const rel of changedRepoRelPaths) {
    const abs = path.join(repoDir, rel);
    let stat: fsSync.Stats;
    try {
      stat = fsSync.statSync(abs);
    } catch {
      continue; // file was removed or sits outside sparse tree
    }
    if (!stat.isFile()) continue;

    const ext = path.extname(rel).toLowerCase();
    const isScene = ext === '.unity';
    const isYaml = SCENE_YAML_EXTS.has(ext);
    const isBinary = BINARY_EXTS.has(ext);

    if (!isScene && !isYaml && !isBinary) continue;
    if (!isLfsPointerSync(abs)) continue;

    if (isScene) sceneAbsPaths.push(abs);
    else otherPointers.push(abs);
  }

  const totalPointer = sceneAbsPaths.length + otherPointers.length;
  if (totalPointer === 0) {
    console.log(
      `[lazyLfs] warmChangedPaths: ${changedRepoRelPaths.length} changed, ` +
        `nothing to warm (already materialised or not LFS)`,
    );
    return;
  }

  console.log(
    `[lazyLfs] warmChangedPaths: ${sceneAbsPaths.length} scene(s) + ` +
      `${otherPointers.length} YAML/binary pointer(s)`,
  );

  // First: queue the scene YAML + any changed mats/prefabs. These feed
  // parseScene, so materialising them quickly is what makes the next
  // scene open fast even if the reviewer clicks within a second of the
  // sync finishing.
  if (otherPointers.length > 0) {
    registerBatch(otherPointers, repoDir); // not awaited
  }

  // Second: for each changed scene, walk its GUID graph and queue the
  // referenced binaries (textures, FBX, etc.). We also register the
  // scene pointer itself so its YAML lands in the cache before the
  // first request.
  for (const sceneAbs of sceneAbsPaths) {
    registerBatch([sceneAbs], repoDir); // not awaited
    // Can't walk GUIDs until the scene YAML is smudged — schedule a
    // follow-up via a microtask that races the scene smudge.
    void (async () => {
      try {
        await ensureLfsFile(sceneAbs, repoDir, 20_000);
        triggerLazyLfsForScene(sceneAbs, repoDir);
      } catch {
        // Never fail the background warmer
      }
    })();
  }
}

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
  // Route through the coalescer: if other asset requests arrive in
  // the same ~150 ms window they'll all share one git-lfs fetch call.
  void enqueueLazyFetch(absPath, repoDir);
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

  // Either in-flight or we just confirmed it's a pointer — ensure
  // registered. Route new paths through the coalescer so a burst of
  // concurrent single-file requests (e.g. 85 FBX opens at scene
  // load) collapses into one batched git-lfs fetch instead of 85
  // serialised ones.
  const fetching = existing ?? enqueueLazyFetch(absPath, repoDir);

  // Race the fetch against a timeout so the HTTP handler always responds.
  await Promise.race([
    fetching,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
