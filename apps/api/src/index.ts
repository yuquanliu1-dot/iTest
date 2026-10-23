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
import { authRoute } from './routes/auth.js';
import { organizationsRoute } from './routes/organizations.js';
import { scenariosRoute } from './routes/scenarios.js';
import { tagsRoute } from './routes/tags.js';
import usersRoute from './routes/users.js';
import assignmentsRoute from './routes/assignments.js';
import { spaceRoute, ASSISTANT_JSON_BODY_LIMIT } from './pi/space/router.js';
import { requireAuth } from './middleware/auth.js';

const app = express();
app.use(express.raw({ type: 'application/octet-stream', limit: '60mb' }));
// 助手消息体带 base64 图片附件(react-pi 把 composer 附件内联进 input.attachments),
// 全局 2mb 会让一张正常截图直接 413。挂在 /api/assistant 前即可覆盖——body-parser
// 以 'body' in req 为已解析标记,后到的全局解析器对同一请求跳过,其余路由不受影响。
// 上限由 ASSISTANT_JSON_BODY_LIMIT 从图片上限与张数算得,不是拍脑袋的常数。
app.use('/api/assistant', express.json({ limit: ASSISTANT_JSON_BODY_LIMIT }));
app.use(express.json({ limit: '2mb' }));
app.use('/screenshots', express.static(join(process.cwd(), 'screenshots')));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoute);
// 毯子登录守卫：/api/auth 的公开端点（login/change-password）在其之前；扩展自鉴权端点在守卫内放行
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
app.use('/api/executions', executionsRoute);
app.use('/api/recorder', recorderRoute);
app.use('/api/assistant', spaceRoute);
app.use(errorHandler);

const port = Number(process.env.API_PORT ?? 54321);
const host = process.env.API_HOST ?? '127.0.0.1';
const server = app.listen(port, host, () => {
  logger.info({ port, host }, 'api listening');
  void startExecutionWorker();
  void startRcaWorker();
});
attachRecorderWs(server);