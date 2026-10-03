import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireManager } from '../middleware/auth.js';
import { userService, type CallerScope } from '../services/user.service.js';

const router = Router();
router.use(requireAuth);

function callerOf(req: { user?: { userId: string; managerOrgPaths?: string[] } }): CallerScope {
  return { userId: req.user!.userId, managerOrgPaths: req.user!.managerOrgPaths ?? [] };
}

function parsePaging(query: Record<string, unknown>) {
  return {
    page: parseInt(query.page as string) || 1,
    limit: Math.min(parseInt(query.limit as string) || 20, 100),
  };
}

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().optional(),
  orgId: z.string().uuid().optional(),
  includeSubtree: z.enum(['true', 'false']).optional(),
  excludeOrgId: z.string().uuid().optional(),
});

router.get('/', requireManager, async (req, res) => {
  const q = ListQuery.parse(req.query);
  try {
    const result = await userService.listUsers(callerOf(req), {
      orgId: q.orgId,
      includeSubtree: q.includeSubtree === 'true',
      q: q.q,
      excludeOrgId: q.excludeOrgId,
      page: q.page ?? 1,
      limit: q.limit ?? 20,
    });
    res.json(result);
  } catch (err) {
    if ((err as Error).message === 'FORBIDDEN_ORG') {
      res.status(403).json({ error: 'Forbidden', detail: '无权访问该组织' });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

const UserIdParams = z.object({ userId: z.string().uuid() });

router.get('/:userId/projects', async (req, res) => {
  const { userId } = UserIdParams.parse(req.params);
  const { page, limit } = parsePaging(req.query);
  try {
    const result = await userService.getUserProjects(callerOf(req), userId, { page, limit });
    res.json(result);
  } catch (err) {
    if ((err as Error).message === 'USER_NOT_FOUND' || (err as Error).message === 'USER_NOT_AUTHZ') {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:userId', async (req, res) => {
  const { userId } = UserIdParams.parse(req.params);
  try {
    const result = await userService.getUserDetail(callerOf(req), userId);
    res.json(result);
  } catch (err) {
    if ((err as Error).message === 'USER_NOT_FOUND' || (err as Error).message === 'USER_NOT_AUTHZ') {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete('/:userId', async (req, res) => {
  const { userId } = UserIdParams.parse(req.params);
  if (userId === req.user!.userId) {
    res.status(400).json({ error: 'Cannot delete yourself' });
    return;
  }
  try {
    await userService.disableUser(callerOf(req), userId);
    res.status(204).end();
  } catch (err) {
    if ((err as Error).message === 'USER_NOT_FOUND' || (err as Error).message === 'USER_NOT_AUTHZ') {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

const UpdateUserBody = z.object({
  displayName: z.string().min(1).max(100).optional(),
  email: z.union([z.string().email(), z.null()]).optional(),
  languagePreference: z.enum(['zh-CN', 'en-US']).optional(),
});

router.patch('/:userId', async (req, res) => {
  const { userId } = UserIdParams.parse(req.params);
  const body = UpdateUserBody.parse(req.body);
  try {
    const updated = await userService.updateUser(callerOf(req), userId, body);
    res.json(updated);
  } catch (err) {
    if ((err as Error).message === 'USER_NOT_FOUND' || (err as Error).message === 'USER_NOT_AUTHZ') {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      res.status(409).json({ error: 'Email already in use by another user' });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:userId/reset-password', async (req, res) => {
  const { userId } = UserIdParams.parse(req.params);
  if (userId === req.user!.userId) {
    res.status(400).json({ error: 'Cannot reset your own password' });
    return;
  }
  try {
    const temporaryPassword = await userService.resetUserPassword(callerOf(req), userId);
    res.json({ temporaryPassword });
  } catch (err) {
    if ((err as Error).message === 'USER_NOT_FOUND' || (err as Error).message === 'USER_NOT_AUTHZ') {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;