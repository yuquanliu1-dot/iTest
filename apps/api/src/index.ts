import express from 'express';
import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { settingsRoute } from './routes/settings.js';
import { requirementsRoute } from './routes/requirements.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/settings', settingsRoute);
app.use('/api/requirements', requirementsRoute);
app.use(errorHandler);

const port = Number(process.env.API_PORT ?? 54321);
app.listen(port, '127.0.0.1', () => {
  logger.info({ port }, 'api listening on 127.0.0.1');
});