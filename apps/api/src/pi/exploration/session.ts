/**
 * 探索会话（pi 链路）的 pi AgentSession 工厂与提示词拼装。
 *
 * 提示词分层（压缩安全是硬约束）：
 * - 章程/人格/起点/降级说明 → appendSystemPromptOverride（<addendum> 段）——
 *   pi 压缩只摘要旧消息、不动 system prompt；放首条 user message 会在长会话压缩后丢失。
 * - pi 默认的「编码助手」preamble → before_agent_start 里替换 sections.preamble 并删 docs 段
 *   （不能走 customPrompt——那会连 tools/rules 段一起丢掉，工具 promptGuidelines 就没了）。
 * - 工具使用纪律 → 各工具的 description + promptGuidelines（pi 原生 rules 段机制）。
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger.js';

/** 替换 pi 默认编码助手 preamble 的探索身份段（保留 tools/rules 段不动）。 */
const EXPLORATION_PREAMBLE = `你是 iTest 平台的 Web 探索式测试智能体，通过浏览器工具对被测系统做探索式测试：按章程主动找茬，发现行为异常、校验缺失、状态错乱、体验破绽。遵守下方工具使用规则。`;

/** 探索系统提示词基底（pi 版）：工具循环的工作纪律。与 legacy JSON 协议版（execute/explorationPrompt.ts）
 *  方向一致（主动找茬），但协议载体不同——pi 用原生工具调用，不再有 {"actions":[...]} 大包。 */
const EXPLORATION_PI_SYSTEM_PROMPT = `工作方式：
- 先观察再动手：navigate 之后必先 observe 拿到截图与元素清单再判断；页面发生变化的下一步也重新 observe，不要凭过期认知决策。
- 小步推进：每次只做一件事，做完用 observe 确认结果再决定下一步；连续动作之间页面会变。
- 证据唯一：截图与元素清单是你做判断的唯一依据。坐标框（box）与截图对齐；元素清单只覆盖视口内，目标不在其中先滚动或导航找到它。页面消息（aria-live）是应用 toast/提示的一手文本。
- 范围纪律（平台强制）：navigate 只允许被测站点起点域名内，越界会被拒收并计为失败；起点页面打不开/不可达时如实结束并说明，不要改去任何其它站点或凭记忆换地址。
- 不空转：同一目标连续 3 次失败就换路径或如实结束；页面加载中/骨架屏先等待再观察。
- 改动克制：当前只做观察类取证，不做破坏性/不可逆操作的预判（后续阶段的交互工具由平台机械闸约束）。
- 结束方式：探索完成（主要路径都看过）或无法继续时，不再调用工具，直接输出总结文本：覆盖了什么、发现了什么、无法继续的原因。`;

/** 组装 appendSystemPromptOverride 的探索 addendum（章程/人格/降级说明/起点）。 */
export function composeExplorationPrompt(args: {
  charter: string;
  startUrl: string;
  persona: string;
  /** false = 视觉探针失败（渠道剥图）→ 显式告知模型无图可用。 */
  vision: boolean;
  /** 无已保存登录态且环境有凭据：本阶段无填表工具，登录页 = 探索不可达。 */
  needsLoginButNoTools: boolean;
}): string {
  const sections: string[] = [`## 章程（charter）\n${args.charter.trim()}`, `## 视角\n${args.persona}`];
  if (!args.vision) {
    sections.push('## 无视觉通道\n当前渠道的图像输入未生效，observe/screenshot 不会附截图——请完全依据元素清单（selector/tag/text/value）判断页面状态，不要请求截图。');
  }
  if (args.needsLoginButNoTools) {
    sections.push('## 登录提示\n本会话没有已保存的登录态，且当前工具集没有填表/点击能力：若起点落在登录页，直接结束（输出总结文本，说明「需要登录态才能继续探索」）。');
  }
  sections.push(`## 起点\n从 ${args.startUrl} 开始：先 navigate 到起点，再 observe 获取截图与元素清单，之后按章程在站点内导航探索。`);
  return sections.join('\n\n');
}

/** pi 探索会话工厂入参。 */
export interface CreateExplorationSessionArgs {
  /** 工作目录（版本工作树）：pi 的 cwd（仓库读码工具 P3 沙箱以此为根）。 */
  cwd: string;
  tools: ToolDefinition[];
  model: Record<string, unknown>;
  /** appendSystemPromptOverride 的 addendum（composeExplorationPrompt 产物）。 */
  explorationPrompt: string;
}

/**
 * 创建 pi AgentSession：自定义工具集 + 内存会话（不落 pi_thread 文件——平台自己的
 * actions_trail 已是审计真源，无多副本文件一致性问题）+ 探索身份 preamble 替换。
 * bindExtensions 必需：pi 的 session_start 只在 bindExtensions 时触发（同 space 路径的验证结论）。
 */
export async function createExplorationSession(args: CreateExplorationSessionArgs) {
  const { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir } = await import('@earendil-works/pi-coding-agent');
  const loader = new DefaultResourceLoader({
    cwd: args.cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [...base, EXPLORATION_PI_SYSTEM_PROMPT, args.explorationPrompt],
    extensionFactories: [
      {
        name: 'itest-exploration-identity',
        hidden: true,
        factory: (pi) => {
          pi.on('before_agent_start', (event) => {
            // 只换 preamble、删 docs 段；tools/rules 段保留（工具 promptGuidelines 在那里）。
            event.systemPromptOptions.sections.preamble = EXPLORATION_PREAMBLE;
            delete event.systemPromptOptions.sections.docs;
            return undefined;
          });
        },
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: args.cwd,
    noTools: 'builtin',
    customTools: args.tools,
    model: args.model as never,
    sessionManager: SessionManager.inMemory(args.cwd),
    resourceLoader: loader,
  });
  await session.bindExtensions({
    mode: 'print',
    onError: (e) => {
      logger.warn({ err: e }, 'exploration extension error');
    },
  });
  return session;
}
