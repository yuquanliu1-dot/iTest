import express from 'express';
import { join } from 'node:path';
import { logger } from './logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { settingsRoute } from './routes/settings.js';
import { requirementsRoute } from './routes/requirements.js';
import { casesRoute } from './routes/cases.js';
import { stepsRoute } from './routes/steps.js';
import { projectsRoute } from './routes/projects.js';
import { productLinesRoute } from './routes/productLines.js';
import { overviewRoute } from './routes/overview.js';
import { groupsRoute } from './routes/groups.js';
import { reportsRoute } from './routes/reports.js';
import { plansRoute } from './routes/plans.js';
import { recorderRoute } from './routes/recorder.js';
import { executeRoute } from './routes/execute.js';
import { planRunsRoute } from './routes/planRuns.js';
import { explorationsRoute } from './routes/explorations.js';
import { executionsRoute } from './routes/executions.js';
import { attachmentsRoute } from './routes/attachments.js';
import { environmentsRoute } from './routes/environments.js';
import { datasetsRoute } from './routes/datasets.js';
import { deviceTargetsRoute } from './routes/deviceTargets.js';
import { projectVersionsRoute } from './routes/projectVersions.js';
import { secretsRoute } from './routes/secrets.js';
import { attachRecorderWs } from './recorder/ws.js';
import { startExecutionWorker } from './scheduler/execWorker.js';
import { startRcaWorker } from './scheduler/rcaWorker.js';
import { startTrajectoryWorker } from './scheduler/trajectoryWorker.js';
import { startScheduler } from './scheduler/index.js';
import { startExplorationSweeper } from './scheduler/explorationSweeper.js';
import { authRoute } from './routes/auth.js';
import { organizationsRoute } from './routes/organizations.js';
import { scenariosRoute } from './routes/scenarios.js';
import { tagsRoute } from './routes/tags.js';
import usersRoute from './routes/users.js';
import assignmentsRoute from './routes/assignments.js';
import { spaceRoute, ASSISTANT_JSON_BODY_LIMIT } from './pi/space/router.js';
import { requireAuth } from './middleware/auth.js';
import { migrateLegacyLlmChannels } from './db/migrateLlmChannels.js';

const app = express();
app.use(express.raw({ type: 'application/octet-stream', limit: '60mb' }));
// Assistant message bodies carry base64 image attachments (react-pi inlines composer attachments into input.attachments);
// the global 2mb limit would 413 a single normal screenshot. Mounting before /api/assistant is enough to override —
// body-parser uses 'body' in req as the already-parsed marker, so the later global parser skips the same request and other routes are unaffected.
// The limit is computed by ASSISTANT_JSON_BODY_LIMIT from the image size cap and image count, not an arbitrary constant.
app.use('/api/assistant', express.json({ limit: ASSISTANT_JSON_BODY_LIMIT }));
app.use(express.json({ limit: '2mb' }));
app.use('/screenshots', express.static(join(process.cwd(), 'screenshots')));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoute);
// Blanket login guard: /api/auth's public endpoints (login/change-password) sit before it; the extension self-auth endpoint is allowed through inside the guard
app.use('/api', requireAuth);
app.use('/api/organizations', organizationsRoute);
app.use('/api/settings', settingsRoute);
app.use('/api/users', usersRoute);
app.use('/api/requirements', requirementsRoute);
app.use('/api/projects/:projectId/requirements', requirementsRoute);
app.use('/api/requirements/:requirementId/scenarios', scenariosRoute);
app.use('/api/scenarios', scenariosRoute);
app.use('/api/projects', projectsRoute);
app.use('/api/product-lines', productLinesRoute);
app.use('/api/projects', overviewRoute);
app.use('/api/projects', assignmentsRoute);
app.use('/api/groups', groupsRoute);
app.use('/api/cases', casesRoute);
app.use('/api/cases', stepsRoute);
app.use('/api/cases', attachmentsRoute);
app.use('/api/cases', secretsRoute);
app.use('/api', environmentsRoute);
app.use('/api', datasetsRoute);
app.use('/api', deviceTargetsRoute);
app.use('/api', projectVersionsRoute);
app.use('/api', executeRoute);
app.use('/api/reports', reportsRoute);
app.use('/api/projects/:projectId/plans', plansRoute);
app.use('/api/plans', plansRoute);
app.use('/api/projects/:projectId/tags', tagsRoute);
app.use('/api/plan-runs', planRunsRoute);
app.use('/api/explorations', explorationsRoute);
app.use('/api/executions', executionsRoute);
app.use('/api/recorder', recorderRoute);
app.use('/api/assistant', spaceRoute);
app.use(errorHandler);

const port = Number(process.env.API_PORT ?? 54321);
const host = process.env.API_HOST ?? '127.0.0.1';

async function bootstrap() {
  // Legacy single channel (5 llm_* single keys) → multi-channel structure: migration runs automatically on release, old keys deleted afterwards.
  // Failure does not block startup: LLM calls each report "no LLM channel configured yet"; retried on the next startup.
  try {
    const r = await migrateLegacyLlmChannels();
    if (r.migrated || r.legacyRemoved) {
      logger.info({ ...r }, 'LLM 渠道迁移完成');
    }
  } catch (e) {
    logger.error({ err: e }, 'LLM 渠道迁移失败（不影响启动，下次启动重试）');
  }

  const server = app.listen(port, host, () => {
    logger.info({ port, host }, 'api listening');
    void startExecutionWorker();
    void startRcaWorker();
    void startTrajectoryWorker();
    void startScheduler();
    // Exploration session watchdog: declares dead the zombied sessions where "the executor is gone but the status is stuck at running"
    void startExplorationSweeper();
  });
  attachRecorderWs(server);
}

void bootstrap();