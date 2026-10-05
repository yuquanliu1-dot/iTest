/**
 * 自定义 workspace 工具定义：被 session.ts 用 defineTool(...) 适配后注册到 AgentSession。
 * 这里只输出"可单元测试的执行器 + TypeBox schema"，不依赖 pi-coding-agent。
 */
import { Type } from '@earendil-works/pi-ai';
import * as ws from './workspace.js';
import { inspectPage } from './inspectPage.js';

export interface ToolExecutor {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  /** 成功时可携带回传给模型的文本（如 inspect_page 的元素清单）；缺省回 'ok'。 */
  execute: (input: unknown) => Promise<{ ok: true; data?: string } | { ok: false; error: string }>;
  /** 透传到 defineTool 的 promptGuidelines，追加到 agent system prompt 的 Guidelines 段。 */
  promptGuidelines?: string[];
}

/**
 * 把 LLM 输出的单个 compiled 步骤归一化为回放可识别的形状。
 * 历史实测 LLM 偶尔会产出异常形状：
 *  1) locator 写成 {item:{strategy,value}} 单对象外壳 → 还原成 [{strategy,value}]
 *  2) locator 直接写成 {strategy,value} 单对象 → 包成数组
 *  3) locator 每个候选又被多包一层数组（[[{...},{...}]]）→ 剥到只剩 [{...},{...}]
 *  navigate / screenshot / aiTask 等无 locator 字段原样透传。
 */
export function normalizeCompiledStep(step: unknown): unknown {
  if (!step || typeof step !== 'object') return step;
  const s = step as Record<string, unknown>;
  const loc = s.locator;
  if (Array.isArray(loc)) {
    // locator 是数组 → 检查是否 [[{...}]] 双层嵌套（LLM 误把每个候选当数组再包了一层）
    const flat: unknown[] = [];
    for (const item of loc) {
      if (Array.isArray(item)) {
        for (const inner of item) flat.push(inner);
      } else if (item && typeof item === 'object' && 'item' in (item as Record<string, unknown>)) {
        flat.push((item as { item: unknown }).item);
      } else {
        flat.push(item);
      }
    }
    s.locator = flat.map((item) => normalizeLocatorItem(item));
  } else if (loc && typeof loc === 'object') {
    s.locator = [normalizeLocatorItem(loc)];
  }
  return s;
}

/** 把单个 locator 候选归一化为 {strategy,value} 对象；非对象/缺字段透传。 */
function normalizeLocatorItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item;
  const obj = item as Record<string, unknown>;
  if ('item' in obj && obj.item && typeof obj.item === 'object') {
    return normalizeLocatorItem(obj.item);
  }
  return obj;
}

