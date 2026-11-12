/**
 * R3.5 failure-lesson distillation layer:
 *  - collectUnconsumedSignals: S1 rollback/restore-default (direct query over the existing version
 *    chain) + S2 negative feedback + S3 nl_ai_fail + R3.6 S4 session (last-7-days session quality;
 *    collector in sessionSignals.ts), filtering out signals "already referenced by any-status
 *    lesson's signals" (one-shot consumption, preventing a retire→re-feed loop).
 *  - distillLessons: LLM call#1, per-item attribution (prompt/step_description/platform/sut);
 *    a bad item is dropped without blowing the batch; an overall failure throws and the caller
 *    degrades (solidifyService).
 *  - listProposalInputLessons: for the phase-2 input — only active lessons of
 *    prompt/step_description; ones referenced by pending/approved proposals are blocked, ones
 *    referenced by rejected proposals are marked "had a proposal rejected".
 * This file is imported by solidifyService and must not depend back on it — withLlmTimeout carries
 * its own copy (avoids an import cycle).
 */
import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  aiAssistantFeedback, assistantFailureLessons, assistantFailureSignals,
  assistantPromptModuleVersions, assistantSolidifyProposals, productLines, projects,
} from '../../db/schema.js';
import { completeJson, type LLMClient } from '../../agent/llm-client.js';
import { collectSessionSignals } from './sessionSignals.js';

export type SignalType = 'rollback' | 'restore_default' | 'negative_feedback' | 'nl_ai_fail' | 'session';

export interface CollectedSignal {
  /** LLM reference key: rollback#<seq> / negfb#<uuid> / nlaifail#<uuid> / session#<threadId>#<epoch>. */
  key: string;
  type: SignalType;
  /** Consumption idempotency bookkeeping: version row seq (S1, stringified) / row uuid (S2/S3) / threadId#epoch (S4). */
  refId: string;
  time: string;
  line: string;
  title: string;
  excerpt: string;
  /** S1 only: the rolled-back row's source=solidify_apply (R3's own output-quality feedback). */
  selfSolidify: boolean;
}

