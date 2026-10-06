import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errorHandler.js';
import { runCase } from '../execute/runCase.js';
import { DatasetConfigError } from '../services/datasets.service.js';
import { assertCaseVisible } from '../services/projectAccess.js';

export const executeRoute = Router();

const Body = z.object({ caseId: z.string().uuid() });

executeRoute.post('/cases/:caseId/execute', async (req, res) => {
  const { caseId } = Body.parse({ caseId: req.params.caseId });
  if (caseId !== req.params.caseId) throw new HttpError(400, 'bad_request', 'caseId mismatch');
  await assertCaseVisible(caseId, req.user!);
  try {
    const r = await runCase(caseId);
    res.json({ reportId: r.reportId, ...(r.reportIds ? { reportIds: r.reportIds } : {}) });
  } catch (e) {
    if (e instanceof Error && e.message === 'case not found') {
      throw new HttpError(404, 'not_found', 'case not found');
    }
    if (e instanceof DatasetConfigError) {
      throw new HttpError(400, 'dataset_config_error', e.message);
    }
    throw e;
  }
});