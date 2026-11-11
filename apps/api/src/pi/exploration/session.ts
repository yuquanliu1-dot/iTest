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
import { renderCodeScopeSection } from '../../execute/explorationPrompt.js';
import type { CodeScope } from '../../execute/codeScope.js';
import { logger } from '../../logger.js';

/** 替换 pi 默认编码助手 preamble 的探索身份段（保留 tools/rules 段不动）。 */
const EXPLORATION_PREAMBLE = `你是 iTest 平台的 Web 探索式测试智能体，通过浏览器工具对被测系统做探索式测试：按章程主动找茬，发现行为异常、校验缺失、状态错乱、体验破绽。遵守下方工具使用规则。`;

/** 探索系统提示词基底（pi 版）：工具循环的工作纪律。与 legacy JSON 协议版（execute/explorationPrompt.ts）
 *  方向一致（主动找茬），但协议载体不同——pi 用原生工具调用，不再有 {"actions":[...]} 大包。
 *  判定动作（report_finding/note_excluded/finish）是显式工具——探索的产出物经它们落库。 */
const EXPLORATION_PI_SYSTEM_PROMPT = `工作方式：
- 先观察再动手：navigate 之后必先 observe 拿到截图与元素清单再判断；页面发生变化的下一步也重新 observe，不要凭过期认知决策。
- 小步推进：每次只做一件事，做完用 observe 确认结果再决定下一步；连续动作之间页面会变。
- 证据唯一：截图与元素清单是你做判断的唯一依据。坐标框（box）与截图对齐；元素清单只覆盖视口内，目标不在其中先滚动或导航找到它。页面消息（aria-live）是应用 toast/提示的一手文本。observe 反馈里的错误信号（console/HTTP 4xx-5xx）是取证线索，优先追查。
- 覆盖推进：observe 反馈里有覆盖进度（去过的页面、做过的交互）——已看过的路径别原路重复，优先推进没去过的入口与没试过的交互。
- 找到疑似缺陷立刻 report_finding（描述写「预期 vs 实际」+ 证据，不要攒到最后一起报）；工具会截取当前页面作为证据帧回传给你，核对帧内容与描述，不符就在下一条 finding 里修正。
- 验证过某条路径没有问题后 note_excluded 申报排除（假设+依据），避免重复探索；只报有依据的排除项。
- 范围纪律（平台强制）：navigate 只允许被测站点起点域名内，越界会被拒收并计为失败；起点页面打不开/不可达时如实结束并说明，不要改去任何其它站点或凭记忆换地址。
- 凭据纪律（平台强制）：需要登录/填凭据时，fill 的 value 用平台给定的占位符字面量（见下方登录段）——平台在填入的瞬间替换为真实值；绝不猜测或输出真实凭据。
- 破坏性操作（删除/清空等不可逆入口）被平台机械拒收时不要重试或改写措辞绕过——改为 report_finding 描述该入口的风险与缺失的确认机制。
- 不空转：同一目标连续 3 次失败就换路径或如实结束；页面加载中/骨架屏先等待再观察。
- 结束方式：主要路径都看过、或被卡住无法继续时，调用 finish 工具提交总结（覆盖了什么、发现几条缺陷、无法继续的原因），调用后不要再调其它工具。`;

/** 组装 appendSystemPromptOverride 的探索 addendum（章程/人格/登录准备/代码范围/降级说明/起点）。 */
export function composeExplorationPrompt(args: {
  charter: string;
  startUrl: string;
  persona: string;
  /** false = 视觉探针失败（渠道剥图）→ 显式告知模型无图可用。 */
  vision: boolean;
  /** 无已保存登录态且环境有凭据：起点落在登录页时按此段用占位符登录。 */
  login: { userPlaceholder: string; passwordPlaceholder: string } | null;
  /** 代码提交范围（resolveCodeScope 产物）；非空则拼「## 代码范围」段（复用 legacy 同一份渲染）。 */
  codeScope?: CodeScope | null;
  /** 环境里的数据库对象（label + 方言）；非空则拼「## 数据库取证」段（sql_probe 的可用库清单）。 */
  dbs?: Array<{ label: string; dialect: string }>;
}): string {
  const sections: string[] = [`## 章程（charter）\n${args.charter.trim()}`, `## 视角\n${args.persona}`];
  if (!args.vision) {
    sections.push('## 无视觉通道\n当前渠道的图像输入未生效，observe/screenshot 不会附截图——请完全依据元素清单（selector/tag/text/value）判断页面状态，不要请求截图。');
  }
  if (args.login) {
    sections.push(
      `## 登录准备\n若起点落在登录页：observe 找到用户名/密码输入框后——用户名框 fill 的 value 用字面量 ${args.login.userPlaceholder}，密码框用 ${args.login.passwordPlaceholder}（平台在填入的瞬间替换为真实值，不要输出真实凭据）；填完按 Enter 或点击登录按钮，再 observe 确认是否登录成功。`,
    );
  }
  if (args.codeScope) {
    sections.push(renderCodeScopeSection(args.codeScope));
  }
  if (args.dbs && args.dbs.length > 0) {
    sections.push(
      `## 数据库取证\n可用库：${args.dbs.map((d) => `${d.label}（${d.dialect}）`).join('、')}。sql_probe 可查证「前端没显示但库里写进去了」「列表少了一条但库里有」这类只在数据层可见的现象；先有具体假设再查，表名不确定先查 information_schema。`,
    );
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
