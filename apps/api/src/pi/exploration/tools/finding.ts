/**
 * Judgment and wrap-up tools (pi chain): report_finding (A1 evidence frame) / note_excluded
 * (exclusion ledger) / finish.
 *
 * - report_finding: the model proactively reports a defect → the tool settles+screenshots
 *   internally (decision frame) → persists to DB → the frame image is returned for self-check.
 *   legacy screenshotted in the onFindings callback (after the next round of JSON arrived and the
 *   page had already changed) — that evidence/decision mismatch was a structural legacy flaw,
 *   pinned down mechanically here.
 * - note_excluded: declares "excluded hypothesis + basis" — the minimal slice of externalized
 *   memory. Stores exclusions only, not beliefs.
 * - finish: explicit wrap-up (summary + coverage ledger snapshot persisted with the terminal state).
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { toolErr, toolOk, toolOkImage } from './result.js';
import type { ExplorationDeps } from './index.js';

export function createReportFindingTool(deps: ExplorationDeps) {
  return defineTool({
    name: 'report_finding',
    label: 'report_finding',
    description:
      '报告一个疑似缺陷（页面行为异常/校验缺失/状态错乱/体验破绽）。工具会立即截取当前页面作为证据帧并落库，截图回传供你核对。每次只报一条。',
    promptGuidelines: [
      '先取证再上报：描述里写清「预期 vs 实际」与证据（元素文本/接口行为/查库结果），不要只写主观感受',
      '同一缺陷只报一次；报完核对回传的截图帧，与描述不符时在描述里修正后再继续探索',
    ],
    parameters: Type.Object({
      title: Type.String({ description: '缺陷短标题（一句话说清现象）' }),
      description: Type.String({ description: '现象描述：预期 vs 实际、证据（文本/接口/数据）、影响' }),
      severity: Type.Optional(Type.String({ description: '严重程度 P0/P1/P2/P3，缺省 P2' })),
      reproSteps: Type.Optional(Type.Array(Type.String(), { description: '复现步骤（从进入站点开始，一步一句）' })),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const steps = (params.reproSteps ?? [])
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .slice(0, 10)
        .map((s) => ({ action: s.trim().slice(0, 500) }));
      const raw = {
        title: params.title,
        description: params.description,
        ...(params.severity?.trim() ? { severity: params.severity.trim() } : {}),
        ...(steps.length > 0 ? { reproSteps: steps } : {}),
      };
      const r = await deps.findings.report(raw);
      const title = params.title.trim().slice(0, 60);
      if (!r.ok) {
        return toolErr(`缺陷未落库：${title}`, r.message);
      }
      if (r.imageBase64 && deps.vision) {
        return toolOkImage(`缺陷 #${r.order}「${title}」已落库`, r.message, r.imageBase64, 'image/png');
      }
      return toolOk(`缺陷 #${r.order}「${title}」已落库`, r.message);
    },
  });
}

export function createNoteExcludedTool(deps: ExplorationDeps) {
  return defineTool({
    name: 'note_excluded',
    label: 'note_excluded',
    description: '申报「已排除的假设 + 依据」：验证过某条路径/假设没有问题后申报，避免后续重复探索。账本有上限，只报有依据的排除项。',
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          claim: Type.String({ description: '被排除的假设，一句话' }),
          evidence: Type.Optional(Type.String({ description: '排除依据（看到了什么/查到什么）' })),
        }),
        { description: '排除项列表（一次可报多条）', maxItems: 5 },
      ),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const accepted = deps.noteExcluded(params.items);
      return accepted > 0
        ? toolOk(`已记入排除项 ${accepted} 条`, `已记入排除账本 ${accepted} 条。已排除的路径不要重复探索。`)
        : toolOk('未新增排除项（账本已满或与已申报重复）', '账本已满或条目与已申报重复，未新增。继续探索其它路径。');
    },
  });
}

export function createFinishTool(deps: ExplorationDeps & { onFinish(summary: string, goals?: Array<{ id: string; done: boolean }>): void }) {
  return defineTool({
    name: 'finish',
    label: 'finish',
    description: '结束探索并提交总结。主要路径都看过、或被卡住无法继续时调用。总结写：覆盖了什么、发现几条缺陷、无法继续的原因（如有）。',
    promptGuidelines: ['调用 finish 后不要再调用其它工具'],
    parameters: Type.Object({
      summary: Type.String({ description: '本次探索总结' }),
      goals: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({ description: '子目标 id（如 g1）' }),
            done: Type.Boolean({ description: '该子目标是否已在页面上验证完成' }),
          }),
          { description: '子目标完成情况（章程分解出的子目标逐条回告，没验证过的别标 done）', maxItems: 10 },
        ),
      ),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const summary = params.summary.trim().slice(0, 4000);
      const goals = (params.goals ?? [])
        .filter((g): g is { id: string; done: boolean } => typeof g?.id === 'string' && g.id.trim() !== '')
        .map((g) => ({ id: g.id.trim().slice(0, 16), done: g.done === true }));
      deps.onFinish(summary || '探索结束', goals.length > 0 ? goals : undefined);
      const done = goals.filter((g) => g.done).length;
      return toolOk(
        goals.length > 0 ? `已提交总结（子目标 ${done}/${goals.length} 完成）` : '已提交总结',
        '收到，正在收尾会话。',
      );
    },
  });
}
