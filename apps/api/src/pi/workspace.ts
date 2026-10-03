import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiWorkspaceState, aiScenarios, aiCases } from '../db/schema.js';
import { publishWorkspaceEvent } from './bus.js';
import type { StepAction } from '@itest/shared';

export type StagedStep = {
  name: string;
  action: string;
  assertion: string | null;
  /**
   * LLM-compiled DSL steps; 三态：
   *  - undefined: 未尝试（save 路径会兜底编译）
   *  - null: AI 已尝试但放弃（短路不再重试）
   *  - array: 已编译（短路不再重试）
   */
  compiled?: StepAction[] | null;
};
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export interface StagedCase {
  id: string;
  title: string;
  description: string | null;
  priority: Priority;
  steps: StagedStep[];
}
export interface StagedScenario {
  id: string;
  title: string;
  description: string | null;
  cases: StagedCase[];
}
export interface WorkspaceDoc {
  plan: { scenarios: number; cases: number } | null;
  /** inspect_page 成功抓取过的被测页面；用于前端"已参考页面实际代码"标识与保存时 URL 优先级。 */
  pageContext: { url: string; fetchedAt: string } | null;
  scenarios: StagedScenario[];
  looseCases: StagedCase[];
}

export function emptyDoc(): WorkspaceDoc {
  return { plan: null, pageContext: null, scenarios: [], looseCases: [] };
}

function publish(reqId: string): void {
  publishWorkspaceEvent({ type: 'workspace_doc', requirementId: reqId });
}

export async function loadDoc(requirementId: string): Promise<WorkspaceDoc> {
  const planRow = (await db
    .select({ doc: aiWorkspaceState.doc })
    .from(aiWorkspaceState)
    .where(eq(aiWorkspaceState.requirementId, requirementId))
    .limit(1))[0];

  const scenarioRows = await db
    .select()
    .from(aiScenarios)
    .where(eq(aiScenarios.requirementId, requirementId))
    .orderBy(aiScenarios.createdAt);

  const caseRows = await db
    .select()
    .from(aiCases)
    .where(eq(aiCases.requirementId, requirementId))
    .orderBy(aiCases.createdAt);

  const casesByScenario = new Map<string, StagedCase[]>();
  const looseCases: StagedCase[] = [];
  for (const row of caseRows) {
    const c: StagedCase = {
      id: row.id,
      title: row.title,
      description: row.description,
      priority: row.priority as Priority,
      steps: (row.steps as unknown as StagedStep[]).map((s) => {
        // 三态：undefined = 未尝试（保留字段缺失语义，触发 save 路径兜底编译）；
        // null = AI 已尝试但放弃（短路不再重试）；array = 已编译（短路不再重试）。
        // 注意：loadDoc 不主动把 undefined 规范为 null——否则 workspace 自身就读不到三态语义。
        // 测试/外部 API 想要 null 视图请自行处理（见 step-migration 与 ai-workspace-save.test.ts）。
        const out: StagedStep = {
          name: s.name,
          action: s.action,
          assertion: s.assertion ?? null,
        };
        if ('compiled' in s) out.compiled = s.compiled ?? null;
        return out;
      }),
    };
    if (row.scenarioId == null) looseCases.push(c);
    else {
      const arr = casesByScenario.get(row.scenarioId) ?? [];
      arr.push(c);
      casesByScenario.set(row.scenarioId, arr);
    }
  }

  const scenarios: StagedScenario[] = scenarioRows.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    cases: casesByScenario.get(s.id) ?? [],
  }));

  const stateDoc = planRow?.doc as
    | { plan?: { scenarios: number; cases: number }; pageContext?: { url: string; fetchedAt: string } }
    | undefined;
  const plan = stateDoc?.plan ?? null;
  const pageContext = stateDoc?.pageContext ?? null;
  return { plan, pageContext, scenarios, looseCases };
}

/** 读当前 doc（ai_workspace_state.doc jsonb），行不存在时返回空对象。 */
async function readStateDoc(requirementId: string): Promise<Record<string, unknown>> {
  const row = (await db
    .select({ doc: aiWorkspaceState.doc })
    .from(aiWorkspaceState)
    .where(eq(aiWorkspaceState.requirementId, requirementId))
    .limit(1))[0];
  return (row?.doc as Record<string, unknown> | undefined) ?? {};
}

export async function announcePlan(requirementId: string, plan: { scenarios: number; cases: number }): Promise<void> {
  // merge：保留 pageContext 等既有字段（read-modify-write）
  const current = await readStateDoc(requirementId);
  const doc = { ...current, plan };
  await db
    .insert(aiWorkspaceState)
    .values({ requirementId, doc })
    .onConflictDoUpdate({
      target: aiWorkspaceState.requirementId,
      set: { doc, updatedAt: new Date() },
    });
  publish(requirementId);
}

export async function recordPageInspection(requirementId: string, url: string): Promise<void> {
  const current = await readStateDoc(requirementId);
  const doc = { ...current, pageContext: { url, fetchedAt: new Date().toISOString() } };
  await db
    .insert(aiWorkspaceState)
    .values({ requirementId, doc })
    .onConflictDoUpdate({
      target: aiWorkspaceState.requirementId,
      set: { doc, updatedAt: new Date() },
    });
  publish(requirementId);
}

