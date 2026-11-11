/**
 * 探索工具集装配（pi 链路）。
 *
 * ToolDefinition 用 pi 原生 defineTool 形态（content 支持 ImageContent ⇒ 视觉可用），
 * 不复用仓库自有 pi/tools.ts 的 ToolExecutor——后者纯文本、无图像通道、缺 label。
 * 工具经工厂注入 ToolDeps（page/vision/scopeOrigins），便于测试替换 page 桩。
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ExplorationStep } from '../../../execute/explorationPrompt.js';
import { createObserveTool, createReadTextTool, createScreenshotTool, type ToolDeps } from './observe.js';
import { createNavigateTool } from './browser.js';

export type { ToolDeps };

/** P2 只读观察工具集：navigate / observe / screenshot / read_text（P3 加 click/fill 等）。 */
export function createExplorationTools(deps: ToolDeps & { scopeOrigins: string[] }): ToolDefinition[] {
  return [createNavigateTool(deps), createObserveTool(deps), createScreenshotTool(deps), createReadTextTool(deps)];
}

/**
 * 工具名 + 入参 → 动作留痕初稿（tool_execution_start 时登记，tool_execution_end 回填 ok）。
 * type 对齐 legacy ExplorationStep 词表（navigate/screenshot），pi 专属观察动作以自身工具名
 * 作 type（详情页按「工具名 + target」渲染；未知类型在 trailToSteps 走 default 分支）。
 * 形状不符的入参一律 target='-'——留痕是审计辅助，不该因入参漂移抛错。
 */
export function trailStepOf(toolName: string, args: unknown): ExplorationStep | null {
  const o = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const str = (k: string): string => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : '-');
  switch (toolName) {
    case 'navigate':
      return { type: 'navigate', target: str('url'), ok: true };
    case 'observe':
      return { type: 'observe', target: '-', ok: true };
    case 'screenshot':
      return { type: 'screenshot', target: str('selector'), ok: true };
    case 'read_text':
      return { type: 'read_text', target: str('selector'), ok: true };
    default:
      return { type: toolName, target: '-', ok: true };
  }
}
