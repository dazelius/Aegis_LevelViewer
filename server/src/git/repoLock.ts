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
