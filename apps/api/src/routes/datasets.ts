import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { datasets } from '../db/schema.js';
import { HttpError } from '../middleware/errorHandler.js';
import { assertProjectVisible } from '../services/projectAccess.js';
import type { AuthUser } from '../services/auth.service.js';
import {
  createDataset,
  datasetUsage,
  deleteDataset,
  getDataset,
  listDatasets,
  updateDataset,
} from '../services/datasets.service.js';

export const datasetsRoute = Router();

const SaveBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  columns: z.array(z.object({ name: z.string(), sensitive: z.boolean().optional() })),
  rows: z.array(z.object({ disabled: z.boolean().optional(), cells: z.record(z.unknown()) })),
  renames: z.record(z.string()).optional(),
});

/** 数据集属指定项目（projectId 匹配 + 项目可见），否则 404。 */
async function assertDsInProject(dsId: string, projectId: string, user: AuthUser): Promise<void> {
  const row = (await db
    .select({ pid: datasets.projectId })
    .from(datasets)
    .where(and(eq(datasets.id, dsId), eq(datasets.projectId, projectId)))
    .limit(1))[0];
  if (!row) throw new HttpError(404, 'not_found', 'dataset not found');
  await assertProjectVisible(projectId, user);
}

datasetsRoute.get('/projects/:projectId/datasets', async (req, res) => {
  await assertProjectVisible(req.params.projectId!, req.user!);
  res.json(await listDatasets(req.params.projectId!));
});

datasetsRoute.post('/projects/:projectId/datasets', async (req, res) => {
  await assertProjectVisible(req.params.projectId!, req.user!);
  const body = SaveBody.parse(req.body);
  res.json(await createDataset(req.params.projectId!, body, req.user!.userId));
});

datasetsRoute.get('/projects/:projectId/datasets/:dsId', async (req, res) => {
  const { projectId, dsId } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  await assertDsInProject(dsId!, projectId!, req.user!);
  const detail = await getDataset(dsId!);
  if (!detail) throw new HttpError(404, 'not_found', 'dataset not found');
  res.json(detail);
});

datasetsRoute.put('/projects/:projectId/datasets/:dsId', async (req, res) => {
  const { projectId, dsId } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  await assertDsInProject(dsId!, projectId!, req.user!);
  const body = SaveBody.parse(req.body);
  res.json(await updateDataset(dsId!, body));
});

datasetsRoute.delete('/projects/:projectId/datasets/:dsId', async (req, res) => {
  const { projectId, dsId } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  await assertDsInProject(dsId!, projectId!, req.user!);
  const usage = await datasetUsage(dsId!);
  if (req.query.confirm !== 'true') {
    res.json({ ok: false, requiresConfirm: true, caseCount: usage.caseCount });
    return;
  }
  await deleteDataset(dsId!);
  res.json({ ok: true, caseCount: usage.caseCount });
});
