/**
 * 探索式测试会话 runner：charter 驱动的独立 AI 浏览器会话——无 case/步骤绑定，
 * 模板 = pi/space/tools/login.ts perform_login（launch → newContext → registerLiveView → runAiTask）。
 * 产出 findings 缺陷候选（onFindings 即时截图落库）+ live view 整段录像。
 * 终止语义：正常 done → completed；shouldAbort 闭包标志分类（用户取消 → cancelled、
 * 预算耗尽 → completed+注记），绝不解析 runAiTask 的错误文案（文案是执行语境的，不可靠）。
 */
import { and, eq } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import type { ExplorationReproStep } from '@itest/shared';
import { db } from '../db/client.js';
import { explorationSessions, explorationFindings } from '../db/schema.js';
import { resolveEnv } from './envContext.js';
import { runAiTask, credentialPlaceholder, makeCredentialValueSub, type AiAction } from './aiTask.js';
import { buildCredentialSource, renderWebResourceManifest, defaultWebRef } from './credentialSource.js';
import { waitForPageSettled } from './pageSettle.js';
import { registerLiveView } from './liveView.js';
import { newAiUsage } from './aiUsage.js';
import {
  composeExplorationInstruction,
  coerceFindings,
  EXPLORATION_SYSTEM_PROMPT_BASE,
  EXPLORATION_MAX_FINDINGS,
} from './explorationPrompt.js';
import { logger } from '../logger.js';
import { loginStateKey, getLoginState, saveLoginState, type LoginStorageState } from '../pi/space/tools/loginStateCache.js';
import { resolveLlmClient } from '../agent/llmSettings.js';

/** 软预算：超界走 shouldAbort 优雅收尾（findings 全保留）。runAiTask maxTurns=40 仅 runaway 兜底。 */
export const EXPLORATION_MAX_TURNS = 24;
export const EXPLORATION_WALL_CLOCK_MS = 15 * 60_000;

function screenshotDiskPath(sessionId: string, order: number): string {
  return join(process.cwd(), 'screenshots', sessionId, `finding-${order}.png`);
}

/** 模型没给复现步骤时，用平台自己的动作留痕兜底（真实动作序列比模型现编的更可信）。 */
function stepsFromTrail(trail: Array<{ type: string; target: string; ok: boolean }>): ExplorationReproStep[] {
  const succeeded = trail.filter((a) => a.ok);
  const use = succeeded.length > 0 ? succeeded : trail;
  return use.slice(0, 10).map((a) => ({ action: `${a.type} ${a.target}`.trim() }));
}

/** 会话总结补「模型报 N 条 / 落库 M 条」——避免摘要说几条、库里 0 条的自相矛盾。 */
function withFindingCounts(summary: string | null | undefined, modelReported: number, savedCount: number): string | null {
  const base = (summary ?? '').trim();
  if (modelReported === 0) return base || null;
  const note = `模型报告 ${modelReported} 条，落库 ${savedCount} 条`;
  return base ? `${base}（${note}）` : `（${note}）`;
}

async function isSessionCancelRequested(sessionId: string): Promise<boolean> {
  const row = (await db.select({ cancelRequested: explorationSessions.cancelRequested }).from(explorationSessions).where(eq(explorationSessions.id, sessionId)))[0];
  return row?.cancelRequested ?? false;
}

/** 幂等认领：pending → running（原子条件更新），输家（重复 job/已删）直接 bail。 */
async function claimSession(sessionId: string): Promise<boolean> {
  const claimed = await db
    .update(explorationSessions)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(explorationSessions.id, sessionId), eq(explorationSessions.status, 'pending')))
    .returning({ id: explorationSessions.id });
  return claimed.length > 0;
}

