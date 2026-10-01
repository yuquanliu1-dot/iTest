import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiWorkspaceState } from '../db/schema.js';
import { publishWorkspaceEvent } from './bus.js';

export type StagedStep = { name: string; action: string; assertion: string | null };
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
  scenarios: StagedScenario[];
  looseCases: StagedCase[];
}

export function emptyDoc(): WorkspaceDoc {
  return { plan: null, scenarios: [], looseCases: [] };
}

async function readOrEmpty(requirementId: string): Promise<WorkspaceDoc> {
  const rows = await db.select({ doc: aiWorkspaceState.doc }).from(aiWorkspaceState).where(eq(aiWorkspaceState.requirementId, requirementId)).limit(1);
  return (rows[0]?.doc as WorkspaceDoc | undefined) ?? emptyDoc();
}

async function persist(requirementId: string, doc: WorkspaceDoc): Promise<void> {
  await db
    .insert(aiWorkspaceState)
    .values({ requirementId, doc })
    .onConflictDoUpdate({ target: aiWorkspaceState.requirementId, set: { doc, updatedAt: new Date() } });
  publishWorkspaceEvent({ type: 'workspace_doc', requirementId });
}

export async function loadDoc(requirementId: string): Promise<WorkspaceDoc> {
  return readOrEmpty(requirementId);
}

export async function announcePlan(requirementId: string, plan: { scenarios: number; cases: number }): Promise<void> {
  const doc = await readOrEmpty(requirementId);
  doc.plan = plan;
  await persist(requirementId, doc);
}

export async function upsertScenario(requirementId: string, scenario: StagedScenario): Promise<void> {
  const doc = await readOrEmpty(requirementId);
  const idx = doc.scenarios.findIndex((s) => s.id === scenario.id);
  if (idx >= 0) {
    // 合并 cases：保留 doc 中已有的 cases（AI 后续可能补充），用入参的元数据替换 title/description
    const merged: StagedScenario = {
      ...scenario,
      cases: scenario.cases.length > 0 ? scenario.cases : doc.scenarios[idx]!.cases,
    };
    doc.scenarios[idx] = merged;
  } else {
    doc.scenarios.push(scenario);
  }
  await persist(requirementId, doc);
}

export async function upsertCase(requirementId: string, scenarioId: string | null, c: StagedCase): Promise<void> {
  const doc = await readOrEmpty(requirementId);
  if (scenarioId === null) {
    const idx = doc.looseCases.findIndex((x) => x.id === c.id);
    if (idx >= 0) doc.looseCases[idx] = c; else doc.looseCases.push(c);
  } else {
    const s = doc.scenarios.find((x) => x.id === scenarioId);
    if (!s) throw new Error(`scenario ${scenarioId} not found; call upsert_scenario first`);
    const idx = s.cases.findIndex((x) => x.id === c.id);
    if (idx >= 0) s.cases[idx] = c; else s.cases.push(c);
  }
  await persist(requirementId, doc);
}

export async function removeItem(requirementId: string, item: { kind: 'scenario' | 'case'; id: string; scenarioId?: string | null }): Promise<void> {
  const doc = await readOrEmpty(requirementId);
  if (item.kind === 'scenario') {
    doc.scenarios = doc.scenarios.filter((s) => s.id !== item.id);
  } else {
    if (item.scenarioId == null) {
      doc.looseCases = doc.looseCases.filter((c) => c.id !== item.id);
    } else {
      const s = doc.scenarios.find((x) => x.id === item.scenarioId);
      if (s) s.cases = s.cases.filter((c) => c.id !== item.id);
    }
  }
  await persist(requirementId, doc);
}

export async function removeSaved(requirementId: string, savedCaseIds: string[]): Promise<void> {
  const idSet = new Set(savedCaseIds);
  const doc = await readOrEmpty(requirementId);
  doc.looseCases = doc.looseCases.filter((c) => !idSet.has(c.id));
  doc.scenarios = doc.scenarios.flatMap((s) => {
    if (s.cases.length === 0) return [s]; // 从来就没有用例的场景原样保留
    const casesAfter = s.cases.filter((c) => !idSet.has(c.id));
    if (casesAfter.length === 0) return []; // 整组被 save 清空时丢掉
    return [{ ...s, cases: casesAfter }];
  });
  await persist(requirementId, doc);
}