export function buildWorkspaceTools(
  requirementId: string,
  ctx: { contextMode: 'repo' | 'page' | 'auto'; repoAvailable: boolean } = { contextMode: 'auto', repoAvailable: false },
): ToolExecutor[] {
  const ctxGuideline: string[] = (() => {
    if (ctx.contextMode === 'repo' && ctx.repoAvailable) {
      return [
        '生成用例前必须先调用 repo_ls/repo_read/repo_grep 看真实源码再决定 locator / navigate URL。',
        'locator 必须基于源码中真实存在的元素（className / data-testid / role），禁止臆造。',
      ];
    }
    if (ctx.contextMode === 'page') {
      return ['生成用例前先调 inspect_page 抓取真实页面元素清单。'];
    }
    if (ctx.contextMode === 'repo' && !ctx.repoAvailable) {
      return ['本项目源码仓库不可用，请改用 inspect_page 抓取页面。'];
    }
    // auto + 仓库可用 / 不可用 两种
    if (ctx.repoAvailable) {
      return [
        'auto 模式：若需求含明确被测页面 URL，先 inspect_page；若同时暗示内部行为（接口、状态机、表单提交后跳转），可调 repo_*。',
        '仓库可用时优先 repo_ls 列目录、repo_read 读关键文件、repo_grep 找关键实现。',
      ];
    }
    return ['auto 模式：本项目无仓库配置，直接 inspect_page。'];
  })();
  return [
    {
      name: 'announce_plan',
      description: '声明本次将要生成 N 个场景 M 个用例；用于前端进度条分母。',
      parameters: Type.Object({
        scenarios: Type.Number({ minimum: 0 }),
        cases: Type.Number({ minimum: 0 }),
      }),
      // C（减少串行 LLM 往返）：plan 声明与暂存调用同轮并行，不单独占一轮
      promptGuidelines: ['announce_plan 应与 upsert_scenario / upsert_case 放在同一轮并行调用，不要单独占一轮。'],
      execute: async (input) => {
        const v = input as { scenarios: number; cases: number };
        await ws.announcePlan(requirementId, v);
        return { ok: true };
      },
    },
    {
      name: 'upsert_scenario',
      description: '创建或更新场景；同 id 重复调用即更新（幂等）。',
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        // A（消除验证重试）：可选字段即使 LLM 整轮漏传也不会被 schema 验证整批拒绝
        description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      execute: async (input) => {
        const v = input as { id: string; title: string; description: string | null };
        await ws.upsertScenario(requirementId, { id: v.id, title: v.title, description: v.description, cases: [] });
        return { ok: true };
      },
    },
    {
      name: 'upsert_case',
      description:
        '创建或更新用例；可属于某个场景（scenarioId）或散用例（省略 scenarioId）。当 scenarioId 不为空但场景尚未声明时，会自动创建一个同名（id）占位场景，以容忍 LLM 并发提交。每条用例应显式给出 description 与 priority（P0-P3）；省略时默认 priority=P2、description 为空。',
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        // A（消除验证重试）：2026-10-02 实测 LLM 首轮漏传 description/priority 被 schema
        // 验证整批拒绝、重试多耗 15.8s。改为可选 + 执行器兜底默认值，结构上不可能再触发。
        description: Type.Optional(Type.Union([Type.String({ maxLength: 4000 }), Type.Null()])),
        priority: Type.Optional(Type.Union([
          Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2'), Type.Literal('P3'),
        ])),
        steps: Type.Array(Type.Object({
          // 宽松：name 缺省时回退到 action 首句；允许 LLM 第一轮只写 action。
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          action: Type.String({ minLength: 1, maxLength: 2000 }),
          assertion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          /** LLM-compiled DSL steps; missing or null = not generated. */
          compiled: Type.Optional(Type.Array(Type.Unknown())),
        })),
        scenarioId: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
      }),
      // C（减少串行 LLM 往返）：整批用例同一轮并行提交，且不等待场景先行声明（占位场景兜底）
      // D（双字段落库）：必须输出 compiled DSL；未输出由 save 兜底编译——但实操里没编译=UI 显示「未编译」，
      // 拖慢评审节奏。所以把每条 step 的 compiled 输出规则直接写进 promptGuidelines，与共享 SYSTEM_PROMPT 一源。
      promptGuidelines: [
        ...ctxGuideline,
        '尽量在同一轮并行发出全部工具调用：announce_plan、upsert_scenario 与每条用例一个 upsert_case 一起提交，不要逐条等待结果再发下一批。',
        '每条用例都应显式提供 description（说明验证点）与 priority（P0-P3）。',
        '每条 step 必须输出 compiled 字段（DSL 步骤数组，可执行回放）。规则与共享 SYSTEM_PROMPT 完全一致：',
        '- compiled 是 JSON 数组，元素形如 {"kind": "...", ...}；允许 kind：navigate {url} / click {locator} / fill {locator, value} / hover {locator} / waitFor {locator, timeoutMs?} / assertText {locator, equals} / assertVisible {locator} / check {locator, checked} / select {locator, value} / extract {locator, varName} / aiTask {instruction}（运行时智能体执行,不预编译,原样保留）。禁止输出 aiStep。',
        '- locator 必须是数组，每个元素是单个 {strategy, value} 对象，strategy 限 role/text/testId/css/xpath；至少 1 个候选。正确示例：locator:[{strategy:"css", value:"button[type=\'submit\']"}, {strategy:"css", value:".login-btn"}] —— 注意 locator **只有一层数组**，每个元素直接是 {strategy,value} 对象，不要把每个候选再嵌一层数组。完整 step 示例：{kind:"click", locator:[{strategy:"css", value:"button[type=\'submit\']"}]}。禁止把 locator 写成对象（如 {item:{...}} 或 {strategy:"...",value:"..."} 直接放在 locator 槽），回放无法识别。',
        '- navigate 的 url 必须是绝对 URL，且必须使用用户消息上下文里给的真实页面 URL（host:port/path 原样保留），禁止臆造 http://localhost:5173/...。如果你没有拿到 URL，请在生成用例前先调用 inspect_page 抓取真实页面，从抓取结果里取真实 URL。',
        '- 末尾断言（强约束）：步骤执行后若有可观察结果，断言必须基于真实可见元素——优先 assertVisible（元素级，不依赖文案）；次之 assertText + locator+match:"contains"。禁止使用 target:"page" equals:模糊自由文本（例「登录页正常加载」「看到工作台」），它对任何页面都命中，掩盖回放失败。',
        '- inspect_page 快照仅为页面初始状态：点击/提交后才出现的元素（结果区、错误提示）不在清单中。断言这类元素必须先触发对应操作再断言，或断言清单中其稳定的父容器；快照与动态都确认不了的元素，用 role/text 定位，绝对禁止编造 testid/id。',
        '- 若 step 没有可观察结果（如「打开某页」），不要补任何断言。',
        '- 若你判断无法可靠编译（如指令过于模糊、需要视觉识别但无 #cssSelector 占位），把 compiled 设为 null 表示「已放弃」，保存时不会再 LLM 重试。注意：null ≠ []，空数组 [] 在回放里等价于「什么都不做」，会隐藏失败；放弃语义必须用 null。',
      ],
      execute: async (input) => {
        const v = input as {
          id: string; title: string; description?: string | null; priority?: 'P0'|'P1'|'P2'|'P3';
          steps: Array<{ name?: string; action: string; assertion?: string | null; compiled?: unknown[] | null }>;
          scenarioId?: string | null;
        };
        // name 兜底：取 action 首句（按第一个中文/英文标点截断，长度 24）
        const steps = v.steps.map((s) => {
          const name = (s.name && s.name.trim().length > 0)
            ? s.name
            : (s.action.split(/[，。！？,.!?\n]/, 1)[0]?.trim() ?? s.action.slice(0, 24)).slice(0, 200);
          // 三态：undefined = 未尝试（保留编译字段未定义，save 时原样落 aiTask）；
          // null = AI 已放弃（短路不再重试）；array = 已编译（短路不再重试）。
          // 仅当 LLM 显式提供 compiled（数组或 null）时才写入字段，避免老用法下"字段缺失"误为"已放弃"。
          // 防御性归一化：
          //  1) 空数组 [] → null（LLM 把"放弃"误写成空数组会隐藏失败，必须映射为放弃语义）；
          //  2) locator 形状 {item:{strategy,value}} → [{strategy,value}]（LLM 把候选数组误写成单对象外壳）；
          //  3) locator 是非数组对象（含 strategy+value）→ [obj]（LLM 直接给单元素）。
          //  这三种历史实测都出现过；继续保留纯单步结构，其它情况原样透传（保存时仍由 zod 兜底）。
          let compiled: unknown[] | null | undefined;
          if ('compiled' in s && s.compiled !== undefined) {
            if (Array.isArray(s.compiled)) {
              if (s.compiled.length === 0) {
                compiled = null;
              } else {
                compiled = s.compiled.map(normalizeCompiledStep);
              }
            } else {
              compiled = s.compiled as unknown[] | null;
            }
          }
          const out: { name: string; action: string; assertion: string | null; compiled?: unknown[] | null } = {
            name,
            action: s.action,
            assertion: s.assertion ?? null,
          };
          if (compiled !== undefined) out.compiled = compiled as unknown[] | null;
          return out;
        });
        await ws.upsertCase(requirementId, v.scenarioId ?? null, {
          id: v.id, title: v.title, description: v.description ?? null,
          priority: v.priority ?? 'P2', steps: steps as Parameters<typeof ws.upsertCase>[2]['steps'],
        });
        return { ok: true };
      },
    },
    {
      name: 'remove_item',
      description: '从暂存文档中移除一个场景或用例。',
      parameters: Type.Object({
        kind: Type.Union([Type.Literal('scenario'), Type.Literal('case')]),
        id: Type.String({ minLength: 1, maxLength: 64 }),
        scenarioId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      execute: async (input) => {
        const v = input as { kind: 'scenario' | 'case'; id: string; scenarioId?: string | null };
        await ws.removeItem(requirementId, v);
        return { ok: true };
      },
    },
    {
      name: 'inspect_page',
      description:
        '抓取被测页面并返回实际的可交互元素清单（按钮/输入框/链接/选择器/文案，含 data-testid 元素）。当需求文本包含被测页面 URL 时，生成用例前必须先调用本工具参考页面真实实现，禁止凭"典型实现"臆造页面功能；只有抓取失败时才可退回基于功能点假设生成，并在用例描述中注明"基于假设，未验证页面"。快照仅为页面初始状态，操作后才出现的元素不在其中。',
      parameters: Type.Object({
        url: Type.String({ minLength: 8, maxLength: 2000 }),
      }),
      promptGuidelines: ['需求中包含被测页面 URL 时，生成用例前必须先调用 inspect_page 获取真实元素清单。'],
      execute: async (input) => {
        const { url: pageUrl } = input as { url: string };
        try {
          const data = await inspectPage(pageUrl);
          await ws.recordPageInspection(requirementId, pageUrl);
          return { ok: true, data };
        } catch (e) {
          return { ok: false, error: `页面抓取失败：${(e as Error).message}` };
        }
      },
    },
  ];
}