export async function runExplorationSession(input: { sessionId: string }): Promise<void> {
  const { sessionId } = input;
  const session = (await db.select().from(explorationSessions).where(eq(explorationSessions.id, sessionId)))[0];
  if (!session) return;
  if (!(await claimSession(sessionId))) return;
  // pending 期被取消：不开浏览器直接收尾
  if (session.cancelRequested) {
    await db.update(explorationSessions).set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() }).where(eq(explorationSessions.id, sessionId));
    return;
  }

  let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
  let live: ReturnType<typeof registerLiveView> | undefined;
  const usage = newAiUsage();
  let turnCount = 0;
  let userCancelled = false;
  let budgetExceeded = false;
  /** findings 计数（函数作用域：catch 分支也要用来说明「模型报 N 条、落库 M 条」）。 */
  let savedCount = 0;
  let modelReported = 0;
  const deadline = Date.now() + EXPLORATION_WALL_CLOCK_MS;

  try {
    envCtx = await resolveEnv({ versionId: session.versionId }, { expectedProjectId: session.projectId });
    const client = (await resolveLlmClientForExploration()).client;
    const webRef = defaultWebRef({ envCtx });
    const cred = webRef ? envCtx.resolveLogin(webRef) : null;
    const startUrl = session.startUrl?.trim() || envCtx.baseUrl || cred?.loginUrl || '';
    if (!startUrl) throw new Error('缺少探索起点 URL（会话未填 startUrl，且环境未配置 baseUrl/loginUrl）');

    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
    try {
      const loginKey = cred ? loginCacheKey(envCtx.envId, cred.user) : null;
      const cachedState = loginKey ? getLoginStateFor(loginKey) : null;
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 800 },
        ...(cachedState ? { storageState: cachedState } : {}),
      });
      const page = await context.newPage();
      // 实时画面 + 整段录像（key 稳定 = 会话回放能力；结束 close 收流，录制留供回放）
      live = registerLiveView(`exploration:${sessionId}`);
      live.setPage(page);

      // findings 收集闭包：seenTitles 跨轮去重、trail 自上一条 finding 起累积、order 递增
      const seenTitles = new Set<string>();
      const trail: Array<{ type: string; target: string; ok: boolean }> = [];
      const onAction = (a: AiAction, ok: boolean): void => {
        let target = '-';
        if (a.type === 'click' || a.type === 'fill') {
          if (typeof a.selector === 'string' && a.selector) target = a.selector;
          else if (typeof a.x === 'number' && typeof a.y === 'number') target = `(${a.x},${a.y})`;
        } else if (a.type === 'navigate') {
          target = a.url;
        }
        trail.push({ type: a.type, target, ok });
      };
      const onFindings = async (raw: unknown[]): Promise<void> => {
        modelReported += raw.length;
        const { accepted, dropped, invalid } = coerceFindings(raw, {
          existingTitles: [...seenTitles],
          max: Math.max(0, EXPLORATION_MAX_FINDINGS - savedCount),
        });
        if (dropped > 0) {
          logger.warn({ sessionId, reported: raw.length, dropped, invalid }, 'exploration findings dropped');
        }
        for (const f of accepted) {
          savedCount += 1;
          const order = savedCount;
          let screenshotPath: string | null = null;
          try {
            await waitForPageSettled(page, { timeoutMs: 2500 });
          } catch { /* settle 尽力而为：失败也截图 */ }
          try {
            await page.screenshot({ path: screenshotDiskPath(sessionId, order) });
            screenshotPath = `/screenshots/${sessionId}/finding-${order}.png`;
          } catch (e) {
            logger.warn({ err: e, sessionId, order }, 'exploration finding screenshot failed');
          }
          try {
            await db.insert(explorationFindings).values({
              sessionId,
              order,
              title: f.title,
              description: f.description,
              severity: f.severity,
              reproSteps: f.reproSteps.length > 0 ? f.reproSteps : stepsFromTrail(trail),
              actionsTrail: [...trail],
              screenshotPath,
              pageUrl: page.url(),
            });
            seenTitles.add(f.title);
          } catch (e) {
            savedCount -= 1; // 落库失败回退配额，下轮可重报
            logger.warn({ err: e, sessionId }, 'exploration finding insert failed');
          }
        }
        trail.length = 0;
      };

      const summary = await runAiTask(
        page,
        composeExplorationInstruction({
          startUrl,
          charter: session.charter,
          personaKey: session.persona,
          needsLoginPreamble: !cachedState && !!cred,
          loginPlaceholders: cred
            ? { user: credentialPlaceholder('user', webRef), password: credentialPlaceholder('password', webRef) }
            : undefined,
          manifest: renderWebResourceManifest({ envCtx }),
        }),
        client,
        false,
        {
          // 24 轮软预算由 shouldAbort 先触发；40 仅 runaway 兜底
          maxTurns: 40,
          valueSub: cred ? makeCredentialValueSub(buildCredentialSource({ envCtx })) : undefined,
          resourceManifest: renderWebResourceManifest({ envCtx }),
          onUsage: (r) => usage.add(r),
          onAction,
          onFindings,
          shouldAbort: async () => {
            if (await isSessionCancelRequested(sessionId)) {
              userCancelled = true;
              return true;
            }
            turnCount += 1;
            if (turnCount > EXPLORATION_MAX_TURNS || Date.now() > deadline) {
              budgetExceeded = true;
              return true;
            }
            return false;
          },
        },
      );
      await finishSession(sessionId, {
        status: userCancelled ? 'cancelled' : 'completed',
        summary: withFindingCounts(
          userCancelled
            ? summary
            : budgetExceeded
              ? `${summary || '探索结束'}（预算耗尽，${turnCount} 轮后停止）`.trim()
              : summary,
          modelReported,
          savedCount,
        ),
        turnsUsed: turnCount,
        usage: usage.stat,
      }).catch(() => undefined);
      // 暖登录态缓存回馈 verify_case/perform_login（fire-and-forget，失败不影响会话终态）
      if (loginKey) void context.storageState().then((s) => saveLoginStateFor(loginKey, s)).catch(() => {});
    } finally {
      live?.close();
      await browser.close().catch(() => {});
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, sessionId, userCancelled, budgetExceeded }, 'exploration session failed');
    // 用户取消/预算耗尽不算失败（ findings 已捕获的都保留）；其余真异常 → failed
    // 预算耗尽走的是 shouldAbort 抛出的中断（runAiTask 抛错而非正常返回），
    // 所以总结只能在这里补——否则会话以「completed 但无总结」收尾，看不出为何停下。
    await finishSession(sessionId, {
      status: userCancelled ? 'cancelled' : budgetExceeded ? 'completed' : 'failed',
      error: userCancelled || budgetExceeded ? null : msg,
      summary: budgetExceeded
        ? withFindingCounts(`探索结束（预算耗尽，${turnCount} 轮后停止）`, modelReported, savedCount)
        : null,
      turnsUsed: turnCount,
      usage: usage.stat,
    }).catch(() => undefined);
  } finally {
    if (envCtx) await envCtx.close().catch(() => {});
  }
}

async function finishSession(
  sessionId: string,
  patch: { status: string; summary?: string | null; error?: string | null; turnsUsed: number; usage: unknown },
): Promise<void> {
  await db
    .update(explorationSessions)
    .set({
      status: patch.status,
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      turnsUsed: patch.turnsUsed,
      usage: patch.usage as object,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(explorationSessions.id, sessionId));
}

/** 删除会话时清理证据截图目录（reports.unlinkReportScreenshots 同约定）。 */
export async function removeExplorationScreenshots(sessionId: string): Promise<void> {
  await rm(join(process.cwd(), 'screenshots', sessionId), { recursive: true, force: true }).catch(() => undefined);
}

// —— 间接依赖（测试可 mock 的缝）：loginStateCache / llmSettings 以函数引用收口 ——
function loginCacheKey(envId: string, user: string | undefined): string {
  return loginStateKey(envId, user);
}
function getLoginStateFor(key: string): LoginStorageState | null {
  return getLoginState(key);
}
function saveLoginStateFor(key: string, state: LoginStorageState): void {
  saveLoginState(key, state);
}
function resolveLlmClientForExploration(): ReturnType<typeof resolveLlmClient> {
  return resolveLlmClient();
}
