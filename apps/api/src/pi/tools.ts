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

export function buildWorkspaceTools(requirementId: string): ToolExecutor[] {
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
        })),
        scenarioId: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
      }),
      // C（减少串行 LLM 往返）：整批用例同一轮并行提交，且不等待场景先行声明（占位场景兜底）
      promptGuidelines: [
        '尽量在同一轮并行发出全部工具调用：announce_plan、upsert_scenario 与每条用例一个 upsert_case 一起提交，不要逐条等待结果再发下一批。',
        '每条用例都应显式提供 description（说明验证点）与 priority（P0-P3）。',
      ],
      execute: async (input) => {
        const v = input as {
          id: string; title: string; description?: string | null; priority?: 'P0'|'P1'|'P2'|'P3';
          steps: Array<{ name?: string; action: string; assertion?: string | null }>;
          scenarioId?: string | null;
        };
        // name 兜底：取 action 首句（按第一个中文/英文标点截断，长度 24）
        const steps = v.steps.map((s) => {
          if (s.name && s.name.trim().length > 0) return { name: s.name, action: s.action, assertion: s.assertion ?? null };
          const first = s.action.split(/[，。！？,.!?\n]/, 1)[0]?.trim() ?? s.action.slice(0, 24);
          return { name: first.slice(0, 200), action: s.action, assertion: s.assertion ?? null };
        });
        await ws.upsertCase(requirementId, v.scenarioId ?? null, {
          id: v.id, title: v.title, description: v.description ?? null,
          priority: v.priority ?? 'P2', steps,
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
        '抓取被测页面并返回实际的可交互元素清单（按钮/输入框/链接/选择器/文案）。当需求文本包含被测页面 URL 时，生成用例前必须先调用本工具参考页面真实实现，禁止凭"典型实现"臆造页面功能；只有抓取失败时才可退回基于功能点假设生成，并在用例描述中注明"基于假设，未验证页面"。',
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
