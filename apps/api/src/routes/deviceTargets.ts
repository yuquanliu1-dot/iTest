import { Router } from 'express';
import { z } from 'zod';
import { assertProjectVisible } from '../services/projectAccess.js';
import {
  createDeviceTarget, deleteDeviceTarget, getDeviceTarget, listDeviceTargets, updateDeviceTarget,
} from '../services/deviceTargets.service.js';

export const deviceTargetsRoute = Router();

const SaveBody = z.object({
  name: z.string().min(1).max(128),
  mobileOs: z.enum(['ios', 'android']),
  deviceRef: z.string().min(1).max(128),
  appBundleId: z.string().max(256).nullable().optional(),
  appPath: z.string().nullable().optional(),
  launchArgs: z.array(z.string()).max(50).optional(),
});

deviceTargetsRoute.get('/projects/:projectId/device-targets', async (req, res) => {
  await assertProjectVisible(req.params.projectId!, req.user!);
  res.json(await listDeviceTargets(req.params.projectId!));
});

deviceTargetsRoute.post('/projects/:projectId/device-targets', async (req, res) => {
  await assertProjectVisible(req.params.projectId!, req.user!);
  res.json(await createDeviceTarget(req.params.projectId!, SaveBody.parse(req.body)));
});

deviceTargetsRoute.get('/projects/:projectId/device-targets/:id', async (req, res) => {
  const { projectId, id } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  const target = await getDeviceTarget(id!);
  if (!target || target.projectId !== projectId) {
    res.status(404).json({ error: 'not_found', message: 'device target not found' });
    return;
  }
  res.json(target);
});

deviceTargetsRoute.put('/projects/:projectId/device-targets/:id', async (req, res) => {
  const { projectId, id } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  const existing = await getDeviceTarget(id!);
  if (!existing || existing.projectId !== projectId) {
    res.status(404).json({ error: 'not_found', message: 'device target not found' });
    return;
  }
  res.json(await updateDeviceTarget(id!, SaveBody.parse(req.body)));
});

deviceTargetsRoute.delete('/projects/:projectId/device-targets/:id', async (req, res) => {
  const { projectId, id } = req.params;
  await assertProjectVisible(projectId!, req.user!);
  const existing = await getDeviceTarget(id!);
  if (!existing || existing.projectId !== projectId) {
    res.status(404).json({ error: 'not_found', message: 'device target not found' });
    return;
  }
  await deleteDeviceTarget(id!);
  res.json({ ok: true });
});