/**
 * 工具结果统一出口（pi 链路）：每个工具都带一句**结果摘要**（details.summary）。
 *
 * 为什么需要：留痕只记「做了什么动作」（type/target），详情页的「会话过程」于是长这样——
 * 「观察页面 -」「页内脚本 -」「截图 -」：动作有、结论无。用户从过程里看不到价值。
 * 工具层是唯一知道「这步到底看到了什么 / 变了什么 / 为什么失败」的地方，所以摘要在这里产出：
 * - text（content）：给模型看的完整反馈（不变）；
 * - summary（details）：给留痕与详情页看的一句话结论——pi 的 details 不进模型上下文，
 *   不烧 token。
 */
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

/** 工具结果里的留痕摘要载荷（details 字段）。 */
export interface ToolDetails {
  summary: string;
}

/** 摘要长度封顶：留痕是审计辅助，不是日志全文。 */
const SUMMARY_MAX = 200;

/** 成功结果（纯文本）。 */
export function toolOk(summary: string, text: string): AgentToolResult<ToolDetails> {
  return { content: [{ type: 'text', text }], details: { summary: summary.slice(0, SUMMARY_MAX) } };
}

/** 成功结果（文本 + 截图块）。 */
export function toolOkImage(
  summary: string,
  text: string,
  data: string,
  mimeType: string,
): AgentToolResult<ToolDetails> {
  return {
    content: [
      { type: 'text', text },
      { type: 'image', data, mimeType },
    ],
    details: { summary: summary.slice(0, SUMMARY_MAX) },
  };
}

/** 失败结果（摘要写失败原因——详情页要能看到「为什么没成」）。 */
export function toolErr(summary: string, text: string): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: 'text', text }],
    details: { summary: summary.slice(0, SUMMARY_MAX) },
    isError: true,
  };
}