const SIGNAL_CAP = 60;
const TEXT_CAP = 400;
const clip = (s: string, n = TEXT_CAP) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Signal collection (queries + fs scan, no LLM). Returns: signals = the truncated distillation input; total = unconsumed count; notes = collector-layer guard hints (over 8MB etc.). */
export async function collectUnconsumedSignals(deps?: { sessionsRoot?: string }): Promise<{ signals: CollectedSignal[]; total: number; notes: string[] }> {
  const lessons = await db.select({ signals: assistantFailureLessons.signals }).from(assistantFailureLessons);
  const consumed = new Set<string>();
  for (const l of lessons) {
    for (const s of (Array.isArray(l.signals) ? l.signals : []) as Array<{ refId?: string }>) {
      if (s?.refId) consumed.add(s.refId);
    }
  }

  const collected: CollectedSignal[] = [];

  // S1: prompt module rollback/restore-default — a human already judged this version's copy faulty (highest attribution precision, zero cost)
  const versionRows = await db.select().from(assistantPromptModuleVersions)
    .orderBy(asc(assistantPromptModuleVersions.seq));
  const byKey = new Map<string, typeof versionRows>();
  for (const r of versionRows) {
    const arr = byKey.get(r.moduleKey) ?? [];
    arr.push(r);
    byKey.set(r.moduleKey, arr);
  }
  for (const rows of byKey.values()) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const isRestore = r.source === 'manual_edit' && r.value == null;
      if (r.source !== 'rollback' && !isRestore) continue;
      if (consumed.has(String(r.seq))) continue;
      // The abandoned copy = the nearest preceding non-null value row of the same module
      let prev: (typeof rows)[number] | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (rows[j]!.value != null) { prev = rows[j]; break; }
      }
      collected.push({
        key: `rollback#${r.seq}`,
        type: r.source === 'rollback' ? 'rollback' : 'restore_default',
        refId: String(r.seq),
        time: r.createdAt.toISOString(),
        line: 'global',
        title: `模块 ${r.moduleKey} 被人工${r.source === 'rollback' ? '回滚' : '恢复默认'}`
          + (prev?.source === 'solidify_apply' ? '（被回滚的是固化提案应用的版本——固化自身输出质量反馈）' : ''),
        excerpt: clip(`被放弃的文案：\n${prev?.value ?? '（无历史值）'}\n→ 现值：${r.value ?? '（恢复跟随代码默认）'}`),
        selfSolidify: prev?.source === 'solidify_apply',
      });
    }
  }

  const lineNames = new Map(
    (await db.select({ id: productLines.id, name: productLines.name }).from(productLines))
      .map((l) => [l.id, l.name] as const),
  );

  // S2: negative user feedback (the Phase-1 collect-only table finally has a consumer)
  const fbRows = await db.select().from(aiAssistantFeedback)
    .where(eq(aiAssistantFeedback.sentiment, 'negative'))
    .orderBy(desc(aiAssistantFeedback.createdAt)).limit(200);
  if (fbRows.length > 0) {
    const projectLine = new Map(
      (await db.select({ id: projects.id, productLineId: projects.productLineId }).from(projects))
        .map((p) => [p.id, p.productLineId] as const),
    );
    for (const f of fbRows) {
      if (consumed.has(f.id)) continue;
      const lineId = projectLine.get(f.projectId);
      collected.push({
        key: `negfb#${f.id}`,
        type: 'negative_feedback',
        refId: f.id,
        time: f.createdAt.toISOString(),
        line: lineId ? (lineNames.get(lineId) ?? 'unknown') : 'unknown',
        title: '用户负向反馈',
        excerpt: clip(`${f.messageExcerpt ?? '（无消息快照）'}${f.comment ? `\n用户补充：${f.comment}` : ''}`),
        selfSolidify: false,
      });
    }
  }

  // S3: verify natural-language step AI-phase failure (rows written by the collection layer)
  const s3Rows = await db.select().from(assistantFailureSignals)
    .where(eq(assistantFailureSignals.type, 'nl_ai_fail'))
    .orderBy(desc(assistantFailureSignals.createdAt)).limit(200);
  for (const s of s3Rows) {
    if (consumed.has(s.id)) continue;
    const p = (s.payload ?? {}) as Record<string, unknown>;
    collected.push({
      key: `nlaifail#${s.id}`,
      type: 'nl_ai_fail',
      refId: s.id,
      time: s.createdAt.toISOString(),
      line: s.productLineId ? (lineNames.get(s.productLineId) ?? 'unknown') : 'unknown',
      title: `用例「${String(p.caseTitle ?? '?')}」第 ${s.stepOrder} 步 AI 相失败（${String(p.failureReason ?? '?')}）`,
      excerpt: clip(`步骤原文「${String(p.stepInstruction ?? '')}」；页面 ${String(p.pageUrl ?? p.targetUrl ?? '?')}`),
      selfSolidify: false,
    });
  }

  // S4: last-7-days session quality (R3.6; the collector pre-filters by consumption idempotency — ownership of consumed stays in this layer)
  const sessionBundle = await collectSessionSignals({ consumedRefIds: consumed, sessionsRoot: deps?.sessionsRoot });
  for (const s of sessionBundle.signals) {
    collected.push({
      key: s.key,
      type: 'session',
      refId: s.refId,
      time: s.time,
      line: 'global',
      title: s.title,
      excerpt: s.excerpt,
      selfSolidify: false,
    });
  }

  const total = collected.length;
  // S1 leads first so it naturally wins priority; session appends go last and get cut first — when over quota S4 is sacrificed (sampling already capped at 12)
  return { signals: collected.slice(0, SIGNAL_CAP), total, notes: sessionBundle.notes };
}

// ── Lesson distillation (LLM call #1) ──

const LESSON_SYSTEM_PROMPT = `你是测试助手平台的「失败教训蒸馏器」。输入是平台采集到的原始失败信号清单（每条带 key、类型、时间、来源线与证据摘录）。

任务：把相关信号归并、归因，蒸馏成结构化「失败教训」。归因是判断题——每条教训必须判定失败层：
- prompt：能指出某条常驻提示词/引导文案的某表述直接导致误解（如断言未限定实测范围被泛化）
- step_description：步骤描述写法与页面不符，且根源在「如何写步骤」的引导质量
- platform：平台闸门/机制缺陷（如 locator 校验误杀、元素清单截断误导）
- sut：被测系统环境问题（环境不可用、数据不满足、第三方服务异常）

type=session 的信号是近 7 天 chat 会话的质量采样：摘录头是量化指标（时长/轮数/verify 次数/工具错误/重复调用/嫌疑分），后跟压缩会话流。这类信号的归因判别——
- 归 prompt 或 step_description：会话里的冗余绕探、verify 死循环、产出不够专业等，能具体指出是哪条引导文案导致 AI 没按专业测试专家的方式工作（专家会一次核清再动手，不会同参反复试）
- 归 platform：各轮间隔均匀偏长（如每轮单调用 60-90s）而无任何冗余逻辑、容器/网关停顿类证据——这是平台慢，必须判 platform，严禁写成提示词问题

判定不了 → 不产该条教训（宁缺毋滥，严禁硬凑归因）。

输出只含 JSON（不要 markdown 围栏）：
{"lessons":[{"attribution":"prompt","title":"...","lesson":"现象:...根因:...影响面:...建议:...","signalRefs":["<信号key>"]}],"notes":["..."]}

要求：
- title：≤60 字人话教训名，具体到表述/机制级颗粒度（如「guide 断言未限定实测范围导致泛化出自动登录」）
- lesson：四段结构「现象:…根因:…影响面:…建议修正方向:…」；建议修正方向只写方向不写全文
- signalRefs：支撑本教训的信号 key（只能从输入信号中选），每条教训至少引用 1 个
- 同一根因的多个信号归并进一条教训；不同根因分开多条
- notes：无法归因但有价值的观察，没有就空数组`;

