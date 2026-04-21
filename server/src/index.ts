import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { bundleMode, config, getRepo2LocalDir, getGitUrlRewrites } from './config.js';
import { applyUrlRewritesToRepo, syncUnityRepo } from './git/gitSync.js';
import { startLfsProxy } from './git/lfsProxy.js';
import { bulkFetchMaterialsAndTextures } from './git/lazyLfs.js';
import { assetIndex } from './unity/assetIndex.js';
import { bundleIndex } from './bundle/bundleIndex.js';
import { apiRouter } from './api/routes.js';
import { attachMultiplayerHub } from './multiplayer/hub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Absolute path to the built web client (`web/dist/`). We resolve this
 * from the server's compiled location at `server/dist/index.js` so the
 * layout works both in dev (`tsx src/index.ts` from `server/`) and after
 * `npm run build` (Node running `server/dist/index.js`).
 */
const WEB_DIST = path.resolve(__dirname, '..', '..', 'web', 'dist');

async function bootstrap(): Promise<void> {
  const app = express();
  app.use(cors());
  // Larger body limit than the 2 MB Express default because feedback
  // POSTs carry a full-canvas PNG data URL as their `thumbnail`
  // field. Typical snapshots are 100-500 KB; a worst-case 4K frame
  // with lots of detail can push 3-4 MB base64-encoded. 16 MB gives
  // us plenty of head-room without opening a DoS foot-gun — the
  // server is intended for trusted internal use.
  app.use(express.json({ limit: '16mb' }));

  // iframe embedding: the deployed Aegisgram is intended to be loaded
  // inside a parent platform's `<iframe>`. `frame-ancestors` is the
  // modern CSP directive for that; it supersedes `X-Frame-Options` in
  // every browser that cares and lets us whitelist parent origins via
  // env. Notes:
  //   - Empty `iframeOrigins` → `'self'` only (safe default for local).
  //   - `*` as the value (or one of the values) → drop the restriction
  //     entirely by emitting `frame-ancestors *`. This is the escape
  //     hatch for trusted-internal deploys where the platform wraps
  //     the iframe in deeper ancestor chains (e.g. SSO gateways, host
  //     portal pages on a different subdomain). `frame-ancestors`
  //     applies to ALL ancestors, not just the immediate parent, so a
  //     single mismatched ancestor origin is enough to block.
  //   - Otherwise whitespace-separated list of origins is passed through.
  app.use((_req, res, next) => {
    const raw = config.iframeOrigins.trim();
    const tokens = raw.split(/\s+/).filter(Boolean);
    const directive = tokens.includes('*')
      ? `frame-ancestors *`
      : tokens.length > 0
        ? `frame-ancestors 'self' ${tokens.join(' ')}`
        : `frame-ancestors 'self'`;
    res.setHeader('Content-Security-Policy', directive);
    next();
  });

  app.use('/api', apiRouter);

  // Static web client. We only mount the static middleware when the
  // built artifact exists so dev mode (Vite running on its own port)
  // keeps working without a build step. Ordering matters:
  //   1. /api (above) — API routes take precedence over the SPA
  //   2. express.static — serves the real files (JS/CSS/images)
  //   3. SPA fallback — any remaining GET that isn't /api or /ws gets
  //      index.html so React Router handles it client-side.
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^(?!\/api|\/ws).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send('Aegisgram server. See /api/health');
    });
  }

  // Boot the local LFS proxy FIRST (if any rewrites are configured),
  // then persist both `url.<to>.insteadOf` and `http.<from>.proxy`
  // into the repo's local git config — all synchronously, before
  // `httpServer.listen()` accepts traffic. The proxy's port is only
  // known after it binds, and `persistUrlRewritesInRepo` reads it
  // via `getLfsProxyInfo()` to wire up the `http.<URL>.proxy` keys
  // that actually fix the LFS object-download path (see lfsProxy.ts
  // for the full rationale — `insteadOf` alone doesn't cover that).
  if (!bundleMode) {
    try {
      await startLfsProxy(getGitUrlRewrites());
    } catch (err) {
      console.warn('[server] pre-listen startLfsProxy error (non-fatal):', err);
    }
    const repoDir = getRepo2LocalDir();
    if (fs.existsSync(path.join(repoDir, '.git'))) {
      try {
        await applyUrlRewritesToRepo(repoDir);
      } catch (err) {
        console.warn('[server] pre-listen applyUrlRewritesToRepo error (non-fatal):', err);
      }
    }
  }

  // Manually create the HTTP server so the multiplayer WebSocket
  // hub can attach its `upgrade` listener to the same port. Using
  // `app.listen()` also creates a server internally, but grabbing
  // the Server reference from the WS side is awkward; explicit
  // `http.createServer(app)` is the canonical pattern for shared
  // HTTP + WS listeners.
  const httpServer = http.createServer(app);
  attachMultiplayerHub(httpServer);

  // Retry the bind briefly on EADDRINUSE: when this process is
  // launched via `scripts/start.mjs`, the parent has just closed a
  // placeholder HTTP server on the same port. Most OSes release the
  // port immediately, but TIME_WAIT or a lingering accept socket can
  // delay it by a few hundred ms — particularly on Windows under
  // platform supervisors. We retry with backoff up to ~3s before
  // giving up. Any non-EADDRINUSE error propagates as `error`
  // through the standard listener.
  const MAX_LISTEN_RETRIES = 10;
  let listenAttempts = 0;
  const tryListen = (): void => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && listenAttempts < MAX_LISTEN_RETRIES) {
        listenAttempts += 1;
        const delayMs = Math.min(1500, 100 * 2 ** (listenAttempts - 1));
        console.log(
          `[server] port ${config.port} busy (attempt ${listenAttempts}/${MAX_LISTEN_RETRIES}); ` +
            `retrying in ${delayMs}ms`,
        );
        setTimeout(tryListen, delayMs);
        return;
      }
      console.error(`[server] listen failed: ${err.message}`);
      process.exit(1);
    });
    httpServer.listen(config.port, () => {
      console.log(
        `[server] listening on http://localhost:${config.port} ` +
          `(${bundleMode ? 'bundle' : 'live'} mode)`,
      );
    });
  };
  tryListen();

  // Background bootstrap: either load the pre-baked bundle (deploy
  // target, fast and offline) or sync + index Project Aegis (local
  // dev with GitLab access). Kept off the critical path so the port
  // is accepting connections immediately; health check reports when
  // content is ready.
  (async () => {
    try {
      if (bundleMode) {
        await bundleIndex.load();
      } else {
        // If the repo already exists on disk (warm deploy / restart),
        // build the asset index FIRST so the server can serve scenes
        // immediately, then sync in the background. This avoids the
        // multi-minute LFS fetch blocking every request on startup.
        const repoDir = getRepo2LocalDir();
        const repoExists = fs.existsSync(path.join(repoDir, '.git'));

        if (repoExists) {
          console.log('[server] repo already on disk — building asset index first, syncing in background');
          await assetIndex.build();
          // Kick off the bulk prefetch for .mat + image pointers
          // right after the index is first available. These files
          // are small and shared across scenes — downloading them
          // once at startup beats the per-scene lazy-fetch penalty
          // (which otherwise shows up as magenta materials for the
          // first few seconds of every new scene open).
          bulkFetchMaterialsAndTextures(repoDir, assetIndex).catch((err) => {
            console.warn('[server] bulk LFS prefetch error (non-fatal):', err);
          });
          // Fire-and-forget: sync will update the repo and rebuild
          // the index when done, picking up any upstream changes.
          syncUnityRepo()
            .then(async (result) => {
              console.log(
                `[server] background git sync: ${result.action}${result.head ? ` @ ${result.head}` : ''}`,
              );
              await assetIndex.build();
              console.log('[server] asset index rebuilt after sync');
              // Re-run bulk prefetch after sync so any new pointers
              // introduced by the pull get picked up too.
              bulkFetchMaterialsAndTextures(repoDir, assetIndex).catch((err) => {
                console.warn('[server] post-sync bulk LFS prefetch error (non-fatal):', err);
              });
            })
            .catch((err) => {
              console.warn('[server] background sync error (non-fatal):', err);
            });
        } else {
          // Cold start: no repo at all — must clone + fetch text LFS
          // before we can build the index. This is the slow path but
          // only happens on the very first deploy.
          const result = await syncUnityRepo();
          console.log(
            `[server] git sync: ${result.action}${result.head ? ` @ ${result.head}` : ''}`,
          );
          await assetIndex.build();
          bulkFetchMaterialsAndTextures(repoDir, assetIndex).catch((err) => {
            console.warn('[server] bulk LFS prefetch error (non-fatal):', err);
          });
        }
      }
    } catch (err) {
      console.error('[server] bootstrap error:', err);
    }
  })();
}

bootstrap().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
