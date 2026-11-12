/**
 * manage_datasets: project dataset read (masked row values included) / modify (full replacement, blocking confirmation) / delete (blocking confirmation).
 * Sensitive cells go out as {__masked:true}; update follows the web PUT semantics — untouched sensitive cells must be passed back with that placeholder
 * as-is (old ciphertext retained by row index), column renames must declare renames, or the ciphertext is silently cleared or a 400 results.
 * Creating a new dataset still goes through stage_dataset (draft-area preview → check-off → persistence); this tool only manages persisted datasets.
 */
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import * as svc from '../../../services/datasets.service.js';
import { HttpError } from '../../../middleware/errorHandler.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { emitStage } from './stage.js';
import { requestConfirmation } from '../confirm.js';
import { st, type StLang } from '../../../i18n.js';
import { aiLangFrom } from '../../../agent/langDirective.js';

const Actions = z.object({
  action: z.enum(['list', 'get', 'update', 'delete']),
  datasetId: z.string().uuid().optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  columns: z.array(z.object({ name: z.string(), sensitive: z.boolean().optional() })).optional(),
  rows: z.array(z.object({ disabled: z.boolean().optional(), cells: z.record(z.unknown()) })).optional(),
  /** Column rename declaration (old name → new name): required when renaming sensitive columns, or the old ciphertext won't match the new name. */
  renames: z.record(z.string()).optional(),
});

/** Context budget for cells/row values: strings over 1000 chars are truncated ({__masked:true} placeholders kept as-is). */
function clipCell(v: unknown): unknown {
  return typeof v === 'string' && v.length > 1000 ? `${v.slice(0, 1000)}…` : v;
}

/** Row-value shaping: get returns only the first 10 rows (truncated is flagged beyond that), cell strings are clipped; sensitive cells keep the {__masked:true} placeholder. */
function shapeRows(rows: Array<{ disabled?: boolean; cells: Record<string, unknown> }>) {
  const over = rows.length > 10;
  const shaped = rows.slice(0, 10).map((r) => ({
    ...(r.disabled ? { disabled: true } : {}),
    cells: Object.fromEntries(Object.entries(r.cells).map(([k, v]) => [k, clipCell(v)])),
  }));
  return { rows: shaped, ...(over ? { truncated: true } : {}) };
}

