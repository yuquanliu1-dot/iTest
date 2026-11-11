/**
 * 探索式测试会话 runner（pi 链路）：pi agent 原生工具调用循环 + Playwright 自定义工具集——
 * 与「Claude Code + chrome-devtools MCP」同构（原生工具调用 + 视觉工具结果 + 可中断）。
 *
 * 编排沿用 explorationShared 的共享底座（认领/心跳/收尾与 legacy 同一份语义：
 * 认领幂等、先落留痕再置终态、1s 防抖），差异在执行核心：
 * - 能力探针开跑前做：渠道不支持工具调用 → 立刻 failed + 可行动报错（不空跑轮次预算）；
 *   视觉探针读不出唯一码 → 降级纯文本模式（工具不附图），会话照常跑。
 * - 心跳/取消/预算挂在 message_end + tool_execution_end（pi 一轮可链多个工具，
 *   只挂 message_end 会饿死 5min 看门狗）；命中即 session.abort()。
 * - 动作留痕：tool_execution_start 登记（入参可见）、end 回填 ok——
 *   tool_execution_end 事件不带 args（pi-agent-core AgentEvent 联合），必须在 start 登记。
 */
import { eq } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import { getExplorationPersona } from '@itest/shared';
import { db } from '../../db/client.js';
import { explorationSessions } from '../../db/schema.js';
import {
  claimSession,
  finishSession,
  heartbeat,
  EXPLORATION_MAX_TURNS,
  EXPLORATION_WALL_CLOCK_MS,
} from '../../execute/explorationShared.js';
import { resolveEnv } from '../../execute/envContext.js';
import { defaultWebRef } from '../../execute/credentialSource.js';
import { originOf } from '../../execute/gates.js';
import { registerLiveView } from '../../execute/liveView.js';
import { newAiUsage } from '../../execute/aiUsage.js';
import { versionWorkspaceDir } from '../repo.js';
import { loginStateKey, getLoginState, saveLoginState, type LoginStorageState } from '../space/tools/loginStateCache.js';
import { logger } from '../../logger.js';
import { resolveExplorationModel, toolCallingProbeFailure, visionProbeFailure } from './model.js';
import { createExplorationTools, trailStepOf } from './tools/index.js';
import { composeExplorationPrompt, createExplorationSession } from './session.js';
import type { ExplorationStep } from '../../execute/explorationPrompt.js';

