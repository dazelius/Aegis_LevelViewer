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
 * ---------------------------------------------------------------------
 * Critical design detail: the PORT is bound EARLY.
 *
 * Every managed host we've encountered has a startup health check on
 * the port it injected via `PORT` / `LEVEL_VIEWER_PORT`. Ours times
 * out after ~30-60 seconds and kills the process. The bake alone is
 * many minutes, and on a truly cold host we also have install +
 * build in front of it. Letting the port sit unbound during any of
 * those steps guarantees the supervisor kills us before we ever get
 * to `node server/dist/index.js`.
 *
 * The fix: bind a tiny Node http server to the target port as the
 * FIRST thing this script does (before install/build/bake), and
 * serve a JSON status payload that describes the current phase. It
 * passes health checks because it's a live TCP listener returning
 * 200. When all prep work finishes we close it and hand the port
 * off to the real server process.
 *
 * Port handoff is the one fiddly bit: on some OSes the port is held
 * in TIME_WAIT briefly after close, so the child can get EADDRINUSE.
 * We mitigate by (a) calling `setTimeout(..., 0)` after close to let
 * the OS release, and (b) having the real server retry its listen()
 * call (handled inside `server/src/index.ts`).
 * ---------------------------------------------------------------------
 *
 * Steps (in order, each conditional):
 *   0. Bind port to a placeholder HTTP server so health checks pass
 *      from T+0 regardless of how long the rest of the boot takes.
 *   1. `npm ci --include=dev`  when root `node_modules/` is missing.
 *      `--include=dev` because Vite + tsx + typescript are listed as
 *      devDependencies; the bake step needs them even under
 *      NODE_ENV=production.
 *   2. `npm run build --workspace=web`  when `web/dist/` is missing.
 *   3. `npm run build --workspace=server`  when `server/dist/` is
 *      missing.
 *   4. `npm run bake --workspace=server`  when `data/bundle/
 *      manifest.json` is missing AND GitLab creds are configured.
 *   5. Close placeholder; launch `server/dist/index.js`.
 *
 * Anything but step 5 failing is fatal — we exit with the child's
 * status code so the platform's process supervisor sees the
 * original error.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const USE_SHELL = process.platform === 'win32';

// Port resolution mirrors the server's own config.ts rules so the
// placeholder binds wherever the real server will want to bind.
// LEVEL_VIEWER_PORT wins because a local dev might want to override
// a platform-injected PORT; fallback 3101 for bare local runs.
const PORT = Number(process.env.LEVEL_VIEWER_PORT || process.env.PORT || '3101');

let currentPhase = 'initializing';
let currentDetail = '';

function log(msg) {
  console.log(`[aegisgram-start] ${msg}`);
}

function warn(msg) {
  console.warn(`[aegisgram-start] ${msg}`);
}

