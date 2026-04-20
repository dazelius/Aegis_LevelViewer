import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { syncUnityRepo } from './git/gitSync.js';
import { assetIndex } from './unity/assetIndex.js';
import { apiRouter } from './api/routes.js';

async function bootstrap(): Promise<void> {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.use('/api', apiRouter);

  app.get('/', (_req, res) => {
    res.type('text/plain').send('Aegis Level Viewer server. See /api/health');
  });

  app.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
  });

  // Background: sync repo then build asset index. Don't block the port from opening.
  (async () => {
    try {
      const result = await syncUnityRepo();
      console.log(`[server] git sync: ${result.action}${result.head ? ` @ ${result.head}` : ''}`);
      await assetIndex.build();
    } catch (err) {
      console.error('[server] bootstrap error:', err);
    }
  })();
}

bootstrap().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
