#!/usr/bin/env node
/**
 * Orchestrates the "refresh deploy content" flow end-to-end:
 *
 *   1. `npm run bake` — incremental, so after the first full bake
 *      re-running this script costs seconds per scene that actually
 *      changed upstream.
 *   2. Verify `data/bundle/manifest.json` exists and is non-empty.
 *   3. Make sure `git lfs install` has run locally (idempotent).
 *   4. Stage ONLY the bundle paths + `.gitattributes` — intentionally
 *      NOT `git add .`, so any unrelated in-progress edits
 *      (App.tsx, WIP branches, etc.) stay out of the publish commit.
 *   5. If nothing changed under the staged paths, exit cleanly — no
 *      point in an empty "chore: refresh bundle" commit.
 *   6. Commit with a timestamped message that carries the scene count
 *      + bake timestamp pulled from the manifest, so PR history reads
 *      like a content changelog instead of opaque chores.
 *   7. Push to the current branch's upstream.
 *
 * This is the script referenced by README's "Alternative: locally
 * baked + committed bundle" path. The deploy target then only needs
 * `git lfs pull && npm start` — no GitLab / Unity access required.
 *
 * Usage:
 *   npm run publish-bundle
 *   npm run publish-bundle -- --no-push        # local commit only
 *   npm run publish-bundle -- --skip-bake      # commit existing bundle as-is
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLE_DIR = join(REPO_ROOT, 'data', 'bundle');
const MANIFEST_PATH = join(BUNDLE_DIR, 'manifest.json');
const STAGE_PATHS = ['.gitattributes', 'data/bundle'];

const args = new Set(process.argv.slice(2));
const skipBake = args.has('--skip-bake');
const skipPush = args.has('--no-push');

function log(msg) {
  process.stdout.write(`[publish-bundle] ${msg}\n`);
}
function die(msg, code = 1) {
  process.stderr.write(`[publish-bundle] ERROR: ${msg}\n`);
  process.exit(code);
}

/** Run a shell-style command streaming stdout/stderr to our own
 *  streams. Resolves on exit 0, rejects otherwise. `npm` on Windows
 *  is a .cmd, so we always use `shell: true` to let the OS resolve
 *  it instead of insisting on a bare-exe path. */
function run(cmd, cwd = REPO_ROOT) {
  return new Promise((resolve, reject) => {
    log(`$ ${cmd}`);
    const child = spawn(cmd, {
      cwd,
      stdio: 'inherit',
      shell: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

/** Synchronous single-line git output capture. Used for short
 *  read-only probes (branch name, staged diff summary) where the
 *  streaming `run()` would be overkill. */
function gitOut(args) {
  const res = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${res.status}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout.trim();
}

async function ensureLfs() {
  try {
    // `git lfs install` is idempotent — it just rewrites the
    // per-repo hooks. Silent if already done.
    await run('git lfs install');
  } catch (err) {
    die(
      `git lfs install failed. Install git-lfs (https://git-lfs.com/) and retry.\n${err.message}`,
    );
  }
}

function readManifestSummary() {
  try {
    const raw = readFileSync(MANIFEST_PATH, 'utf8');
    const m = JSON.parse(raw);
    const sceneCount = Array.isArray(m.scenes) ? m.scenes.length : '?';
    const bakedAt = typeof m.bakedAt === 'string' ? m.bakedAt : null;
    // The bake script writes the short SHA as `gitHead`. Fall back
    // to `sourceRev` so older manifests still parse — a no-op for
    // fresh bakes but keeps `--skip-bake` usable if you upgraded
    // the script after a bundle was already on disk.
    const sourceRev =
      typeof m.gitHead === 'string'
        ? m.gitHead.slice(0, 10)
        : typeof m.sourceRev === 'string'
          ? m.sourceRev.slice(0, 10)
          : null;
    return { sceneCount, bakedAt, sourceRev };
  } catch (err) {
    die(
      `Couldn't read ${MANIFEST_PATH}. The bake probably failed — scroll up for its error log.\n${err.message}`,
    );
    return null;
  }
}

async function main() {
  log(`repo root: ${REPO_ROOT}`);
  log(`bundle:    ${BUNDLE_DIR}`);

  if (skipBake) {
    log('--skip-bake: using existing bundle on disk as-is.');
  } else {
    log('step 1/6 — running bake (incremental, 10~30min on first run)...');
    try {
      await run('npm run bake');
    } catch (err) {
      die(`bake failed: ${err.message}`);
    }
  }

  log('step 2/6 — verifying bundle output...');
  try {
    const st = statSync(MANIFEST_PATH);
    if (st.size === 0) die(`${MANIFEST_PATH} is empty — bake did not complete.`);
  } catch {
    die(`${MANIFEST_PATH} is missing — bake did not run or failed.`);
  }
  const summary = readManifestSummary();
  log(
    `  scenes:    ${summary.sceneCount}` +
      (summary.sourceRev ? ` · source rev ${summary.sourceRev}` : '') +
      (summary.bakedAt ? ` · baked ${summary.bakedAt}` : ''),
  );

  log('step 3/6 — ensuring git-lfs is initialised for this clone...');
  await ensureLfs();

  log(`step 4/6 — staging ${STAGE_PATHS.join(', ')}...`);
  await run(`git add -- ${STAGE_PATHS.join(' ')}`);

  log('step 5/6 — checking for staged changes under bundle paths...');
  const staged = gitOut(['diff', '--cached', '--name-only', '--', ...STAGE_PATHS]);
  if (!staged) {
    log('  no changes staged — bundle already matches HEAD. Nothing to commit.');
    log('done.');
    return;
  }
  const stagedLines = staged.split(/\r?\n/).filter(Boolean);
  log(`  ${stagedLines.length} file(s) staged.`);

  log('step 6/6 — committing + pushing...');
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const parts = [`chore: refresh content bundle`, `${summary.sceneCount} scenes @ ${stamp}`];
  if (summary.sourceRev) parts.push(`source ${summary.sourceRev}`);
  const msg = parts.join(' · ');
  await run(`git commit -m "${msg}"`);

  if (skipPush) {
    log('--no-push: commit created locally, skipping push.');
  } else {
    const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
    log(`pushing ${branch} to origin...`);
    await run(`git push origin ${branch}`);
  }

  log('done. Deploy target can now `git lfs pull && npm start`.');
}

main().catch((err) => {
  die(err && err.message ? err.message : String(err));
});
