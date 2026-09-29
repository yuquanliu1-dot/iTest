import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errorHandler.js';
import { mockExecuteCase } from '../execute/mock.js';

export const executeRoute = Router();

const Body = z.object({ caseId: z.string().uuid() });

executeRoute.post('/cases/:caseId/execute', async (req, res) => {
  const { caseId } = Body.parse({ caseId: req.params.caseId });
  if (caseId !== req.params.caseId) throw new HttpError(400, 'bad_request', 'caseId mismatch');
  const { reportId } = await mockExecuteCase(caseId);
  res.json({ reportId });
});
