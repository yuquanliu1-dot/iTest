/**
 * A3 independent review: after the session wraps up, each finding gets an independent verdict (does this defect candidate actually hold).
 *
 * Why it must be independent: the explorer is "finding its own bugs and reporting them itself" — the same reasoning
 * contains both observations and conclusions, and self-assessment is naturally optimistic (everything reported looks true).
 * The reviewer takes another perspective and looks only at the material:
 * - Fed in: defect description + platform action trail (mechanically recorded facts) + decision-frame screenshot;
 * - Not fed in: the explorer's reasoning process (the model's own account of "why I judged this way").
 * The review conclusion is only an **annotation** (findings.judge); it never changes findings.status — human review is the authority.
 *
 * Idempotent: sessions with judge_status=done are skipped outright (re-triggering burns no money twice and does not overwrite existing verdicts).
 * Never throws: a review failure only records judge_status=failed and does not affect the session's final state.
 */
import { eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { db } from '../../db/client.js';
import { explorationFindings, explorationSessions } from '../../db/schema.js';
import { completeJson, type LLMClient } from '../../agent/llm-client.js';
import { resolveLlmClient } from '../../agent/llmSettings.js';
import { screenshotDiskPath, withTimeout } from '../../execute/explorationShared.js';
import { logger } from '../../logger.js';

/** Review verdict: holds / does not hold / insufficient material. */
export type JudgeVerdict = 'confirmed' | 'dismissed' | 'unclear';

export interface JudgeFinding {
  id: string;
  verdict: JudgeVerdict;
  reason: string;
  confidence: number;
}

/** Per-review call timeout (soft failure: timeout = that item is unclear). */
const JUDGE_TIMEOUT_MS = 90_000;
/** Cap on action-trail steps fed to a single review (overlong trails are truncated — the trail is evidence, not a full transcript). */
const JUDGE_TRAIL_MAX = 60;
/** Cap on description length fed to a single review. */
const JUDGE_DESC_MAX = 2000;

const JUDGE_SYSTEM_PROMPT = `你是独立的缺陷评审员。有人（探索智能体）上报了一条疑似缺陷，你要判断它是否真的成立。
只依据给你的材料判断：缺陷描述、平台动作留痕（机械记录的事实）、决策帧截图。
不要脑补材料里没有的功能预期；材料不足以判断时给 unclear。
只输出 JSON，不要输出其他内容：{"verdict":"confirmed|dismissed|unclear","reason":"<一句话理由>","confidence":<0~1>}
口径：
- confirmed：材料能支撑「这确实是个异常或缺陷」
- dismissed：材料显示这是预期行为，或描述与事实不符
- unclear：材料不足以判断（截图看不到、留痕与描述对不上、描述含糊）`;

/** Model output → verdict (shape tolerance + zh/en aliases + confidence clamping). Shape mismatch = null (judged unclear). */
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
  // Some models return a 0~100 percentage — anything over 1 is folded down as a percentage.
  const confidence = rawConf > 1 ? Math.min(1, rawConf / 100) : Math.min(1, Math.max(0, rawConf));
  return { verdict, reason, confidence };
}

/** Action trail → review-readable text (mechanical facts only, no model explanations). */
function renderTrail(trail: unknown): string {
  if (!Array.isArray(trail)) return '（无动作留痕）';
  const lines = trail.slice(0, JUDGE_TRAIL_MAX).map((s) => {
    const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const parts = [String(o.type ?? '?'), String(o.target ?? '-')];
    if (o.ok === false) parts.push('失败');
    if (typeof o.key === 'string' && o.key) parts.push(`键=${o.key}`);
    if (typeof o.value === 'string' && o.value) parts.push(`值=${o.value.slice(0, 60)}`);
    // Result summary (platform-side mechanically recorded fact: what this step saw / what it became) — key evidence for the review verdict.
    if (typeof o.outcome === 'string' && o.outcome) parts.push(o.outcome.slice(0, 140));
    return parts.join(' ');
  });
  if (!lines.length) return '（无动作留痕）';
  const more = Array.isArray(trail) && trail.length > JUDGE_TRAIL_MAX ? `\n（余 ${trail.length - JUDGE_TRAIL_MAX} 步略）` : '';
  return `${lines.join('\n')}${more}`;
}

/** Review material for one finding (evidence only, no explorer reasoning). */
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
 * Whether the decision-frame screenshot can be attached: the file exists and the channel accepts images.
 * A text channel receiving an image may 400 outright (gateway image size/type limits) — review is an enhancement
 * and must not be wrecked by attaching an image: if it cannot be attached, judge on text alone.
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
  /** Injects the LLM client (for tests; defaults to the default channel). */
  llm?: LLMClient;
  /** Allows attaching the decision-frame screenshot (false = text-only review). */
  vision?: boolean;
}

/**
 * Reviews all findings of a session: independent verdict per finding → writes findings.judge + session judge_status/judge_result.
 * Never throws.
 */
export async function judgeExplorationSession(sessionId: string, deps?: JudgeDeps): Promise<void> {
  try {
    const session = (
      await db.select().from(explorationSessions).where(eq(explorationSessions.id, sessionId))
    )[0];
    if (!session) return;
    if (session.judgeStatus === 'done') return; // Idempotent: already reviewed, no double spend
    const findings = await db.select().from(explorationFindings).where(eq(explorationFindings.sessionId, sessionId));
    if (findings.length === 0) {
      await db
        .update(explorationSessions)
        .set({ judgeStatus: 'skipped', judgeResult: { judgedAt: new Date().toISOString(), findings: [] }, updatedAt: new Date() })
        .where(eq(explorationSessions.id, sessionId));
      return;
    }

    const client = deps?.llm ?? (await resolveLlmClient()).client;
    // The decision frame is attached by default (the reviewer judges more accurately when it can see the image); deps.vision=false means text-only review.
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
          // The with-image path failed (gateway rejected the image with 400 / model would not take it) → fall back to text and judge again:
          // review is an enhancement and must not be wrecked by one image. On timeout, do not retry (waiting only costs more).
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
        // A failed review call = insufficient material (unclear), not "the defect does not hold". The failure reason is also
        // persisted into findings.judge — the detail-page badge must be able to show "why this one came out unjudged".
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