export function buildDatasetsTools(ctx: SpaceToolsContext): ToolExecutor[] {
  return [
    {
      name: 'manage_datasets',
      description:
        '已落库数据集管理。action=list(项目数据集清单:列/敏感标记/行数)| get(datasetId,详情含脱敏行值:敏感格为 {"__masked":true} 占位,行值最多回 10 行)| update(datasetId 全量替换 name/description/columns/rows,需用户确认;未改动的敏感格必须原样回传 {"__masked":true} 占位,列改名须带 renames)| delete(datasetId,需用户确认,绑定用例自动解绑)。新建数据集走 stage_dataset(草稿区勾选落库)。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('list'), Type.Literal('get'), Type.Literal('update'), Type.Literal('delete')]),
        datasetId: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        columns: Type.Optional(Type.Array(Type.Object({
          name: Type.String(),
          sensitive: Type.Optional(Type.Boolean()),
        }))),
        rows: Type.Optional(Type.Array(Type.Object({
          disabled: Type.Optional(Type.Boolean()),
          cells: Type.Record(Type.String(), Type.Unknown()),
        }))),
        renames: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      promptGuidelines: [
        'update 是全量替换(web PUT 同款):先 get 拿当前全量,在此基础上改,原样回传未改动部分;只回传改动行会把其余行清空。',
        '敏感格改值时直接给新明文(落库自动加密);没改的敏感格必须原样回传 {"__masked":true},按行下标沿用旧密文。',
        '列改名(尤其敏感列)必须同时带 renames={"旧列名":"新列名"},否则该列密文会静默清空。',
        'update/delete 会向用户发确认卡;被拒或超时视为放弃,不要重试。',
        '数据集列名即回放初始变量 {{列名}};看某用例可用变量用 manage_cases get 返回的 dataset.columns。',
      ],
      execute: async (input) => {
        const lang: StLang = aiLangFrom(ctx.lang);
        let v: z.infer<typeof Actions>;
        try {
          v = Actions.parse(input);
        } catch (e) {
          if (e instanceof z.ZodError) {
            return { ok: false, error: `参数不合法:${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
          }
          throw e;
        }
        try {
          switch (v.action) {
            case 'list': {
              const rows = await svc.listDatasets(ctx.projectId);
              return {
                ok: true,
                data: JSON.stringify(rows.map(({ projectId: _pid, updatedAt: _u, ...rest }) => rest), null, 2),
              };
            }
            case 'get': {
              if (!v.datasetId) return { ok: false, error: 'get 需要 datasetId' };
              const pid = await svc.datasetProjectId(v.datasetId);
              if (pid !== ctx.projectId) return { ok: false, error: '数据集不存在或不属于当前项目' };
              const d = await svc.getDataset(v.datasetId);
              if (!d) return { ok: false, error: '数据集不存在或不属于当前项目' };
              const { projectId: _pid, updatedAt: _u, createdBy: _c, ...rest } = d;
              return { ok: true, data: JSON.stringify({ ...rest, ...shapeRows(d.rows) }, null, 2) };
            }
            case 'update': {
              if (!v.datasetId || !v.name || !v.columns || !v.rows) {
                return { ok: false, error: 'update 需要 datasetId、name、columns 与 rows(全量替换语义)' };
              }
              const pid = await svc.datasetProjectId(v.datasetId);
              if (pid !== ctx.projectId) return { ok: false, error: '数据集不存在或不属于当前项目' };
              const before = await svc.getDataset(v.datasetId);
              if (!before) return { ok: false, error: '数据集不存在或不属于当前项目' };
              // Structure-summary diff (not row-by-row): column add/remove/rename/sensitive-flag changes + row-count delta
              const beforeCols = before.columns.map((c) => `${c.name}${c.sensitive ? '(敏感)' : ''}`);
              const afterCols = v.columns.map((c) => `${c.name}${c.sensitive ? '(敏感)' : ''}`);
              const diffLines = [
                `列: [${beforeCols.join(', ')}] → [${afterCols.join(', ')}]`,
                `行数: ${before.rows.length} → ${v.rows.length}`,
              ];
              if (v.renames && Object.keys(v.renames).length > 0) {
                diffLines.push(`改名: ${Object.entries(v.renames).map(([o, n]) => `${o}→${n}`).join(', ')}`);
              }
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_datasets', action: 'update',
                  summary: st(lang, 'dataset.updated', { name: before.name }), risk: 'update', diff: diffLines.join('\n'),
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              const after = await svc.updateDataset(v.datasetId, {
                name: v.name,
                description: v.description,
                columns: v.columns,
                rows: v.rows,
                renames: v.renames,
              });
              emitStage(ctx, { kind: 'dataset', id: v.datasetId, action: 'update', diff: diffLines.join('\n') });
              return { ok: true, data: `已更新数据集「${after.name}」(${after.columns.length} 列 / ${after.rows.length} 行)` };
            }
            case 'delete': {
              if (!v.datasetId) return { ok: false, error: 'delete 需要 datasetId' };
              const pid = await svc.datasetProjectId(v.datasetId);
              if (pid !== ctx.projectId) return { ok: false, error: '数据集不存在或不属于当前项目' };
              const d = await svc.getDataset(v.datasetId);
              const usage = await svc.datasetUsage(v.datasetId);
              const usageText = usage.caseCount > 0
                ? st(lang, 'dataset.usageReferenced', { caseCount: usage.caseCount })
                : st(lang, 'dataset.usageNone');
              const approved = await requestConfirmation(
                {
                  threadId: ctx.threadId, toolName: 'manage_datasets', action: 'delete',
                  summary: st(lang, 'dataset.deleted', { name: d?.name ?? v.datasetId, usage: usageText }),
                  risk: 'delete',
                },
                ctx.emit,
              );
              if (!approved) return { ok: false, error: '用户取消了该操作' };
              await svc.deleteDataset(v.datasetId);
              emitStage(ctx, { kind: 'dataset', id: v.datasetId, action: 'delete' });
              return { ok: true, data: `已删除数据集「${d?.name ?? v.datasetId}」` };
            }
          }
        } catch (e) {
          if (e instanceof HttpError) return { ok: false, error: e.message };
          return { ok: false, error: `操作失败:${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  ];
}
