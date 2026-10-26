/**
 * export_cases_xmind：把当前版本的用例导出为 XMind 文件，经下载卡推送给用户。
 * 与列表页共用 services/xmindExport.service 的树构建/序列化/打包——内容不经 LLM 之手，零幻觉。
 * 范围：caseIds（显式集合，须 ∈ 当前版本）> groupId > keyword > 全版本。
 */
import { Type } from '@earendil-works/pi-ai';
import { inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { testCases } from '../../../db/schema.js';
import { searchCasesInVersion } from '../../../services/cases.service.js';
import { loadExportCases, buildXmindBuffer } from '../../../services/xmindExport.service.js';
import { registerArtifact } from '../artifacts.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';

export function buildExportCasesXmindTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'export_cases_xmind',
    description:
      '把当前版本的用例导出为 XMind 思维导图文件（层级：版本→分组→用例→预置条件/测试步骤/预期结果），生成后下载卡推送给用户点击下载。用户要交付文档/评审材料/汇总用例时使用。范围四选一：caseIds 优先，其次 groupId，再次 keyword，都缺省=当前版本全部用例。',
    parameters: Type.Object({
      caseIds: Type.Optional(Type.Array(Type.String(), { maxItems: 500 })),
      groupId: Type.Optional(Type.String()),
      keyword: Type.Optional(Type.String({ maxLength: 200 })),
      title: Type.Optional(Type.String({ maxLength: 200, description: '根节点标题，缺省用版本名' })),
    }),
    promptGuidelines: [
      '导出内容直接来自库内数据（标题/步骤 instruction/预期结果），不要在对话里复述全部用例内容，简单说明导出范围与用例数即可。',
      '用户没说范围时先确认：全版本 / 某分组 / 按关键词。确认后调用本工具。',
    ],
    execute: async (input) => {
      const v = input as { caseIds?: string[]; groupId?: string; keyword?: string; title?: string };
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
      if (caseIds.length === 0) return { ok: false, error: '没有匹配的用例，未生成文件' };
      const cases = await loadExportCases(caseIds);
      if (cases.length === 0) return { ok: false, error: '没有匹配的用例，未生成文件' };
      const { buffer, filename } = await buildXmindBuffer(cases, v.title || undefined);
      const token = await registerArtifact(buffer, filename, ctx.threadId);
      ctx.emit({ type: 'artifact', token, name: filename, size: buffer.length, count: cases.length });
      return { ok: true, data: `已生成「${filename}」（${cases.length} 条用例），下载卡已推送给用户` };
    },
  };
}
