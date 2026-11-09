/**
 * R3 prompt 可编辑化路由（requireManager）：模块列表 / 版本链 / 直改与回滚。
 * skill.* 只读组：拒绝 value 直改，只允许 fromSeq 回滚（回滚把值写回磁盘文件）。
 */
import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { HttpError } from '../../middleware/errorHandler.js';
import type { AuthUser } from '../../services/auth.service.js';
import { db } from '../../db/client.js';
import { assistantPromptModuleVersions } from '../../db/schema.js';
import {
  computePromptDrifts, insertPromptModuleVersion, listPromptModuleDefs, loadPromptModuleOverrides,
  readSkillMeta, resolvePromptModule, writeSkillBodyFromDb,
} from './promptModules.js';

const router = Router();

const SetValueBody = z.object({
  value: z.string().max(100_000).nullish(),
  fromSeq: z.number().int().positive().nullish(),
});

router.get('/', async (_req, res) => {
  const defs = await listPromptModuleDefs();
  const overrides = await loadPromptModuleOverrides();
  const driftByKey = new Map((await computePromptDrifts(defs)).map((d) => [d.key, d]));
  const rows = await Promise.all(defs.map(async (def) => {
    const ov = overrides.get(def.key);
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      readonly: def.readonly,
      hasRow: ov != null,
      seq: ov?.seq ?? null,
      source: ov?.source ?? null,
      value: ov?.value ?? null,
      isDefault: ov == null || ov.value == null,
      text: ov?.value ?? await def.defaultValue(),
      drift: driftByKey.get(def.key) ?? null,
    };
  }));
  res.json(rows);
});

router.get('/:key/versions', async (req, res) => {
  const key = String(req.params.key);
  const rows = await db.select().from(assistantPromptModuleVersions)
    .where(eq(assistantPromptModuleVersions.moduleKey, key))
    .orderBy(desc(assistantPromptModuleVersions.seq));
  res.json(rows);
});

router.post('/:key/value', async (req, res) => {
  const user = req.user as AuthUser;
  const key = String(req.params.key);
  const parsed = SetValueBody.safeParse(req.body ?? {});
  if (!parsed.success) throw new HttpError(400, 'invalid_body', '请求体不合法');
  const { value, fromSeq } = parsed.data;
  const resolved = await resolvePromptModule(key);
  if (!resolved) throw new HttpError(404, 'module_not_found', '提示词模块不存在');

  if (fromSeq != null) {
    // 回滚 = 复制历史行 value 追加新行（回滚也留痕）；base_hash 继承历史行——
    // 恢复的旧值基于它当初写入时的基线，不能伪装成对当前基线的重申。
    const row = (await db.select().from(assistantPromptModuleVersions)
      .where(and(
        eq(assistantPromptModuleVersions.moduleKey, key),
        eq(assistantPromptModuleVersions.seq, fromSeq),
      )).limit(1))[0];
    if (!row) throw new HttpError(404, 'version_not_found', '版本行不存在');
    if (resolved.def.group === 'skill') {
      if (row.value == null) throw new HttpError(400, 'invalid_rollback', 'skill 组不支持回滚到「跟随默认」行');
      const meta = await readSkillMeta(key.slice('skill.'.length));
      if (!meta) throw new HttpError(409, 'skill_missing', 'skill 不存在或未启用');
      await writeSkillBodyFromDb(meta.name, meta.description, row.value);
    }
    const seq = await insertPromptModuleVersion({ moduleKey: key, value: row.value, source: 'rollback', createdByUserId: user.userId, baseHash: row.baseHash ?? null });
    res.json({ seq });
    return;
  }

  if (resolved.def.group === 'skill') throw new HttpError(400, 'readonly_module', 'skill 组只读，只允许 fromSeq 回滚');
  if (value != null && value.trim() === '') throw new HttpError(400, 'invalid_value', '值不能为空白');
  const seq = await insertPromptModuleVersion({ moduleKey: key, value: value ?? null, source: 'manual_edit', createdByUserId: user.userId });
  res.json({ seq });
});

export default router;