export async function upsertScenario(requirementId: string, scenario: StagedScenario): Promise<void> {
  // 入参的 cases 被忽略（保持与旧实现一致：cases 通过 upsertCase 单独写入）。
  // 先建场景行：SQL UPSERT 走复合主键 (requirement_id, id)；
  // 同步把该场景下的 case 行（如果有）一并 upsert——这是对旧实现的关键兼容点：
  // 旧版 upsertScenario({cases: [...]}) 会把 cases 一起写进 doc；新版必须自己处理，
  // 否则直接传入 cases 数组的旧调用会丢用例。
  if (scenario.cases.length > 0) {
    await db.transaction(async (tx) => {
      await tx
        .insert(aiScenarios)
        .values({
          requirementId,
          id: scenario.id,
          title: scenario.title,
          description: scenario.description,
          order: 0,
        })
        .onConflictDoUpdate({
          target: [aiScenarios.requirementId, aiScenarios.id],
          set: { title: scenario.title, description: scenario.description },
        });
      for (const c of scenario.cases) {
        await tx
          .insert(aiCases)
          .values({
            requirementId,
            id: c.id,
            scenarioId: scenario.id,
            title: c.title,
            description: c.description,
            priority: c.priority,
            steps: c.steps as unknown as object,
            position: 0,
          })
          .onConflictDoUpdate({
            target: [aiCases.requirementId, aiCases.id],
            set: {
              scenarioId: scenario.id,
              title: c.title,
              description: c.description,
              priority: c.priority,
              steps: c.steps as unknown as object,
            },
          });
      }
    });
  } else {
    await db
      .insert(aiScenarios)
      .values({
        requirementId,
        id: scenario.id,
        title: scenario.title,
        description: scenario.description,
        order: 0,
      })
      .onConflictDoUpdate({
        target: [aiScenarios.requirementId, aiScenarios.id],
        set: { title: scenario.title, description: scenario.description },
      });
  }
  publish(requirementId);
}

export async function upsertCase(requirementId: string, scenarioId: string | null, c: StagedCase): Promise<void> {
  if (scenarioId != null) {
    // 容忍 LLM 并发：场景尚未声明时先建占位行（title=scenarioId，后续 upsert_scenario 会覆盖）
    await db
      .insert(aiScenarios)
      .values({ requirementId, id: scenarioId, title: scenarioId, description: null, order: 0 })
      .onConflictDoNothing({ target: [aiScenarios.requirementId, aiScenarios.id] });
  }
  await db
    .insert(aiCases)
    .values({
      requirementId,
      id: c.id,
      scenarioId,
      title: c.title,
      description: c.description,
      priority: c.priority,
      steps: c.steps as unknown as object,
      position: 0,
    })
    .onConflictDoUpdate({
      target: [aiCases.requirementId, aiCases.id],
      set: {
        scenarioId,
        title: c.title,
        description: c.description,
        priority: c.priority,
        steps: c.steps as unknown as object,
      },
    });
  publish(requirementId);
}

export async function removeItem(requirementId: string, item: { kind: 'scenario' | 'case'; id: string; scenarioId?: string | null }): Promise<void> {
  if (item.kind === 'scenario') {
    await db.transaction(async (tx) => {
      await tx.delete(aiCases).where(and(
        eq(aiCases.requirementId, requirementId),
        eq(aiCases.scenarioId, item.id),
      ));
      await tx.delete(aiScenarios).where(and(
        eq(aiScenarios.requirementId, requirementId),
        eq(aiScenarios.id, item.id),
      ));
    });
  } else {
    await db.delete(aiCases).where(and(
      eq(aiCases.requirementId, requirementId),
      eq(aiCases.id, item.id),
    ));
  }
  publish(requirementId);
}

export async function removeSaved(requirementId: string, savedCaseIds: string[]): Promise<void> {
  if (savedCaseIds.length === 0) return;
  await db.transaction(async (tx) => {
    // 1. 先抓出这次要删除的 case 行对应的 scenario_id（drain 候选集）。
    //    这样后续只能从"曾经有过 case 行的场景"里挑掉空壳，那些"从来没收过 case 行的占位场景"
    //    （占位行，title=id，upsertCase 在场景尚未声明时建的）不会被误删。
    const candidates = await tx
      .selectDistinct({ scenarioId: aiCases.scenarioId })
      .from(aiCases)
      .where(and(
        eq(aiCases.requirementId, requirementId),
        inArray(aiCases.id, savedCaseIds),
      ));
    const candidateSet = new Set(
      candidates.map((r) => r.scenarioId).filter((x): x is string => x != null),
    );

    // 2. 删 case 行
    await tx.delete(aiCases).where(and(
      eq(aiCases.requirementId, requirementId),
      inArray(aiCases.id, savedCaseIds),
    ));

    // 3. 在候选集里，只删那些"现在没有任何 case 行的"——即真正被排空（drained）的场景
    if (candidateSet.size > 0) {
      const stillHere = await tx
        .selectDistinct({ scenarioId: aiCases.scenarioId })
        .from(aiCases)
        .where(eq(aiCases.requirementId, requirementId));
      const stillHereSet = new Set(
        stillHere.map((r) => r.scenarioId).filter((x): x is string => x != null),
      );
      const toDelete = [...candidateSet].filter((sid) => !stillHereSet.has(sid));
      if (toDelete.length > 0) {
        await tx.delete(aiScenarios).where(and(
          eq(aiScenarios.requirementId, requirementId),
          inArray(aiScenarios.id, toDelete),
        ));
      }
    }
  });
  publish(requirementId);
}
