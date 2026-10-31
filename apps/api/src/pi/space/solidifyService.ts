/**
 * R3 固化管线：盘点批次（LLM 蒸馏产提案）。
 * LLM 只产提案不直接改任何资产；应用一律走 solidifyApply 的人工审批。
 * 失败语义：LLM 未配置/超时/输出整体不合法 → 批次 failed；单条提案不合法 →
 * 丢弃该条不炸批次（spec §5.2）。inline fire-and-forget，不引 BullMQ。
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { db } from '../../db/client.js';
import {
  assistantMemories, assistantSkills, assistantSolidifyBatches,
  assistantSolidifyProposals, assistantTrajectories, productLines,
} from '../../db/schema.js';
import { readLlmConfig } from '../modelBridge.js';
import { completeJson, getLlmClient, type LLMClient } from '../../agent/llm-client.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { listPromptModuleDefs } from './promptModules.js';

const SOLIDIFY_SYSTEM_PROMPT = `你是测试助手平台的「经验固化盘点器」。输入是平台积累的短期记忆与成功轨迹（各带来源产品线标识），以及平台现有 skill 清单与可编辑提示词模块清单。

任务：从中提炼【非业务、跨产品线普适】的经验，产出「固化提案」——你只产提案，所有应用都经人工审批。

输出只含 JSON（不要 markdown 围栏）：
{"proposals":[{"kind":"...","target":"...","title":"...","body":"...","rationale":"...","sources":["<输入条目id>"]}],"notes":["..."]}

字段要求：
- kind："prompt_amendment"（追加到系统提示词模块）或 "skill_revision"（修订现有 skill 的完整正文）
- target：prompt_amendment 时只能从【prompt_amendment 可选 target】清单中选；skill_revision 时只能从【现有 skill 清单】中选
- title：≤60 字的人话提案名（审批列表用）
- body：prompt_amendment = 要追加的增量文案（markdown，会被拼到模块当前值尾部）；skill_revision = 修订后的完整正文（markdown，不含 frontmatter）
- rationale：为什么值得固化，必须写明有几条产品线来源支撑（如「3 条来源线：线A/线B/global」）
- sources：支撑本提案的输入条目 id 数组（只能从输入条目中选）

四条判据——全部满足才产提案：
1. 跨线普适：≥2 条产品线来源支撑（global 记忆可作一条线）。单线孤证不固化。
2. 非线内事实：不得含 URL、账号、data-testid/锚点、产品名、密码/令牌/API key 等凭据。凭据出现在任何输出字段即违规。
3. 可操作：能落成具体的提示词增量文案或 skill 正文修订，不是空泛建议。
4. 去碎片化：先查现有 skill 清单——有落点才产 skill_revision；泛化经验没有现成 skill 落点时不要硬凑 target，写进 notes：「建议人工用 skill-creator 新建：<一句话>」。

notes：无法落成提案但有价值的观察（无 skill 落点的泛化经验、低质量信号等），没有就空数组。`;

const ProposalSchema = z.object({
  kind: z.enum(['prompt_amendment', 'skill_revision']),
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

    // 输入：全库 active 记忆 + active 轨迹，合并按 hit_count 降序取 top 200（高频优先，防 prompt 爆炸）
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

    if (merged.length === 0) {
      await db.update(assistantSolidifyBatches).set({
        status: 'done',
        inputSummary: JSON.stringify({ memories: 0, trajectories: 0, proposals: 0, notes: [] }),
        updatedAt: new Date(),
      }).where(eq(assistantSolidifyBatches.id, batchId));
      return;
    }

    const skillRows = await db.select({ name: assistantSkills.name, description: assistantSkills.description })
      .from(assistantSkills).where(eq(assistantSkills.enabled, true));
    const promptKeys = (await listPromptModuleDefs()).filter((d) => d.group !== 'skill');

    const userMessage = [
      '【输入条目】（type/id/来源线/hit/标题 + 内容；来源线 global 表示全局记忆）',
      ...merged.map((s, i) => `[${i + 1}] type=${s.type} id=${s.id} 线=${s.line} hit=${s.hitCount} 标题=${s.title}\n${s.text}`),
      '',
      '【现有 skill 清单】（skill_revision 的 target 只能从中选）',
      ...skillRows.map((s) => `- ${s.name} | ${s.description}`),
      '',
      '【prompt_amendment 可选 target】（只能从中选）',
      ...promptKeys.map((d) => `- ${d.key}（${d.label}）`),
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

    // 服务端校验：target 落点 + sources 修剪；retireRecommended 服务端定值（不信任 LLM）。
    const skillNames = new Set(skillRows.map((s) => s.name));
    const promptKeySet = new Set(promptKeys.map((d) => d.key));
    const sourceById = new Map(merged.map((s) => [s.id, s]));
    const notes = [...parsed.data.notes];
    const inserts: Array<typeof assistantSolidifyProposals.$inferInsert> = [];
    for (const raw of parsed.data.proposals) {
      const p = ProposalSchema.safeParse(raw);
      if (!p.success) {
        notes.push(`已丢弃一条形状不合法的提案：${p.error.issues[0]?.message ?? 'unknown'}`);
        continue;
      }
      const targetOk = p.data.kind === 'prompt_amendment' ? promptKeySet.has(p.data.target) : skillNames.has(p.data.target);
      if (!targetOk) {
        notes.push(`已丢弃「${p.data.title}」：target 无落点（${p.data.target}）`);
        continue;
      }
      const sources = p.data.sources
        .filter((id) => sourceById.has(id))
        .map((id) => {
          const s = sourceById.get(id)!;
          return {
            type: s.type, id, title: s.title.slice(0, 120),
            lineName: s.line === 'global' ? 'global' : (lineNames.get(s.line) ?? 'unknown'),
            retireRecommended: s.type === 'memory',
          };
        });
      if (sources.length === 0) {
        notes.push(`已丢弃「${p.data.title}」：sources 全部无效`);
        continue;
      }
      inserts.push({
        batchId,
        kind: p.data.kind,
        target: p.data.target,
        title: p.data.title.slice(0, 200),
        body: p.data.body,
        rationale: p.data.rationale,
        sources,
        status: 'pending',
        distillModel: r.model ?? 'unknown',
      });
    }
    if (inserts.length > 0) await db.insert(assistantSolidifyProposals).values(inserts);

    await db.update(assistantSolidifyBatches).set({
      status: 'done',
      inputSummary: JSON.stringify({
        memories: memRows.length, trajectories: trajRows.length,
        proposals: inserts.length, notes,
      }),
      updatedAt: new Date(),
    }).where(eq(assistantSolidifyBatches.id, batchId));
  } catch (e) {
    logger.warn({ err: e, batchId }, 'solidify: scan failed');
    await fail((e as Error).message);
  }
}