const LessonSchema = z.object({
  attribution: z.enum(['prompt', 'step_description', 'platform', 'sut']),
  title: z.string().min(1).max(200),
  lesson: z.string().min(1).max(8_000),
  signalRefs: z.array(z.string().min(1)).min(1),
});

/** Loose outer layer (lessons validated one by one; a bad item is dropped without blowing the batch); notes cap guards against blowups. */
const LessonOutput = z.object({
  lessons: z.array(z.unknown()).max(20),
  notes: z.array(z.string().max(500)).max(20).default([]),
});

/** LLM timeout guard (same as solidifyService; this file must not import back — avoids an import cycle). */
function withLlmTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`failureLessons: distill LLM timeout (${ms}ms)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Lesson distillation: on success returns the number of rows inserted; an overall failure throws (caller degrades: the batch continues, signals stay for retry). */
export async function distillLessons(client: LLMClient, signals: CollectedSignal[], timeoutMs: number): Promise<number> {
  const userMessage = [
    '【失败信号】（key/类型/时间/来源线/摘录；signalRefs 只能引用这些 key）',
    ...signals.map((s) => `[${s.key}] type=${s.type} 时间=${s.time} 线=${s.line}\n${s.title}\n${s.excerpt}`),
  ].join('\n');
  const r = await withLlmTimeout(
    completeJson(client, { systemPrompt: LESSON_SYSTEM_PROMPT, userMessage }),
    timeoutMs,
  );
  const parsed = LessonOutput.safeParse(r.value);
  if (!parsed.success) throw new Error(`教训输出不合法：${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  const byKey = new Map(signals.map((s) => [s.key, s]));
  const inserts: Array<typeof assistantFailureLessons.$inferInsert> = [];
  for (const raw of parsed.data.lessons) {
    const l = LessonSchema.safeParse(raw);
    if (!l.success) continue; // a bad item is dropped without blowing the batch
    const refs = l.data.signalRefs
      .filter((k) => byKey.has(k))
      .map((k) => {
        const s = byKey.get(k)!;
        return { type: s.type, refId: s.refId, excerpt: clip(s.title, 200) };
      });
    if (refs.length === 0) continue; // drop when references empty out after filtering (same as R3 sources)
    inserts.push({
      status: 'active',
      attribution: l.data.attribution,
      title: l.data.title.slice(0, 200),
      lesson: l.data.lesson,
      signals: refs,
      distillModel: r.model ?? 'unknown',
    });
  }
  if (inserts.length > 0) await db.insert(assistantFailureLessons).values(inserts);
  return inserts.length;
}

// ── Phase 2 input queries ──

export interface LessonForInput {
  id: string;
  attribution: 'prompt' | 'step_description';
  title: string;
  lesson: string;
  signalCount: number;
  previouslyRejected: boolean;
}

/** The phase-2 【failure lessons】 input: active + prompt/step_description;
 *  referenced by pending/approved proposals → blocked (prevents repeat proposals for the same case); referenced by rejected → noted. */
export async function listProposalInputLessons(): Promise<LessonForInput[]> {
  const rows = await db.select().from(assistantFailureLessons)
    .where(eq(assistantFailureLessons.status, 'active'))
    .orderBy(desc(assistantFailureLessons.createdAt)).limit(50);
  const candidates = rows.filter((l) => l.attribution === 'prompt' || l.attribution === 'step_description');
  if (candidates.length === 0) return [];
  const props = await db.select({ status: assistantSolidifyProposals.status, sources: assistantSolidifyProposals.sources })
    .from(assistantSolidifyProposals);
  const refStatuses = new Map<string, string[]>();
  for (const p of props) {
    for (const s of p.sources) {
      if (s.type === 'lesson') refStatuses.set(s.id, [...(refStatuses.get(s.id) ?? []), p.status]);
    }
  }
  return candidates
    .filter((l) => !(refStatuses.get(l.id) ?? []).some((st) => st === 'pending' || st === 'approved'))
    .map((l) => ({
      id: l.id,
      attribution: l.attribution as LessonForInput['attribution'],
      title: l.title,
      lesson: l.lesson,
      signalCount: Array.isArray(l.signals) ? (l.signals as unknown[]).length : 0,
      previouslyRejected: (refStatuses.get(l.id) ?? []).includes('rejected'),
    }));
}
