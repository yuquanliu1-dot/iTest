import express from 'express';
import { join } from 'node:path';
import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { settingsRoute } from './routes/settings.js';
import { requirementsRoute } from './routes/requirements.js';
import { casesRoute } from './routes/cases.js';
import { stepsRoute } from './routes/steps.js';
import { projectsRoute } from './routes/projects.js';
import { groupsRoute } from './routes/groups.js';
import { reportsRoute } from './routes/reports.js';
import { agentRunsRoute } from './routes/agentRuns.js';
import { recorderRoute } from './routes/recorder.js';
import { executeRoute } from './routes/execute.js';
import { attachRecorderWs } from './recorder/ws.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/screenshots', express.static(join(process.cwd(), 'screenshots')));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/settings', settingsRoute);
app.use('/api/requirements', requirementsRoute);
app.use('/api/projects/:projectId/requirements', requirementsRoute);
app.use('/api/projects', projectsRoute);
app.use('/api/groups', groupsRoute);
app.use('/api/cases', casesRoute);
app.use('/api/cases', stepsRoute);
app.use('/api', executeRoute);
app.use('/api/reports', reportsRoute);
app.use('/api/agent-runs', agentRunsRoute);
app.use('/api/recorder', recorderRoute);
app.use(errorHandler);

const port = Number(process.env.API_PORT ?? 54321);
const server = app.listen(port, '127.0.0.1', () => {
  logger.info({ port }, 'api listening on 127.0.0.1');
});
attachRecorderWs(server);