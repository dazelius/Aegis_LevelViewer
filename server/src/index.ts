import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { bundleMode, config } from './config.js';
import { syncUnityRepo } from './git/gitSync.js';
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
  // every browser that cares and lets us whitelist multiple parent
  // origins via env. Empty `iframeOrigins` resolves to `'self'` only,
  // which keeps local dev safe by default.
  app.use((_req, res, next) => {
    const extraOrigins = config.iframeOrigins.trim();
    const directive = extraOrigins
      ? `frame-ancestors 'self' ${extraOrigins}`
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

  // Manually create the HTTP server so the multiplayer WebSocket
  // hub can attach its `upgrade` listener to the same port. Using
  // `app.listen()` also creates a server internally, but grabbing
  // the Server reference from the WS side is awkward; explicit
  // `http.createServer(app)` is the canonical pattern for shared
  // HTTP + WS listeners.
  const httpServer = http.createServer(app);
  attachMultiplayerHub(httpServer);
  httpServer.listen(config.port, () => {
    console.log(
      `[server] listening on http://localhost:${config.port} ` +
        `(${bundleMode ? 'bundle' : 'live'} mode)`,
    );
  });

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
        const result = await syncUnityRepo();
        console.log(
          `[server] git sync: ${result.action}${result.head ? ` @ ${result.head}` : ''}`,
        );
        await assetIndex.build();
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
