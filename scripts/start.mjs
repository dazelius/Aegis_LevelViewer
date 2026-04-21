#!/usr/bin/env node
/**
 * Aegisgram entrypoint for zero-config platform deploys.
 *
 * Goal: a clone + `npm start` should Just Work, even if the host's
 * build phase did literally nothing. This script stitches the whole
 * lifecycle together — install, build, bake, run — using only Node
 * built-ins so it can boot with an empty `node_modules/`.
 *
 * Each step is idempotent: if its output already exists, we skip it.
 * That means fast restarts on platforms whose runtime disk survives
 * between deploys, and a full ~10-30 minute first-run on cold ones.
 *
 * Steps (in order, each conditional):
 *   1. `npm ci --include=dev`  when root `node_modules/` is missing.
 *      `--include=dev` because Vite + tsx + typescript are listed as
 *      devDependencies; the bake step needs them even under
 *      NODE_ENV=production.
 *   2. `npm run build --workspace=web`  when `web/dist/` is missing.
 *   3. `npm run build --workspace=server`  when `server/dist/` is
 *      missing.
 *   4. `npm run bake --workspace=server`  when `data/bundle/
 *      manifest.json` is missing AND GitLab creds are configured.
 *      No creds → skip the bake and fall back to live mode, which
 *      surfaces the misconfiguration via the server's own startup
 *      logs rather than crashing here. This matches the design
 *      intent that the runtime env var `GITLAB_REPO2_URL` is
 *      optional in bundle mode.
 *   5. Launch `server/dist/index.js`.
 *
 * Anything but step 5 failing is fatal — we exit with the child's
 * status code so the platform's process supervisor sees the
 * original error.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const USE_SHELL = process.platform === 'win32';

function log(msg) {
  console.log(`[aegisgram-start] ${msg}`);
}

function warn(msg) {
  console.warn(`[aegisgram-start] ${msg}`);
}

function run(cmd, args) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
    // Windows `npm` is `npm.cmd`; child_process requires shell=true
    // to resolve shim scripts. Linux/macOS run the real npm binary
    // directly, but shell=true is harmless there too — we prefer
    // the branch over `shell: true` unconditionally to keep the
    // process tree shallow on Unix-likes.
    shell: USE_SHELL,
    env: process.env,
  });
  if (res.error) {
    console.error(`[aegisgram-start] failed to spawn ${cmd}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`[aegisgram-start] command failed: ${cmd} ${args.join(' ')} (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

function exists(rel) {
  try {
    fs.statSync(path.join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// 1. Install dependencies if the tree is bare.
// ---------------------------------------------------------------------
// Root `node_modules/` is the single reliable marker — `npm ci` at
// the root hoists workspaces so per-workspace `node_modules/` may or
// may not exist depending on version/resolver. We also probe for a
// hoisted package we know the server needs (`express`) in case the
// root dir exists but is a stale remnant.
const hasNodeModules = exists('node_modules') && exists('node_modules/express');
if (!hasNodeModules) {
  log('installing dependencies (fresh clone detected)...');
  // Prefer `npm ci` when a lockfile exists — deterministic, fast.
  // Fall back to `npm install` if the lockfile is missing (e.g. the
  // deploy host stripped it) so we don't brick the deploy on a
  // configuration quirk.
  if (exists('package-lock.json')) {
    run('npm', ['ci', '--include=dev']);
  } else {
    run('npm', ['install', '--include=dev']);
  }
} else {
  log('dependencies already installed');
}

// ---------------------------------------------------------------------
// 2. Build the web client if dist is missing.
// ---------------------------------------------------------------------
if (!exists('web/dist/index.html')) {
  log('building web client...');
  run('npm', ['run', 'build', '--workspace=web']);
} else {
  log('web/dist already built');
}

// ---------------------------------------------------------------------
// 3. Build the server (TypeScript → JS).
// ---------------------------------------------------------------------
if (!exists('server/dist/index.js')) {
  log('building server...');
  run('npm', ['run', 'build', '--workspace=server']);
} else {
  log('server/dist already built');
}

// ---------------------------------------------------------------------
// 4. Bake the content bundle if one doesn't exist.
//
// Skipping the bake is a legitimate configuration: a host that has a
// committed bundle (`git lfs pull`-based deploys) never needs to bake,
// and a dev host with no GitLab creds deliberately wants the bundle
// to be absent so the server runs in live mode against a local Unity
// clone. We only bake when both conditions hold — no bundle AND we
// have something to bake from.
// ---------------------------------------------------------------------
if (!exists('data/bundle/manifest.json')) {
  if (process.env.GITLAB_REPO2_URL) {
    log('no content bundle found — baking from GITLAB_REPO2_URL...');
    // Force full-LFS mode for the child bake process. This MUST be
    // set here on the parent env (inherited by the spawn) rather
    // than inside bake-bundle.ts, because ESM imports hoist ahead
    // of top-level statements — by the time the bake script's
    // inline `process.env.LEVEL_VIEWER_GIT_FETCH_LFS = 'true'`
    // runs, `config.ts` has already been evaluated and captured
    // the old (false) value. Setting it here means `config.ts`
    // sees 'true' on its first and only read.
    process.env.LEVEL_VIEWER_GIT_FETCH_LFS = 'true';
    run('npm', ['run', 'bake', '--workspace=server']);
  } else {
    warn('no data/bundle/manifest.json and no GITLAB_REPO2_URL set.');
    warn('starting in live mode — scenes will fail to load unless the');
    warn('server can reach Project Aegis on its own.');
  }
} else {
  log('content bundle present — booting in bundle mode');
}

// ---------------------------------------------------------------------
// 5. Launch the server.
//
// We re-exec `node server/dist/index.js` as a child rather than
// dynamically importing it because:
//   - A clean process boundary means the server sees a pristine
//     import cache (important for its own `dotenv` load + module-
//     level bootstrap).
//   - If the server exits, we propagate the exit code up to the
//     platform's supervisor. Dynamic-import would keep the
//     start.mjs process alive holding whatever state the server
//     left behind.
//   - SIGTERM / SIGINT are forwarded naturally through child
//     processes.
// ---------------------------------------------------------------------
log('launching server...');
const serverEntry = path.join(ROOT, 'server', 'dist', 'index.js');
const child = spawn(process.execPath, [serverEntry], {
  stdio: 'inherit',
  cwd: ROOT,
  env: process.env,
});

function forward(sig) {
  if (child.exitCode === null) child.kill(sig);
}
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

child.on('exit', (code, signal) => {
  if (signal) {
    log(`server exited via signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

// Silence unused-warning (reserved for future dynamic-import fallback).
void pathToFileURL;
