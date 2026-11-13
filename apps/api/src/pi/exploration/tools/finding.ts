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
      '报告一条**已验证**的缺陷（页面行为异常/校验缺失/状态错乱/环境配置问题）。工具会立即截取当前页面作为证据帧并落库，截图回传供你核对。每次只报一条。验证记录为必填：先重新触发确认可复现、判定归属类别、写清预期 vs 实际与证据，才能上报；未验证或复现失败的候选不会被落库推荐。',
    promptGuidelines: [
      '上报前先验证：重新触发同样的操作/再次观察，确认异常再次出现（reproduced=true）才算验证通过',
      '类别判定：页面行为与产品预期不符=code；环境配置缺失/错误、服务不可达、登录态异常=environment；测试数据缺失/脏数据=data；功能正常但难用/误导/文案错误=ux；难以归类=other。所有类别都是真缺陷，都必须上报——环境/数据问题不是「不算缺陷」，模型不要自行过滤',
      '复核后发现是预期行为、或无法复现：不要调用本工具，改用 note_excluded 记入排除账本',
      '同一缺陷只报一次；报完核对回传的截图帧，与描述不符时在描述里修正后再继续探索',
    ],
    parameters: Type.Object({
      title: Type.String({ description: '缺陷短标题（一句话说清现象）' }),
      description: Type.String({ description: '现象描述：预期 vs 实际、证据（文本/接口/数据）、影响' }),
      severity: Type.Optional(Type.String({ description: '严重程度 P0/P1/P2/P3，缺省 P2' })),
      reproSteps: Type.Optional(Type.Array(Type.String(), { description: '复现步骤（从进入站点开始，一步一句）' })),
      verification: Type.Object(
        {
          reproduced: Type.Boolean({
            description: '是否已复现复核：重新触发/再次观察后异常再次出现=true；无法复现=false（false 会被拒收并记入排除账本）',
          }),
          category: Type.Union(
            [Type.Literal('code'), Type.Literal('environment'), Type.Literal('data'), Type.Literal('ux'), Type.Literal('other')],
            {
              description:
                '缺陷归属：code=代码缺陷（功能/逻辑/权限/计算/状态流转与预期不符）；environment=环境配置问题（配置缺失或错误、服务不可达、登录态异常、依赖故障）；data=数据问题（测试数据缺失/脏数据/前置数据不成立）；ux=体验问题（功能正常但难用、误导性交互、文案错误）；other=其他或证据不足。所有类别都是真缺陷，都会推荐给用户',
            },
          ),
          expected: Type.String({ description: '预期行为（一句话）' }),
          actual: Type.String({ description: '实际行为（一句话）' }),
          evidence: Type.Optional(
            Type.Array(Type.String(), { description: '证据清单（元素文本/接口行为/查库结果/配置值），最多 5 条', maxItems: 5 }),
          ),
          confidence: Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')], {
            description: '置信度：证据充分且逻辑闭环=high；有合理怀疑=medium；仅初步迹象=low',
          }),
        },
        { description: '验证记录（必填）：复现复核 + 归类 + 预期 vs 实际 + 证据' },
      ),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const steps = (params.reproSteps ?? [])
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .slice(0, 10)
        .map((s) => ({ action: s.trim().slice(0, 500) }));
      const title = params.title.trim().slice(0, 60);
      const v = params.verification;
      // Mechanical gate 1: no verification record → reject and return the checklist (unverified candidates never reach the user).
      if (!v || typeof v !== 'object') {
        return toolErr(
          `候选「${title}」未落库：缺少验证记录。上报前必须先验证——重新触发确认可复现、判定归属类别（code/environment/data/ux/other）、写清预期 vs 实际与证据。`,
          '补全 verification 块后再报：reproduced=true、category=code|environment|data|ux|other、expected、actual、evidence[]、confidence。若复核发现是预期行为或无法复现，不要上报，改用 note_excluded 记入排除账本。',
        );
      }
      // Mechanical gate 2: reproduction failed → not a confirmed defect; auto-record the exclusion so the candidate
      // never silently disappears, then reject (nothing lands in findings, the user sees only verified defects).
      if (v.reproduced !== true) {
        deps.noteExcluded([
          {
            claim: `未复现候选：${title}`,
            evidence: `复现复核失败：${String(v.actual ?? '').trim().slice(0, 500)}`,
          },
        ]);
        return toolErr(
          `候选「${title}」未落库（复现复核失败）。已自动记入排除账本，用户不会看到该候选。`,
          '不要换措辞重报同一候选。若后来重新触发后异常稳定出现，可按完整 verification 块重新上报。',
        );
      }
      const raw = {
        title: params.title,
        description: params.description,
        ...(params.severity?.trim() ? { severity: params.severity.trim() } : {}),
        ...(steps.length > 0 ? { reproSteps: steps } : {}),
      };
      // Category whitelist-normalize: an out-of-vocabulary value degrades to 'other' rather than being dropped.
      const CATEGORIES = ['code', 'environment', 'data', 'ux', 'other'] as const;
      const r = await deps.findings.report(raw, {
        category: (CATEGORIES as readonly string[]).includes(v.category) ? v.category : 'other',
        expected: String(v.expected ?? '').trim().slice(0, 500),
        actual: String(v.actual ?? '').trim().slice(0, 500),
        evidence: (Array.isArray(v.evidence) ? v.evidence : [])
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .slice(0, 5)
          .map((x) => x.trim().slice(0, 500)),
        confidence: v.confidence === 'high' || v.confidence === 'low' ? v.confidence : 'medium',
      });
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
      // Markdown with sections + bullets is rendered by the detail page's md renderer; a run-on paragraph renders as an unreadable wall.
      summary: Type.String({
        description:
          '本次探索总结，Markdown 格式：用小标题分节（如 ## 概览 / ## 覆盖情况 / ## 未覆盖及原因），覆盖与未覆盖分条列点，每条一行；禁止输出一整段流水长文',
      }),
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
