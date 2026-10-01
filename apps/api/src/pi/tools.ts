/**
 * 自定义 workspace 工具定义：被 session.ts 用 defineTool(...) 适配后注册到 AgentSession。
 * 这里只输出"可单元测试的执行器 + TypeBox schema"，不依赖 pi-coding-agent。
 */
import { Type } from '@earendil-works/pi-ai';
import * as ws from './workspace.js';

export interface ToolExecutor {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (input: unknown) => Promise<{ ok: true } | { ok: false; error: string }>;
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
        description: Type.Union([Type.String(), Type.Null()]),
      }),
      execute: async (input) => {
        const v = input as { id: string; title: string; description: string | null };
        await ws.upsertScenario(requirementId, { id: v.id, title: v.title, description: v.description, cases: [] });
        return { ok: true };
      },
    },
    {
      name: 'upsert_case',
      description: '创建或更新用例；可属于某个场景（scenarioId）或散用例（scenarioId=null）。',
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.Union([Type.String(), Type.Null()]),
        priority: Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2'), Type.Literal('P3')]),
        steps: Type.Array(Type.Object({
          name: Type.String({ minLength: 1, maxLength: 200 }),
          action: Type.String({ minLength: 1, maxLength: 2000 }),
          assertion: Type.Union([Type.String(), Type.Null()]),
        })),
        scenarioId: Type.Union([Type.String(), Type.Null()]),
      }),
      execute: async (input) => {
        const v = input as {
          id: string; title: string; description: string | null; priority: 'P0'|'P1'|'P2'|'P3';
          steps: { name: string; action: string; assertion: string | null }[];
          scenarioId: string | null;
        };
        await ws.upsertCase(requirementId, v.scenarioId, {
          id: v.id, title: v.title, description: v.description, priority: v.priority, steps: v.steps,
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
  ];
}
