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
import { buildTemplateWorkbook, parseImportWorkbook } from '../services/datasetImport.service.js';

export const datasetsRoute = Router();

const SaveBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  columns: z.array(z.object({ name: z.string(), sensitive: z.boolean().optional() })),
  rows: z.array(z.object({ disabled: z.boolean().optional(), cells: z.record(z.unknown()) })),
  renames: z.record(z.string()).optional(),
});

/** The dataset belongs to the given project (projectId match + project visible), otherwise 404. */
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

// Must be registered before GET /:dsId: Express matches in order, otherwise template would be treated as a dsId.
datasetsRoute.get('/projects/:projectId/datasets/template', async (req, res) => {
  await assertProjectVisible(req.params.projectId!, req.user!);
  const raw = typeof req.query.columns === 'string' ? req.query.columns : '';
  const columns = raw.split(',').map((c) => c.trim()).filter(Boolean);
  const buf = await buildTemplateWorkbook(columns.length > 0 ? columns : undefined);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="dataset-template.xlsx"');
  res.send(buf);
});

datasetsRoute.post('/projects/:projectId/datasets/import-parse', async (req, res) => {
  await assertProjectVisible(req.params.projectId!, req.user!);
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf)) throw new HttpError(400, 'bad_request', 'expected octet-stream body');
  res.json(await parseImportWorkbook(buf));
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
