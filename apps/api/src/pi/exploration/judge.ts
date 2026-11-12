/**
 * A3 独立评审：会话收尾后，对每条 finding 做一次独立判定（这条缺陷到底成不成立）。
 *
 * 为什么必须独立：探索者是「自己找茬自己报」——同一套推理里既有观察也有结论，
 * 自评天然偏乐观（报上来的都像真的）。评审要换一个视角、只看材料：
 * - 只喂：缺陷描述 + 平台动作留痕（机械记录的事实）+ 决策帧截图；
 * - 不喂：探索者的推理过程（模型自述的「我为什么这么判断」）。
 * 评审结论只是**标注**（findings.judge），绝不改 findings.status——人工审阅才是权威。
 *
 * 幂等：judge_status=done 的会话直接跳过（重复触发不重复烧钱、不覆盖既有结论）。
 * 永不抛错：评审失败只落 judge_status=failed，不影响会话终态。
 */
import { eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { db } from '../../db/client.js';
import { explorationFindings, explorationSessions } from '../../db/schema.js';
import { completeJson, type LLMClient } from '../../agent/llm-client.js';
import { resolveLlmClient } from '../../agent/llmSettings.js';
import { screenshotDiskPath, withTimeout } from '../../execute/explorationShared.js';
import { logger } from '../../logger.js';

/** 评审判定：成立 / 不成立 / 材料不足。 */
export type JudgeVerdict = 'confirmed' | 'dismissed' | 'unclear';

export interface JudgeFinding {
  id: string;
  verdict: JudgeVerdict;
  reason: string;
  confidence: number;
}

/** 单次评审调用超时（软失败：超时 = 该条 unclear）。 */
const JUDGE_TIMEOUT_MS = 90_000;
/** 单次评审喂的动作留痕步数上限（超长截断——留痕是证据，不是全文转录）。 */
const JUDGE_TRAIL_MAX = 60;
/** 单次评审喂的描述长度上限。 */
const JUDGE_DESC_MAX = 2000;

const JUDGE_SYSTEM_PROMPT = `你是独立的缺陷评审员。有人（探索智能体）上报了一条疑似缺陷，你要判断它是否真的成立。
只依据给你的材料判断：缺陷描述、平台动作留痕（机械记录的事实）、决策帧截图。
不要脑补材料里没有的功能预期；材料不足以判断时给 unclear。
只输出 JSON，不要输出其他内容：{"verdict":"confirmed|dismissed|unclear","reason":"<一句话理由>","confidence":<0~1>}
口径：
- confirmed：材料能支撑「这确实是个异常或缺陷」
- dismissed：材料显示这是预期行为，或描述与事实不符
- unclear：材料不足以判断（截图看不到、留痕与描述对不上、描述含糊）`;

/** 模型输出 → 判定（形状容错 + 中英别名 + 置信度钳位）。形状不符 = null（判 unclear）。 */
export function parseVerdict(value: unknown): { verdict: JudgeVerdict; reason: string; confidence: number } | null {
  const o = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const raw = typeof o.verdict === 'string' ? o.verdict.trim().toLowerCase() : '';
  const map: Record<string, JudgeVerdict> = {
    confirmed: 'confirmed',
    成立: 'confirmed',
    dismissed: 'dismissed',
    rejected: 'dismissed',
    不成立: 'dismissed',
    unclear: 'unclear',
    unknown: 'unclear',
    存疑: 'unclear',
  };
  const verdict = map[raw];
  if (!verdict) return null;
  const reason = typeof o.reason === 'string' ? o.reason.trim().slice(0, 500) : '';
  const rawConf = typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : 0.5;
  // 有些模型回 0~100 的百分数——超 1 一律按百分数折算。
  const confidence = rawConf > 1 ? Math.min(1, rawConf / 100) : Math.min(1, Math.max(0, rawConf));
  return { verdict, reason, confidence };
}

/** 动作留痕 → 评审可读文本（只给机械事实，不给模型的解释）。 */
function renderTrail(trail: unknown): string {
  if (!Array.isArray(trail)) return '（无动作留痕）';
  const lines = trail.slice(0, JUDGE_TRAIL_MAX).map((s) => {
    const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const parts = [String(o.type ?? '?'), String(o.target ?? '-')];
    if (o.ok === false) parts.push('失败');
    if (typeof o.key === 'string' && o.key) parts.push(`键=${o.key}`);
    if (typeof o.value === 'string' && o.value) parts.push(`值=${o.value.slice(0, 60)}`);
    // 结果摘要（平台机械记录的事实：这步看到了什么/变成了什么）——评审判断的关键证据。
    if (typeof o.outcome === 'string' && o.outcome) parts.push(o.outcome.slice(0, 140));
    return parts.join(' ');
  });
  if (!lines.length) return '（无动作留痕）';
  const more = Array.isArray(trail) && trail.length > JUDGE_TRAIL_MAX ? `\n（余 ${trail.length - JUDGE_TRAIL_MAX} 步略）` : '';
  return `${lines.join('\n')}${more}`;
}

/** 单条 finding 的评审材料（只有证据，不含探索者推理）。 */
function buildUserMessage(f: {
  title: string;
  description: string;
  severity: string;
  pageUrl: string | null;
  evidenceFrame: unknown;
  actionsTrail: unknown;
}): string {
  const frame = (f.evidenceFrame ?? {}) as { screenshotPath?: string };
  return [
    `缺陷标题：${f.title}`,
    `严重程度（探索者自报）：${f.severity}`,
    `缺陷描述：${f.description.slice(0, JUDGE_DESC_MAX)}`,
    `页面 URL：${f.pageUrl ?? '-'}`,
    f.evidenceFrame ? `决策帧元数据：${JSON.stringify(f.evidenceFrame)}` : '',
    `平台动作留痕（机械记录的事实）：\n${renderTrail(f.actionsTrail)}`,
    frame.screenshotPath ? '决策帧截图已附在本消息的图片块里——请结合截图核对描述与画面是否一致。' : '',
    '判断这条缺陷是否成立。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 是否可以附决策帧截图：读文件在且渠道能收图。
 * 文本渠道收图可能直接 400（网关图片尺寸/类型限制）——评审是增强项，
 * 不能因为附图把整场评审搞挂：附不了就纯文本判。
 */
async function readFrameBase64(sessionId: string, order: number): Promise<string | null> {
  try {
    const buf = await readFile(screenshotDiskPath(sessionId, order));
    return buf.toString('base64');
  } catch {
    return null;
  }
}

export interface JudgeDeps {
  /** 注入 LLM 客户端（测试用；缺省取默认渠道）。 */
  llm?: LLMClient;
  /** 允许附决策帧截图（false = 纯文本评审）。 */
  vision?: boolean;
}

/**
 * 评审一个会话的全部 findings：逐条独立判定 → 写 findings.judge + 会话 judge_status/judge_result。
 * 永不抛错。
 */
export async function judgeExplorationSession(sessionId: string, deps?: JudgeDeps): Promise<void> {
  try {
    const session = (
      await db.select().from(explorationSessions).where(eq(explorationSessions.id, sessionId))
    )[0];
    if (!session) return;
    if (session.judgeStatus === 'done') return; // 幂等：已评审过不重复烧钱
    const findings = await db.select().from(explorationFindings).where(eq(explorationFindings.sessionId, sessionId));
    if (findings.length === 0) {
      await db
        .update(explorationSessions)
        .set({ judgeStatus: 'skipped', judgeResult: { judgedAt: new Date().toISOString(), findings: [] }, updatedAt: new Date() })
        .where(eq(explorationSessions.id, sessionId));
      return;
    }

    const client = deps?.llm ?? (await resolveLlmClient()).client;
    // 决策帧默认附上（评审看得见图才判得准）；deps.vision=false 时纯文本评审。
    const canSeeImage = deps?.vision !== false;
    const results: JudgeFinding[] = [];
    let okCount = 0;
    let lastError = '';
    for (const f of findings) {
      const userMessage = buildUserMessage(f);
      let frame: string | null = null;
      if (canSeeImage) frame = await readFrameBase64(sessionId, f.order);
      const callJudge = (withFrame: boolean) =>
        withTimeout(
          completeJson(client, {
            systemPrompt: JUDGE_SYSTEM_PROMPT,
            userMessage,
            ...(withFrame && frame
              ? {
                  image: { base64: frame, mime: 'image/png' as const },
                  messages: [
                    {
                      role: 'user' as const,
                      content: [
                        { type: 'image' as const, base64: frame, mime: 'image/png' as const },
                        { type: 'text' as const, text: userMessage },
                      ],
                    },
                  ],
                }
              : {}),
          }),
          JUDGE_TIMEOUT_MS,
          '评审调用超时',
        );
      try {
        let r: Awaited<ReturnType<typeof callJudge>>;
        try {
          r = await callJudge(!!frame);
        } catch (e) {
          // 附图这条路失败（网关收图 400 / 模型不收图）→ 退纯文本再判一次：
          // 评审是增强项，不能因为一张图把整场评审搞挂。超时则不重试（等下去只会更贵）。
          const first = e instanceof Error ? e.message : String(e);
          if (!frame || first === '评审调用超时') throw e;
          r = await callJudge(false);
        }
        const parsed = parseVerdict(r.value);
        const verdict = parsed ?? { verdict: 'unclear' as JudgeVerdict, reason: '评审输出形状不可解析', confidence: 0 };
        results.push({ id: f.id, verdict: verdict.verdict, reason: verdict.reason, confidence: verdict.confidence });
        okCount += 1;
        await db
          .update(explorationFindings)
          .set({ judge: { ...verdict, model: r.model, judgedAt: new Date().toISOString() } })
          .where(eq(explorationFindings.id, f.id));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastError = msg;
        // 评审调用失败 = 材料不足（unclear），不是「缺陷不成立」。失败原因也落
        // findings.judge——详情页徽标要能看到「为什么这条没判出来」。
        const failed: JudgeFinding = { id: f.id, verdict: 'unclear', reason: `评审调用失败：${msg.slice(0, 200)}`, confidence: 0 };
        results.push(failed);
        await db
          .update(explorationFindings)
          .set({ judge: { verdict: failed.verdict, reason: failed.reason, confidence: 0, judgedAt: new Date().toISOString() } })
          .where(eq(explorationFindings.id, f.id));
      }
    }

    const confirmed = results.filter((r) => r.verdict === 'confirmed').length;
    const dismissed = results.filter((r) => r.verdict === 'dismissed').length;
    await db
      .update(explorationSessions)
      .set({
        judgeStatus: okCount > 0 ? 'done' : 'failed',
        judgeResult: {
          judgedAt: new Date().toISOString(),
          summary: `评审 ${results.length} 条：成立 ${confirmed}、不成立 ${dismissed}、材料不足 ${results.length - confirmed - dismissed}`,
          ...(okCount > 0 ? {} : { error: lastError || '评审未成功' }),
          findings: results,
        },
        updatedAt: new Date(),
      })
      .where(eq(explorationSessions.id, sessionId));
    logger.info({ sessionId, findings: results.length, confirmed }, 'exploration findings judged');
  } catch (e) {
    logger.warn({ err: e, sessionId }, 'exploration judge failed');
    await db
      .update(explorationSessions)
      .set({ judgeStatus: 'failed', updatedAt: new Date() })
      .where(eq(explorationSessions.id, sessionId))
      .catch(() => undefined);
  }
}
