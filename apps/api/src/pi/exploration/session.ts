/**
 * pi AgentSession factory and prompt assembly for exploration sessions (pi chain).
 *
 * Prompt layering (compression safety is a hard constraint):
 * - Charter/persona/start/degradation notice → appendSystemPromptOverride (the <addendum> segment) —
 *   pi compression only summarizes old messages and never touches the system prompt; putting them in the first
 *   user message would lose them after compression in a long session.
 * - pi's default "coding assistant" preamble → inside before_agent_start, replace the default sentence in the fully
 *   rendered string (forceSystemPrompt) and delete the docs segment (it cannot go through customPrompt — that drops
 *   the tools/rules segments too, taking the tools' promptGuidelines with it; nor can it be written to
 *   sections.preamble — pi validates section names and throws outright).
 * - Tool usage discipline → each tool's description + promptGuidelines (pi's native rules segment mechanism).
 */
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { renderCodeScopeSection } from '../../execute/explorationPrompt.js';
import type { CodeScope } from '../../execute/codeScope.js';
import { logger } from '../../logger.js';

/** Exploration identity segment replacing pi's default coding-assistant preamble (keeps the tools/rules segments untouched). */
const EXPLORATION_PREAMBLE = `你是 iTest 平台的 Web 探索式测试智能体，通过浏览器工具对被测系统做探索式测试：按章程主动找茬，发现行为异常、校验缺失、状态错乱、体验破绽。遵守下方工具使用规则。`;

/** pi's default preamble verbatim (pi-coding-agent dist/core/system-prompt.js). String replacement over the fully rendered prompt. */
const PI_DEFAULT_PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. '
  + 'You help users by reading files, executing commands, editing code, and writing new files.';

/** Exploration system prompt base (pi version): working discipline for the tool loop. Direction matches the legacy JSON
 *  protocol version (execute/explorationPrompt.ts) — actively hunt for defects — but the protocol carrier differs: pi uses
 *  native tool calls, no more {"actions":[...]} mega-payload.
 *  The verdict actions (report_finding/note_excluded/finish) are explicit tools — exploration outputs are persisted through them. */
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

/** Assembles the exploration addendum for appendSystemPromptOverride (charter/persona/login prep/code scope/degradation notice/start). */
export function composeExplorationPrompt(args: {
  charter: string;
  startUrl: string;
  persona: string;
  /** false = the vision probe failed (channel strips images) → explicitly tell the model no image is available. */
  vision: boolean;
  /** No saved login state and the environment has credentials: if the start lands on a login page, log in with the placeholders per this section. */
  login: { userPlaceholder: string; passwordPlaceholder: string } | null;
  /** Code commit scope (resolveCodeScope output); when non-empty, appends the "## Code Scope" section (reuses the same legacy renderer). */
  codeScope?: CodeScope | null;
  /** Database objects in the environment (label + dialect); when non-empty, appends the "## DB Forensics" section (the sql_probe usable-database list). */
  dbs?: Array<{ label: string; dialect: string }>;
  /** Sub-goals decomposed from the charter (C2); when non-empty, appends the "## Sub-goals" section — the exploration's direction list. */
  goals?: Array<{ id: string; text: string }>;
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
  if (args.goals && args.goals.length > 0) {
    sections.push(
      `## 子目标（章程分解）\n按顺序推进，每条都要在页面上实际验证过（看到证据才算做到）：\n${args.goals.map((g) => `- ${g.id}: ${g.text}`).join('\n')}\n收尾时用 finish 工具的 goals 参数回告各子目标完成情况（id + done）。`,
    );
  }
  sections.push(`## 起点\n从 ${args.startUrl} 开始：先 navigate 到起点，再 observe 获取截图与元素清单，之后按章程在站点内导航探索。`);
  return sections.join('\n\n');
}

/** Arguments for the pi exploration session factory. */
export interface CreateExplorationSessionArgs {
  /** Working directory (version worktree): pi's cwd (the repo-reading tool's P3 sandbox is rooted here). */
  cwd: string;
  tools: ToolDefinition[];
  model: Record<string, unknown>;
  /** The appendSystemPromptOverride addendum (composeExplorationPrompt output). */
  explorationPrompt: string;
}

/**
 * Creates a pi AgentSession: custom tool set + in-memory session (no pi_thread file — the platform's own
 * actions_trail is already the audit source of truth, with no multi-replica file consistency issue) + exploration
 * identity preamble replacement.
 * bindExtensions is required: pi's session_start only fires when bindExtensions is called (verified conclusion from the space path).
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
            // Delete the docs segment (cwd is the SUT repo; do not feed the repo's own AGENTS.md into the exploration identity).
            // Must happen before rendering event.systemPrompt — returning {systemPrompt} freezes later section changes.
            delete event.systemPromptOptions.sections.docs;
            // The preamble cannot go through sections.preamble — pi validates section names and throws
            // "Invalid system prompt section name: preamble" outright (proven on prod228).
            // Same approach as the space path: render the whole system prompt, replace the default coding-assistant
            // sentence with the exploration identity, and return it via forceSystemPrompt (not into the transcript;
            // the sections record stays intact).
            const rendered = event.systemPrompt;
            if (typeof rendered === 'string' && rendered.includes(PI_DEFAULT_PREAMBLE)) {
              return { systemPrompt: rendered.replace(PI_DEFAULT_PREAMBLE, EXPLORATION_PREAMBLE) };
            }
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