function setPhase(phase, detail = '') {
  currentPhase = phase;
  currentDetail = detail;
  log(`phase: ${phase}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------
// Placeholder HTTP server — keeps the port responsive during bake.
//
// Everything here is written with zero external deps so it can run
// before `npm ci` completes. It answers ANY request with a 200 JSON
// payload describing the current phase. That payload doubles as a
// useful tool for operators: `curl $HOST/` shows exactly where a
// slow deploy is stuck.
// ---------------------------------------------------------------------
let placeholderServer = null;

function startPlaceholder() {
  placeholderServer = http.createServer((req, res) => {
    const body = JSON.stringify({
      status: 'starting',
      phase: currentPhase,
      detail: currentDetail,
      message:
        'Aegisgram is warming up (install/build/bake). First boot on a ' +
        'cold host can take 10-30 minutes. This placeholder will be ' +
        'replaced by the real server automatically.',
      port: PORT,
      // Include the request path so a platform's health check against
      // a specific endpoint sees a predictable response shape.
      path: req.url,
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  });

  placeholderServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      // Something else is on the port already. Probably fine — this
      // means a previous deploy is still running. The platform
      // supervisor will route to whichever process is live. We just
      // won't have the placeholder. Log and carry on.
      warn(`placeholder could not bind port ${PORT} (EADDRINUSE). Assuming a previous instance holds it; continuing without placeholder.`);
      placeholderServer = null;
      return;
    }
    warn(`placeholder server error: ${err && err.message ? err.message : err}`);
  });

  return new Promise((resolve) => {
    try {
      placeholderServer.listen(PORT, () => {
        log(`placeholder HTTP server listening on port ${PORT} (health checks pass while we warm up)`);
        resolve();
      });
    } catch (err) {
      warn(`placeholder .listen() threw: ${err && err.message ? err.message : err}`);
      placeholderServer = null;
      resolve();
    }
  });
}

function stopPlaceholder() {
  return new Promise((resolve) => {
    if (!placeholderServer) {
      resolve();
      return;
    }
    log('closing placeholder server...');
    const srv = placeholderServer;
    placeholderServer = null;
    // `close()` only stops accepting new connections; existing ones
    // would keep the port held. Our placeholder replies immediately
    // and closes each request, so there should be nothing in-flight,
    // but we call `closeAllConnections` to be sure (Node 18.2+). On
    // older runtimes the property is undefined and we skip it.
    try {
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    } catch {
      /* noop */
    }
    srv.close(() => {
      // Give the OS a tick to release the port for the real server.
      setTimeout(resolve, 250);
    });
  });
}

function run(cmd, args) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
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
// Main — async so we can await the placeholder listen/close.
// ---------------------------------------------------------------------
async function main() {
  // Step 0: bind placeholder BEFORE any slow work. Critical for
  // hosts with strict startup health checks.
  setPhase('binding-port');
  await startPlaceholder();

  // Step 1: install deps if the tree is bare.
  const hasNodeModules = exists('node_modules') && exists('node_modules/express');
  if (!hasNodeModules) {
    setPhase('installing-deps', 'npm ci --include=dev');
    if (exists('package-lock.json')) {
      run('npm', ['ci', '--include=dev']);
    } else {
      run('npm', ['install', '--include=dev']);
    }
  } else {
    log('dependencies already installed');
  }

  // Step 2: build web.
  if (!exists('web/dist/index.html')) {
    setPhase('building-web');
    run('npm', ['run', 'build', '--workspace=web']);
  } else {
    log('web/dist already built');
  }

  // Step 3: build server.
  if (!exists('server/dist/index.js')) {
    setPhase('building-server');
    run('npm', ['run', 'build', '--workspace=server']);
  } else {
    log('server/dist already built');
  }

  // Step 4: bake content bundle.
  if (!exists('data/bundle/manifest.json')) {
    if (process.env.GITLAB_REPO2_URL) {
      setPhase('baking-bundle', 'cloning + LFS pull + scene export (slow)');
      // Force full-LFS mode for the child bake process. MUST be set
      // on the parent env (inherited by spawn) rather than inside
      // bake-bundle.ts — ESM imports hoist ahead of top-level
      // statements, so bake's inline assignment runs after config.ts
      // has already captured the old value.
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

  // Step 5: hand off to the real server.
  setPhase('launching-server');
  await stopPlaceholder();

  const serverEntry = path.join(ROOT, 'server', 'dist', 'index.js');
  log(`spawning node ${serverEntry}`);
  const child = spawn(process.execPath, [serverEntry], {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env,
  });

  const forward = (sig) => {
    if (child.exitCode === null) child.kill(sig);
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));

  child.on('exit', (code, signal) => {
    if (signal) {
      log(`server exited via signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

// Top-level crash handler: any unexpected throw above should still
// release the port so a platform supervisor restart isn't stuck on
// a zombie listener.
main().catch(async (err) => {
  console.error(`[aegisgram-start] fatal: ${err && err.stack ? err.stack : err}`);
  try {
    await stopPlaceholder();
  } catch {
    /* noop */
  }
  process.exit(1);
});