/** 探索式测试会话 runner（pi 链路）入口：EXPLORATION_RUNTIME=pi 时由 execute/exploration.ts 分派到这里。 */
export async function runExplorationSessionPi(input: { sessionId: string }): Promise<void> {
  const { sessionId } = input;
  const sessionRow = (await db.select().from(explorationSessions).where(eq(explorationSessions.id, sessionId)))[0];
  if (!sessionRow) return;
  if (!(await claimSession(sessionId))) return;
  // pending 期被取消：不开浏览器直接收尾
  if (sessionRow.cancelRequested) {
    await db
      .update(explorationSessions)
      .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(explorationSessions.id, sessionId));
    return;
  }

  let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
  let live: ReturnType<typeof registerLiveView> | undefined;
  const maxTurns = sessionRow.budgetTurns ?? EXPLORATION_MAX_TURNS;
  const usage = newAiUsage();
  let turnCount = 0;
  let userCancelled = false;
  let budgetExceeded = false;
  /** 最后一条 assistant 文本（done summary：pi 循环自然结束时的总结）。 */
  let summaryText = '';
  /** 会话级动作留痕（工具事件 → ExplorationStep），落库防抖同 legacy。 */
  const sessionSteps: ExplorationStep[] = [];
  const pendingTrail = new Map<string, ExplorationStep>();
  let persistChain: Promise<void> = Promise.resolve();
  const persistSessionState = async (): Promise<void> => {
    persistChain = persistChain
      .then(async () => {
        await db
          .update(explorationSessions)
          .set({ actionsTrail: sessionSteps, excludedLedger: [], updatedAt: new Date() })
          .where(eq(explorationSessions.id, sessionId));
      })
      .catch((e) => {
        logger.warn({ err: e, sessionId }, 'exploration session state persist failed');
      });
    return persistChain;
  };
  /** 动作级落库防抖（同 legacy：窗口 1s，详情页 2s 轮询可见逐步长出）。 */
  const TRAIL_PERSIST_DEBOUNCE_MS = 1000;
  let trailTimer: NodeJS.Timeout | undefined;
  const scheduleTrailPersist = (): void => {
    if (trailTimer) return;
    trailTimer = setTimeout(() => {
      trailTimer = undefined;
      void persistSessionState();
    }, TRAIL_PERSIST_DEBOUNCE_MS);
  };
  const flushTrailPersist = async (): Promise<void> => {
    if (trailTimer) {
      clearTimeout(trailTimer);
      trailTimer = undefined;
    }
    await persistSessionState();
  };

  try {
    await heartbeat(sessionId);
    // P2 不挂 repo_read（工具不存在）→ 不解析代码范围；P3 加 repo_read 时与 legacy 同法接 resolveCodeScope。
    envCtx = await resolveEnv({ versionId: sessionRow.versionId }, { expectedProjectId: sessionRow.projectId });
    const webRef = defaultWebRef({ envCtx });
    const cred = webRef ? envCtx.resolveLogin(webRef) : null;
    const startUrl = sessionRow.startUrl?.trim() || envCtx.baseUrl || cred?.loginUrl || '';
    if (!startUrl) throw new Error('缺少探索起点 URL（会话未填 startUrl，且环境未配置 baseUrl/loginUrl）');
    // 范围白名单 = 起点 origin 唯一（口径与 legacy 一致；不可解析 → 空数组 = navigate 全拒）。
    const startOrigin = originOf(startUrl);
    const scopeOrigins = startOrigin ? [startOrigin] : [];

    // —— 模型解析 + 工具调用探针（浏览器启动前：渠道不行立刻失败，不空跑轮次预算）——
    const { model, channelName } = await resolveExplorationModel();
    await heartbeat(sessionId);
    const toolProbe = await toolCallingProbeFailure(model);
    if (toolProbe) throw new Error(toolProbe);
    if (await heartbeat(sessionId)) {
      await finishSession(sessionId, { status: 'cancelled', turnsUsed: 0, usage: usage.stat }).catch(() => undefined);
      return;
    }
    // 探索墙钟从探针后起算——预算全部留给智能体阶段。
    const deadline = Date.now() + EXPLORATION_WALL_CLOCK_MS;

    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
    try {
      const loginKey = cred ? loginStateKey(envCtx.envId, cred.user) : null;
      const cachedState = loginKey ? getLoginState(loginKey) : null;
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        // 两态视口与 legacy 一致：会话建时给了成对宽高=自定义；缺省 1280×800。
        viewport:
          sessionRow.windowWidth && sessionRow.windowHeight
            ? { width: sessionRow.windowWidth, height: sessionRow.windowHeight }
            : { width: 1280, height: 800 },
        ...(cachedState ? { storageState: cachedState } : {}),
      });
      const page = await context.newPage();
      live = registerLiveView(`exploration:${sessionId}`);
      live.setPage(page);

      // —— 视觉探针（浏览器内渲染唯一码读回）：失败不掀翻会话，降级纯文本模式 ——
      const visionProbe = await visionProbeFailure(page, model);
      const vision = visionProbe === null;
      if (visionProbe) {
        logger.warn({ sessionId, channelName, reason: visionProbe }, 'exploration vision probe failed; text-only mode');
      }

      const persona = getExplorationPersona(sessionRow.persona);
      const tools = createExplorationTools({ page, vision, scopeOrigins });
      const piSession = await createExplorationSession({
        cwd: versionWorkspaceDir(sessionRow.versionId),
        tools,
        model,
        explorationPrompt: composeExplorationPrompt({
          charter: sessionRow.charter,
          startUrl,
          persona: persona.directive,
          vision,
          needsLoginButNoTools: !cachedState && !!cred,
        }),
      });

      // 取消/预算检查：心跳顺带读取消标志（同 legacy 一句 SQL 语义）；命中即 abort。
      // 轮次计数只认 assistant message_end（= 一次 LLM 轮，与 legacy shouldAbort 口径一致）——
      // tool_execution_end 只做心跳（pi 一轮可链多个工具，若逐工具计数 turnsUsed 会虚胖）。
      // 串行链执行：多个事件同拍到达时心跳不并发、计数不重复。
      let abortCheckChain: Promise<void> = Promise.resolve();
      const scheduleAbortCheck = (turnBoundary: boolean): void => {
        abortCheckChain = abortCheckChain
          .then(async () => {
            if (userCancelled || budgetExceeded) return;
            if (await heartbeat(sessionId)) {
              userCancelled = true;
              piSession.abort();
              return;
            }
            if (turnBoundary) {
              turnCount += 1;
              if (turnCount >= maxTurns || Date.now() > deadline) {
                budgetExceeded = true;
                piSession.abort();
              }
            }
          })
          .catch(() => {});
      };

      piSession.subscribe((ev) => {
        if (ev.type === 'tool_execution_start') {
          const step = trailStepOf(ev.toolName, ev.args);
          if (step) pendingTrail.set(ev.toolCallId, step);
        } else if (ev.type === 'tool_execution_end') {
          const step = pendingTrail.get(ev.toolCallId);
          pendingTrail.delete(ev.toolCallId);
          if (step) {
            step.ok = !ev.isError;
            sessionSteps.push(step);
            scheduleTrailPersist();
          }
          scheduleAbortCheck(false);
        } else if (ev.type === 'message_end' && ev.message.role === 'assistant') {
          const m = ev.message;
          usage.add({
            usage: {
              promptTokens: m.usage?.input ?? 0,
              completionTokens: m.usage?.output ?? 0,
              cacheReadTokens: m.usage?.cacheRead ?? 0,
              cacheCreationTokens: m.usage?.cacheWrite ?? 0,
            },
            model: m.model,
          });
          const text = m.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
          if (text) summaryText = text;
          scheduleAbortCheck(true);
        }
      });

      logger.info({ sessionId, channelName, vision, scopeOrigins, maxTurns }, 'exploration pi session starting');

      // 起始指令 + 墙钟硬闸：事件驱动的 maybeAbort 覆盖正常轮转；这里兜「LLM 调用挂死无事件」
      // 的路径——到点 abort 让 prompt 展开，收尾语义照常走（留痕全保留）。
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) budgetExceeded = true;
      if (!budgetExceeded && !userCancelled) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            budgetExceeded = true;
            piSession.abort();
          }, remainingMs);
          piSession
            .prompt(`开始探索。先 navigate 到起点 ${startUrl}，再 observe 获取页面状态，之后按章程行动。`)
            .then(() => {
              clearTimeout(timer);
              resolve();
            })
            .catch((e) => {
              clearTimeout(timer);
              reject(e);
            });
        });
      }
      // 取消/预算检查是事件驱动的异步链（链上心跳 SQL 在途时 prompt 可能已 resolve）——
      // 收尾读标志前等最后一拍落定，否则终态分类（cancelled / completed+预算注记）
      // 与 turns_used 会漏掉最后一轮的判定。
      await abortCheckChain;

      // 先落留痕再置终态（详情页一看到终态就停轮询，顺序反了尾段永远拉不到）。
      await flushTrailPersist();
      // 暖登录态回馈（fire-and-forget，失败不影响终态；与 legacy 同语义）
      if (loginKey) void context.storageState().then((s) => saveLoginState(loginKey, s)).catch(() => {});
      await finishSession(sessionId, {
        status: userCancelled ? 'cancelled' : 'completed',
        summary: budgetExceeded
          ? `${summaryText || '探索结束'}（预算耗尽，${turnCount} 轮后停止）`.trim()
          : summaryText || null,
        turnsUsed: turnCount,
        usage: usage.stat,
      }).catch(() => undefined);
    } finally {
      live?.close();
      await browser.close().catch(() => {});
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, sessionId, userCancelled, budgetExceeded }, 'exploration pi session failed');
    await flushTrailPersist();
    await finishSession(sessionId, {
      status: userCancelled ? 'cancelled' : budgetExceeded ? 'completed' : 'failed',
      error: userCancelled || budgetExceeded ? null : msg,
      summary: budgetExceeded ? `探索结束（预算耗尽，${turnCount} 轮后停止）` : null,
      turnsUsed: turnCount,
      usage: usage.stat,
    }).catch(() => undefined);
  } finally {
    // 兜底落库：正常/失败路径都已在置终态前 flush 过，这里只防意外漏写。
    await flushTrailPersist();
    if (envCtx) await envCtx.close().catch(() => {});
  }
}
