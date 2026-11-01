/**
 * R3/R3.5 固化管线：盘点三阶段（0 信号采集零 LLM → 1 教训蒸馏 → 2 资产蒸馏 → 3 服务端校验入库）。
 * LLM 只产提案不直接改任何资产；应用一律走 solidifyApply 的人工审批。
 * 失败语义：LLM 未配置/超时/输出整体不合法 → 批次 failed；单条提案不合法 → 丢弃该条不炸批次；
 * 阶段 1 教训蒸馏整体失败 → 降级不炸批次（note 记录，信号保留待重试）。
 * inline fire-and-forget，不引 BullMQ。
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { db } from '../../db/client.js';
import {
  assistantMemories, assistantSkills, assistantSolidifyBatches,
  assistantSolidifyProposals, assistantTrajectories, productLines,
  type AssistantSolidifyProposalSource,
} from '../../db/schema.js';
import { readLlmConfig } from '../modelBridge.js';
import { completeJson, getLlmClient, type LLMClient } from '../../agent/llm-client.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { listPromptModuleDefs, loadPromptModuleOverrides } from './promptModules.js';
import { collectUnconsumedSignals, distillLessons, listProposalInputLessons } from './failureLessons.js';

const SOLIDIFY_SYSTEM_PROMPT = `你是测试助手平台的「经验固化盘点器」。输入是平台积累的短期记忆与成功轨迹（各带来源产品线标识）、平台现有 skill 清单、可编辑提示词模块清单，以及（如有）失败教训清单（带失败层归因与证据信号数）。

任务：产出「固化提案」——你只产提案，所有应用都经人工审批。

输出只含 JSON（不要 markdown 围栏）：
{"proposals":[{"kind":"...","target":"...","title":"...","body":"...","rationale":"...","sources":["<输入条目id>"]}],"notes":["..."]}

字段要求：
- kind："prompt_amendment"（追加到系统提示词模块）| "skill_revision"（修订现有 skill 的完整正文）| "prompt_correction"（全文修正某个提示词模块）
- target：prompt_amendment / prompt_correction 只能从【prompt_amendment 可选 target】清单中选；skill_revision 只能从【现有 skill 清单】中选
- title：≤60 字的人话提案名（审批列表用）
- body：prompt_amendment = 要追加的增量文案（markdown，拼到模块当前值尾部）；skill_revision = 修订后的完整正文（markdown，不含 frontmatter）；prompt_correction = 修正后的模块完整正文（markdown，可增可删可改，应用时整体覆盖模块当前值）
- rationale：为什么值得固化。prompt_amendment / skill_revision 必须写明有几条产品线来源支撑（如「3 条来源线：线A/线B/global」）；prompt_correction 必须写明信号数与信号类型（如「2 个独立失败信号命中同一误解」「1 次人工回滚（人工已判定）」或「3 条 session 会话证据同指一类死循环」）
- sources：支撑本提案的输入条目 id 数组。prompt_amendment / skill_revision 从【输入条目】中选；prompt_correction 只能从【失败教训】中选（用教训 id）

四条判据——全部满足才产提案：
1. 非线内事实：不得含 URL、账号、data-testid/锚点、产品名、密码/令牌/API key 等凭据。凭据出现在任何输出字段即违规（prompt_correction 的修正文案同样适用）。
2. 可操作：能落成具体的文案/正文，不是空泛建议。
3. 去碎片化：先查现有 skill 清单——有落点才产 skill_revision；泛化经验没有现成 skill 落点时不要硬凑 target，写进 notes：「建议人工用 skill-creator 新建：<一句话>」。
4. 按形状分证据判据：
   - prompt_amendment / skill_revision：跨线普适——≥2 条产品线来源支撑（global 记忆可作一条线）。单线孤证不固化。
   - prompt_correction：频次——同一模块同一类误解被 ≥2 个独立失败教训/信号命中（含 session 会话证据教训）；或单个人工回滚类教训即可（人工已判定=最强证据）。按教训正文的「建议修正方向」写 body；教训之间互相冲突时不产提案写进 notes。【失败教训】里不会出现 platform/sut 归因的条目——严禁凭空猜测平台问题来写提示词补丁。

notes：无法落成提案但有价值的观察（无 skill 落点的泛化经验、低质量信号等），没有就空数组。`;

const ProposalSchema = z.object({
  kind: z.enum(['prompt_amendment', 'skill_revision', 'prompt_correction']),
  target: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  rationale: z.string().min(1).max(4_000),
  sources: z.array(z.string().uuid()).min(1),
});

/** 外层宽松（proposals 逐条校验，单条坏丢弃不炸批次）；notes 上限防炸 summary。 */
const SolidifyOutput = z.object({
  proposals: z.array(z.unknown()).max(20),
  notes: z.array(z.string().max(500)).max(20).default([]),
});

