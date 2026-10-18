/**
 * assistant_skills 全局共享 CRUD（系统设置页管理；所有空间线程加载全量启用 skills）。
 * 挂载于 /api/assistant/skills，router.ts 处 requireManager 保护。
 *
 * 一律委托 skillsService（校验 + 落库共用层），与空间助手 manage_skill 工具同规则。
 * 无 scope：skills 是平台级全局共享（所有项目同一个技能库），DB 无归属列。
 */
import { Router } from 'express';
import {
  createSkill,
  deleteSkill,
  listSkills,
  updateSkill,
} from './skillsService.js';

export const skillsRoute = Router();

skillsRoute.get('/', async (req, res) => {
  const q = req.query;
  const enabled = q.enabled === 'true' ? true : q.enabled === 'false' ? false : undefined;
  res.json(await listSkills(enabled));
});

skillsRoute.post('/', async (req, res) => {
  res.status(201).json(await createSkill(req.body as Record<string, unknown>));
});

skillsRoute.patch('/:id', async (req, res) => {
  res.json(await updateSkill(req.params.id, req.body as Record<string, unknown>));
});

skillsRoute.delete('/:id', async (req, res) => {
  await deleteSkill(req.params.id);
  res.status(204).end();
});