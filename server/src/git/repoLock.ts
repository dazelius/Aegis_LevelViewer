/**
 * Repo-wide sequential lock for git / git-lfs subprocesses.
 *
 * Every piece of the server that runs a git command against the same
 * clone MUST funnel through `scheduleInRepo`. Without this, concurrent
 * `git fetch` / `git reset --hard` / `git lfs fetch` / `git lfs
 * checkout` operations race for `.git/index.lock` and git hard-fails
 * the loser with:
 *
 *   fatal: Unable to create '.../.git/index.lock': File exists.
 *
 * The typical trigger is a manual Git Sync (or the bootstrap's
 * background `syncUnityRepo()`) firing at the exact moment a lazyLfs
 * fetch+checkout is in flight for a freshly-opened scene. Both need
 * the index; whichever loses the race leaves the scene file as a
 * pointer and the user sees a permanent 409/503 loop until the NEXT
 * sync opportunistically reruns checkout and smudges the blobs that
 * had landed in .git/lfs/objects in the meantime.
 *
 * The lock is a plain sequential Promise chain — tasks run in
 * submission order. Failures don't poison downstream tasks (both
 * fulfilled and rejected outcomes advance the chain).
 */

let repoChain: Promise<void> = Promise.resolve();

/**
 * Queue a task to run after every previously-queued git task for
 * this repo completes (succeeds or fails). Resolves/rejects with
 * the task's own outcome so callers still see errors.
 */
export function scheduleInRepo<T>(task: () => Promise<T>): Promise<T> {
  const result = repoChain.then(task, task);
  repoChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result as Promise<T>;
}

/**
 * Separate chain for `git lfs fetch` (download-only, no working-tree
 * writes). LFS fetch writes to `.git/lfs/objects` and `.git/lfs/tmp`
 * but NEVER touches `.git/index.lock`, so it's safe to run in parallel
 * with `reset --hard` / `pullSparse` / `lfs checkout` — all of which
 * do take the index lock and go through `scheduleInRepo`.
 *
 * Why this matters: a Git Sync triggers `reset --hard` that rewrites
 * 10k+ working-tree files on Windows (30–60 s). If scene-open LFS
 * fetches queue behind that on the same chain, the scene parses with
 * stale pointers and renders magenta surfaces. Splitting the chains
 * lets blob downloads start the moment the user clicks a scene, even
 * if a sync is mid-checkout.
 *
 * We still serialise fetches against *each other* so a burst of
 * per-asset mesh requests doesn't spawn N concurrent `git lfs fetch`
 * processes racing on `.git/lfs/tmp/<oid>`. The `enqueueLazyFetch`
 * coalescer upstream already batches paths into a single call; this
 * chain is belt-and-braces for the remaining cross-batch ordering.
 */
let lfsFetchChain: Promise<void> = Promise.resolve();

export function scheduleLfsFetch<T>(task: () => Promise<T>): Promise<T> {
  const result = lfsFetchChain.then(task, task);
  lfsFetchChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result as Promise<T>;
}