/** 发起盘点：running 防重入（409）。返回批次 id；蒸馏由调用方 fire-and-forget。 */
export async function startSolidifyScan(userId: string | null): Promise<string> {
  const running = await db.select({ id: assistantSolidifyBatches.id }).from(assistantSolidifyBatches)
    .where(eq(assistantSolidifyBatches.status, 'running')).limit(1);
  if (running.length > 0) throw new HttpError(409, 'scan_running', '已有盘点批次在进行中');
  return (await db.insert(assistantSolidifyBatches).values({ status: 'running', createdBy: userId })
    .returning({ id: assistantSolidifyBatches.id }))[0]!.id;
}

async function llmClientFromConfig(): Promise<LLMClient | null> {
  const cfg = await readLlmConfig();
  if (!cfg) return null;
  return getLlmClient({ provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model, baseUrl: cfg.baseUrl ?? undefined });
}

/** LLM 超时护栏（与 scheduler/trajectoryWorker 同款；不共享是为免 space↔scheduler import 环）。 */
function withLlmTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`solidify: distill LLM timeout (${ms}ms)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface SolidifyRunDeps {
  /** 注入 LLM client（测试）；缺省读 settings 自建，未配置 → 批次 failed。 */
  client?: LLMClient;
  llmTimeoutMs?: number;
  /** 注入会话根目录（测试 DI）；透传给 S4 会话采集器，缺省 DATA_DIR/pi-sessions。 */
  sessionsRoot?: string;
}

/** 执行盘点：输入聚合 → LLM 蒸馏 → 服务端校验 → 提案入库 → 批次 done。 */
export async function runSolidifyScan(batchId: string, deps: SolidifyRunDeps = {}): Promise<void> {
  const fail = async (error: string) => {
    await db.update(assistantSolidifyBatches)
      .set({ status: 'failed', error, updatedAt: new Date() })
      .where(eq(assistantSolidifyBatches.id, batchId));
  };
  try {
    const client = deps.client ?? await llmClientFromConfig();
    if (!client) {
      await fail('LLM 未配置：请先到设置页配置模型');
      return;
    }
    // 阶段 1 的降级 note 也要进 summary——notes 提到最前声明。
    const notes: string[] = [];

    // ── 阶段 0：输入聚合（零 LLM）──
    // 资产池：全库 active 记忆 + active 轨迹，合并按 hit_count 降序取 top 200（高频优先，防 prompt 爆炸）
    const memRows = await db.select({
      id: assistantMemories.id, scope: assistantMemories.scope, productLineId: assistantMemories.productLineId,
      title: assistantMemories.title, hook: assistantMemories.hook, body: assistantMemories.body,
      hitCount: assistantMemories.hitCount,
    }).from(assistantMemories).where(eq(assistantMemories.status, 'active'));
    const trajRows = await db.select({
      id: assistantTrajectories.id, productLineId: assistantTrajectories.productLineId,
      taskTitle: assistantTrajectories.taskTitle, digest: assistantTrajectories.digest,
      hitCount: assistantTrajectories.hitCount,
    }).from(assistantTrajectories).where(eq(assistantTrajectories.status, 'active'));
    const lineNames = new Map(
      (await db.select({ id: productLines.id, name: productLines.name }).from(productLines))
        .map((l) => [l.id, l.name] as const),
    );
    const merged = [
      ...memRows.map((m) => ({
        type: 'memory' as const, id: m.id,
        line: m.scope === 'global' ? 'global' : (m.productLineId ?? 'unknown'),
        title: m.title, text: `${m.hook}\n${m.body ?? ''}`, hitCount: m.hitCount,
      })),
      ...trajRows.map((t) => ({
        type: 'trajectory' as const, id: t.id, line: t.productLineId,
        title: t.taskTitle, text: t.digest, hitCount: t.hitCount,
      })),
    ].sort((a, b) => b.hitCount - a.hitCount).slice(0, 200);
    // 失败信号采集（零 LLM）：S1 回滚/恢复默认 + S2 负反馈 + S3 nl_ai_fail + S4 会话质量，已消费的剔除
    const signalBundle = await collectUnconsumedSignals({ sessionsRoot: deps.sessionsRoot });

    // 空资产池但有未消费信号 → 不早退（教训可独立产提案）；两者全空才直接 done。
    if (merged.length === 0 && signalBundle.signals.length === 0) {
      await db.update(assistantSolidifyBatches).set({
        status: 'done',
        inputSummary: JSON.stringify({ memories: 0, trajectories: 0, lessons: 0, signals: 0, proposals: 0, notes: [] }),
        updatedAt: new Date(),
      }).where(eq(assistantSolidifyBatches.id, batchId));
      return;
    }

    // 采集层护栏 note（如 >8MB 会话跳过）并入 summary；早退路径 summary 硬编码零改动
    notes.push(...signalBundle.notes);

    // ── 阶段 1：失败教训蒸馏（有信号才执行；整体失败降级不炸批次，信号保留待重试）──
    if (signalBundle.signals.length > 0) {
      try {
        const distilled = await distillLessons(client, signalBundle.signals, deps.llmTimeoutMs ?? 180_000);
        if (distilled === 0) notes.push(`教训蒸馏未产出新教训（${signalBundle.total} 条信号保留待下次盘点）`);
      } catch (e) {
        logger.warn({ err: e, batchId }, 'solidify: lesson distill failed (degraded, signals retained)');
        notes.push('教训蒸馏失败（信号保留待下次盘点重试）');
      }
    }

    // ── 阶段 2：资产蒸馏（LLM call#2）——教训清单拼进输入 ──
    const skillRows = await db.select({ name: assistantSkills.name, description: assistantSkills.description })
      .from(assistantSkills).where(eq(assistantSkills.enabled, true));
    const promptKeys = (await listPromptModuleDefs()).filter((d) => d.group !== 'skill');
    const lessons = await listProposalInputLessons();

    const userMessage = [
      '【输入条目】（type/id/来源线/hit/标题 + 内容；来源线 global 表示全局记忆）',
      ...merged.map((s, i) => `[${i + 1}] type=${s.type} id=${s.id} 线=${s.line} hit=${s.hitCount} 标题=${s.title}\n${s.text}`),
      '',
      '【现有 skill 清单】（skill_revision 的 target 只能从中选）',
      ...skillRows.map((s) => `- ${s.name} | ${s.description}`),
      '',
      '【prompt_amendment 可选 target】（只能从中选）',
      ...promptKeys.map((d) => `- ${d.key}（${d.label}）`),
      ...(lessons.length > 0 ? [
        '',
        '【失败教训】（prompt_correction 的证据来源；attribution=prompt/step_description 才会出现）',
        ...lessons.map((l, i) => `[L${i + 1}] id=${l.id} attribution=${l.attribution} 信号数=${l.signalCount}${l.previouslyRejected ? '（曾有提案被驳回，除非有新证据勿重复同案）' : ''}\n标题=${l.title}\n${l.lesson}`),
      ] : []),
    ].join('\n');

    const r = await withLlmTimeout(
      completeJson(client, { systemPrompt: SOLIDIFY_SYSTEM_PROMPT, userMessage }),
      deps.llmTimeoutMs ?? 180_000,
    );
    const parsed = SolidifyOutput.safeParse(r.value);
    if (!parsed.success) {
      await fail(`LLM 输出不合法：${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
      return;
    }
    notes.push(...parsed.data.notes);

    // ── 阶段 3：服务端校验——target 落点 + sources 修剪双轨（lesson / 资产条目）；retireRecommended 服务端定值 ──
    const skillNames = new Set(skillRows.map((s) => s.name));
    const promptKeySet = new Set(promptKeys.map((d) => d.key));
    const sourceById = new Map(merged.map((s) => [s.id, s]));
    const lessonById = new Map(lessons.map((l) => [l.id, l]));
    const overrides = await loadPromptModuleOverrides();
    const inserts: Array<typeof assistantSolidifyProposals.$inferInsert> = [];
    for (const raw of parsed.data.proposals) {
      const p = ProposalSchema.safeParse(raw);
      if (!p.success) {
        notes.push(`已丢弃一条形状不合法的提案：${p.error.issues[0]?.message ?? 'unknown'}`);
        continue;
      }
      // promptKeySet 本就只含 group!=='skill' 的模块——prompt_correction 的 skill.* target 在此天然被拒
      const targetOk = p.data.kind === 'skill_revision' ? skillNames.has(p.data.target) : promptKeySet.has(p.data.target);
      if (!targetOk) {
        notes.push(`已丢弃「${p.data.title}」：target 无落点（${p.data.target}）`);
        continue;
      }
      let sources: AssistantSolidifyProposalSource[];
      let baseSeq: number | null = null;
      if (p.data.kind === 'prompt_correction') {
        const ls = p.data.sources.filter((id) => lessonById.has(id)).map((id) => {
          const l = lessonById.get(id)!;
          return {
            type: 'lesson' as const, id, title: l.title.slice(0, 120), lineName: '',
            retireRecommended: false, attribution: l.attribution, signalCount: l.signalCount,
          };
        });
        if (ls.length === 0) {
          notes.push(`已丢弃「${p.data.title}」：sources 全部无效`);
          continue;
        }
        sources = ls;
        baseSeq = overrides.get(p.data.target)?.seq ?? null; // 服务端定值：盘点时定格
      } else {
        const ss = p.data.sources
          .filter((id) => sourceById.has(id))
          .map((id) => {
            const s = sourceById.get(id)!;
            return {
              type: s.type, id, title: s.title.slice(0, 120),
              lineName: s.line === 'global' ? 'global' : (lineNames.get(s.line) ?? 'unknown'),
              retireRecommended: s.type === 'memory',
            };
          });
        if (ss.length === 0) {
          notes.push(`已丢弃「${p.data.title}」：sources 全部无效`);
          continue;
        }
        sources = ss;
      }
      inserts.push({
        batchId,
        kind: p.data.kind,
        target: p.data.target,
        title: p.data.title.slice(0, 200),
        body: p.data.body,
        rationale: p.data.rationale,
        sources,
        baseSeq,
        status: 'pending',
        distillModel: r.model ?? 'unknown',
      });
    }
    if (inserts.length > 0) await db.insert(assistantSolidifyProposals).values(inserts);

    await db.update(assistantSolidifyBatches).set({
      status: 'done',
      inputSummary: JSON.stringify({
        memories: memRows.length, trajectories: trajRows.length,
        lessons: lessons.length, signals: signalBundle.total,
        proposals: inserts.length, notes,
      }),
      updatedAt: new Date(),
    }).where(eq(assistantSolidifyBatches.id, batchId));
  } catch (e) {
    logger.warn({ err: e, batchId }, 'solidify: scan failed');
    await fail((e as Error).message);
  }
}
