/**
 * dump_cases_payload：把当前版本指定范围的用例数据落成临时 JSON 文件（export-cases skill 的取数步骤）。
 * 与列表页旧导出共用 services/caseExport.service 的查库与树构建——内容不经 LLM 之手，零幻觉。
 * AI 拿到 payloadPath 后调 run_skill_script（export-cases/scripts/export_cases.py）渲染 xmind/docx。
 * 范围：caseIds（显式集合，须 ∈ 当前版本）> groupId > keyword > 全版本。
 * payload 文件不主动清理（换格式重试友好），随容器 /tmp 生命周期回收。
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { testCases } from '../../../db/schema.js';
import { searchCasesInVersion } from '../../../services/cases.service.js';
import { loadExportCases, buildExportPayload } from '../../../services/caseExport.service.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

export function buildDumpCasesPayloadTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'dump_cases_payload',
    description:
      '把当前版本指定范围的用例数据（含步骤/预置条件/预期结果）导出为临时 payload 文件，供 export-cases 技能脚本渲染成 XMind/Word 文件。范围四选一：caseIds 优先，其次 groupId，再次 keyword，都缺省=当前版本全部用例。返回 payloadPath 与用例数。',
    parameters: Type.Object({
      caseIds: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
      groupId: Type.Optional(Type.String()),
      keyword: Type.Optional(Type.String({ maxLength: 200 })),
    }),
    promptGuidelines: [
      '导出用例的取数步骤：先确认范围（全版本/某分组/按关键词/指定用例），再调本工具拿 payloadPath，然后调 export-cases 技能的 scripts/export_cases.py 渲染文件。',
      '不要在对话里复述导出的用例内容，简单说明导出范围与用例数即可；也不要把 payload 文件的内容抄进任何参数，只传 payloadPath。',
      '同一份 payloadPath 可重复用于不同 format（xmind/docx）的渲染调用，不必重复 dump。',
    ],
    execute: async (input) => {
      const v = input as { caseIds?: string[]; groupId?: string; keyword?: string };
      let caseIds: string[];
      if (Array.isArray(v.caseIds) && v.caseIds.length > 0) {
        const rows = await db
          .select({ id: testCases.id, versionId: testCases.versionId })
          .from(testCases)
          .where(inArray(testCases.id, v.caseIds.slice(0, 500)));
        const ok = rows.filter((r) => r.versionId === ctx.versionId).map((r) => r.id);
        if (ok.length === 0) return { ok: false, error: '给定的用例都不在当前版本内' };
        caseIds = ok;
      } else {
        const rows = await searchCasesInVersion(ctx.versionId, { groupId: v.groupId, keyword: v.keyword, limit: 1000 });
        caseIds = rows.map((r) => r.id);
      }
      if (caseIds.length === 0) return { ok: false, error: '没有匹配的用例，未生成 payload' };
      const cases = await loadExportCases(caseIds);
      if (cases.length === 0) return { ok: false, error: '没有匹配的用例，未生成 payload' };
      const payload = buildExportPayload(cases);
      const payloadPath = join(tmpdir(), `itest-export-payload-${randomUUID()}.json`);
      await writeFile(payloadPath, JSON.stringify(payload), 'utf8');
      return {
        ok: true,
        data: `payload 已生成：${payloadPath}（${payload.count} 条用例，baseName=${payload.baseName}）。下一步调 run_skill_script(skillName="export-cases", script="scripts/export_cases.py", args=['{"payload":"${payloadPath}","format":"xmind 或 docx"}'])`,
      };
    },
  };
}
