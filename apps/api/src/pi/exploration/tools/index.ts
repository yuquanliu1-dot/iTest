/**
 * 探索工具集装配（pi 链路）。
 *
 * ToolDefinition 用 pi 原生 defineTool 形态（content 支持 ImageContent ⇒ 视觉可用），
 * 不复用仓库自有 pi/tools.ts 的 ToolExecutor——后者纯文本、无图像通道、缺 label。
 * 工具经工厂注入依赖，便于测试替换 page 桩。
 *
 * 装配清单（16）：navigate/observe/screenshot/read_text/click/fill/press/select/scroll/
 * back/wait/evaluate/report_finding/note_excluded/finish + 条件挂载 sql_probe（有数据库）/repo_read（有代码范围）。
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ExplorationStep } from '../../../execute/explorationPrompt.js';
import type { RepoReadRequest, RepoReadResult } from '../../../execute/aiTask.js';
import {
  createObserveTool,
  createReadTextTool,
  createScreenshotTool,
  type ToolDeps,
} from './observe.js';
import {
  createBackTool,
  createClickTool,
  createFillTool,
  createNavigateTool,
  createPressTool,
  createScrollTool,
  createSelectTool,
  createWaitTool,
} from './browser.js';
import { createEvaluateTool } from './evaluate.js';
import { createFinishTool, createNoteExcludedTool, createReportFindingTool } from './finding.js';
import { createRepoReadTool, createSqlProbeTool, type SqlProbeEnv } from './forensics.js';
import type { FindingStore } from '../findings.js';

export type { ToolDeps };

/** 工具集全量依赖（runner 装配时注入）。sql/repo 通道按会话供数条件挂载。 */
export interface ExplorationDeps extends ToolDeps {
  findings: FindingStore;
  /** 申报排除项 → 实际入账条数（去重/封顶在 runner 侧账本）。 */
  noteExcluded(items: Array<{ claim: string; evidence?: string }>): number;
  /** 收尾：总结 + 模型回告的子目标完成情况（无子目标时 goals 为 undefined）。 */
  onFinish(summary: string, goals?: Array<{ id: string; done: boolean }>): void;
  /** dbRefs 非空才装配 sql_probe。 */
  sql?: { env: SqlProbeEnv; dbRefs: Array<{ label: string; dialect: string }> };
  /** 有代码提交范围才装配 repo_read。 */
  repo?: { channel: (req: RepoReadRequest) => Promise<RepoReadResult>; hasDiff: boolean };
}

export function createExplorationTools(deps: ExplorationDeps): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createNavigateTool(deps),
    createObserveTool(deps),
    createScreenshotTool(deps),
    createReadTextTool(deps),
    createClickTool(deps),
    createFillTool(deps),
    createPressTool(deps),
    createSelectTool(deps),
    createScrollTool(deps),
    createBackTool(deps),
    createWaitTool(deps),
    createEvaluateTool(deps),
    createReportFindingTool(deps),
    createNoteExcludedTool(deps),
    createFinishTool(deps),
  ];
  if (deps.sql) tools.push(createSqlProbeTool(deps.sql));
  if (deps.repo) tools.push(createRepoReadTool(deps.repo));
  return tools;
}

/**
 * 工具名 + 入参 → 动作留痕初稿（tool_execution_start 时登记，tool_execution_end 回填 ok/detail）。
 * type 对齐 legacy ExplorationStep 词表（click/fill/navigate/press/wait/sql/repo/screenshot），
 * 升格用例的机械映射（trailToCaseSteps）因此零改动可用；pi 专属动作（observe/read_text/
 * evaluate/report_finding/note_excluded/finish/select/scroll/back）以自身工具名作 type——
 * 详情页按「工具名 + target」渲染，trailToSteps 走 default 分支。
 * 注意：fill 的 value 取模型入参原值（占位符字面量）——替换发生在工具内部，留痕永远不含真实凭据。
 * 形状不符的入参一律 target='-'——留痕是审计辅助，不该因入参漂移抛错。
 */
export function trailStepOf(toolName: string, args: unknown): ExplorationStep | null {
  const o = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (k: string): string => (typeof o[k] === 'string' && o[k] ? (o[k] as string).slice(0, 300) : '-');
  const num = (k: string, d: number): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : d);
  switch (toolName) {
    case 'navigate':
      return { type: 'navigate', target: str('url'), ok: true };
    case 'observe':
      return { type: 'observe', target: '-', ok: true };
    case 'screenshot':
      return { type: 'screenshot', target: str('selector'), ok: true };
    case 'read_text':
      return { type: 'read_text', target: str('selector'), ok: true };
    case 'click':
      return { type: 'click', target: str('target'), ok: true };
    case 'fill':
      return { type: 'fill', target: str('target'), value: str('value'), ok: true };
    case 'press': {
      const key = str('key');
      return { type: 'press', target: key, key, ok: true };
    }
    case 'select':
      return { type: 'select', target: str('target'), value: str('value'), ok: true };
    case 'scroll':
      return { type: 'scroll', target: `${str('direction') === '-' ? 'down' : str('direction')} ${num('amount', 120)}`, ok: true };
    case 'back':
      return { type: 'back', target: '-', ok: true };
    case 'wait': {
      const ms = typeof o.ms === 'number' && Number.isFinite(o.ms) ? Math.round(o.ms) : null;
      return { type: 'wait', target: ms !== null ? String(ms) : str('selector'), ...(ms !== null ? { ms } : {}), ok: true };
    }
    case 'evaluate':
      return { type: 'evaluate', target: '-', ok: true };
    case 'sql_probe': {
      // legacy 同口径：归一空白 + 限长 1000（审计要看到"到底查了什么"，但不因超长膨胀）。
      const q = typeof o.query === 'string' ? o.query : '';
      return { type: 'sql', target: q.replace(/\s+/g, ' ').slice(0, 1000), ok: true };
    }
    case 'repo_read': {
      // legacy 同口径：`${op} ${path ?? pattern ?? ''}`.trim()（ls/diff 无 path → 光杆 op）。
      const op = str('op') === '-' ? 'read' : str('op');
      const arg = str('path') !== '-' ? str('path') : str('pattern') === '-' ? '' : str('pattern');
      return { type: 'repo', target: `${op} ${arg}`.trim(), ok: true };
    }
    case 'report_finding':
      return { type: 'report_finding', target: str('title'), ok: true };
    case 'note_excluded':
      return { type: 'note_excluded', target: '-', ok: true };
    case 'finish':
      return { type: 'finish', target: '-', ok: true };
    default:
      return { type: toolName, target: '-', ok: true };
  }
}
