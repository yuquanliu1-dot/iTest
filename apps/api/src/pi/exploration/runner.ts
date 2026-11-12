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
import { EXPLORATION_MAX_EXCLUDED, EXPLORATION_MAX_REPO_READS, type ExplorationStep } from '../../execute/explorationPrompt.js';
import { resolveEnv } from '../../execute/envContext.js';
import { resolveCodeScope, type CodeScope } from '../../execute/codeScope.js';
import { buildCredentialSource, defaultWebRef } from '../../execute/credentialSource.js';
import { credentialPlaceholder, makeCredentialValueSub } from '../../execute/aiTask.js';
import { createRepoReadChannel } from '../../execute/repoRead.js';
import { originOf } from '../../execute/gates.js';
import { registerLiveView } from '../../execute/liveView.js';
import { newAiUsage } from '../../execute/aiUsage.js';
import { versionWorkspaceDir } from '../repo.js';
import { loginStateKey, getLoginState, saveLoginState } from '../space/tools/loginStateCache.js';
import { logger } from '../../logger.js';
import { resolveExplorationModel, toolCallingProbeFailure, visionProbeFailure } from './model.js';
import { decomposeCharter } from './decompose.js';
import { judgeExplorationSession } from './judge.js';
import { createExplorationTools, trailStepOf } from './tools/index.js';
import { createFaultController, type FaultController } from './tools/fault.js';
import { composeExplorationPrompt, createExplorationSession } from './session.js';
import { createFindingStore, type FindingStore } from './findings.js';
import { createCoverageTracker } from './coverage.js';
import { createErrorSignalCollector } from './observation.js';
import { fallbackFailureReason, readToolSummary } from './trail.js';

/** 覆盖账本计数的交互动作类型（观察/判定类动作不算交互——账本回答「动过哪些地方」）。 */
const INTERACTION_KINDS = new Set(['click', 'fill', 'press', 'select', 'scroll', 'back', 'navigate']);

/**
 * 探索式测试会话 runner（pi 链路）入口：EXPLORATION_RUNTIME=pi 时由 execute/exploration.ts 分派到这里。
 */
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
  /** D2 故障控制器（声明在 try 外——收尾 finally 要能复位）。 */
  let fault: FaultController | undefined;
  const maxTurns = sessionRow.budgetTurns ?? EXPLORATION_MAX_TURNS;
  const usage = newAiUsage();
  let turnCount = 0;
  let userCancelled = false;
  let budgetExceeded = false;
  /** 最后一条 assistant 文本（done summary：pi 循环自然结束时的总结）。 */
  let summaryText = '';
  /** finish 工具提交的总结（finish 后 abort，正常/异常路径都以它为终态总结）。 */
  let finishSummary: string | null = null;
  /** 终止性错误（fill 凭据缺失等）：终止会话并按 failed 收尾。 */
  let fatalErr: Error | undefined;
  /** finding store（页内创建；catch 路径读 savedCount 拼总结用）。 */
  let findingStore: FindingStore | undefined;
  /** 会话级动作留痕（工具事件 → ExplorationStep），落库防抖同 legacy。 */
  const sessionSteps: ExplorationStep[] = [];
  /** 自上一条 finding 起的留痕片段（finding 落库成功时清空，进 finding.actions_trail）。 */
  let trailSince: ExplorationStep[] = [];
  /** 负面结果账本（同 legacy：只存排除项不存信念，dedup + 封顶）。 */
  const excludedLedger: Array<{ claim: string; evidence: string }> = [];
  const pendingTrail = new Map<string, ExplorationStep>();
  let coverageLedger: ReturnType<typeof createCoverageTracker> | undefined;
  let errorSignals: ReturnType<typeof createErrorSignalCollector> | undefined;
  let persistChain: Promise<void> = Promise.resolve();
  const persistSessionState = async (): Promise<void> => {
    persistChain = persistChain
      .then(async () => {
        await db
          .update(explorationSessions)
          .set({
            actionsTrail: sessionSteps,
            excludedLedger: [...excludedLedger],
            coverageLedger: coverageLedger?.snapshot() ?? null,
            errorSignals: errorSignals?.all() ?? [],
            updatedAt: new Date(),
          })
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
  /** 终态总结：finish 提交 > 预算注记 > 最后一条 assistant 文本；缺陷计数注记两路径都带。 */
  const terminalSummary = (): string | null => {
    const countsNote = (findingStore?.savedCount ?? 0) > 0 ? `（报告缺陷 ${findingStore!.savedCount} 条）` : '';
    if (finishSummary) return `${finishSummary}${countsNote}`.trim();
    if (budgetExceeded) return `${summaryText || '探索结束'}（预算耗尽，${turnCount} 轮后停止）${countsNote}`.trim();
    return summaryText ? `${summaryText}${countsNote}`.trim() : null;
  };

  try {
    await heartbeat(sessionId);
    envCtx = await resolveEnv({ versionId: sessionRow.versionId }, { expectedProjectId: sessionRow.projectId });
    const webRef = defaultWebRef({ envCtx });
    const cred = webRef ? envCtx.resolveLogin(webRef) : null;
    const startUrl = sessionRow.startUrl?.trim() || envCtx.baseUrl || cred?.loginUrl || '';
    if (!startUrl) throw new Error('缺少探索起点 URL（会话未填 startUrl，且环境未配置 baseUrl/loginUrl）');
    // 范围白名单 = 起点 origin 唯一（口径与 legacy 一致；不可解析 → 空数组 = navigate 全拒）。
    const startOrigin = originOf(startUrl);
    const scopeOrigins = startOrigin ? [startOrigin] : [];

    // —— 代码提交范围（charter 自然语言 → git 范围；前后各一次心跳：解析期间看门狗不误杀、
    // 顺带捕捉取消。none/failed → codeScope null，探索照常全站跑，repo_read 不挂载）——
    await heartbeat(sessionId);
    const { scope } = await resolveCodeScope({ sessionId, charter: sessionRow.charter, versionId: sessionRow.versionId });
    const codeScope: CodeScope | null = scope ?? null;
    if (await heartbeat(sessionId)) {
      await finishSession(sessionId, { status: 'cancelled', turnsUsed: 0, usage: usage.stat }).catch(() => undefined);
      return;
    }

    // —— 模型解析 + 工具调用探针（浏览器启动前：渠道不行立刻失败，不空跑轮次预算）——
    const { model, channelName } = await resolveExplorationModel();
    await heartbeat(sessionId);
    const toolProbe = await toolCallingProbeFailure(model);
    if (toolProbe) throw new Error(toolProbe);
    if (await heartbeat(sessionId)) {
      await finishSession(sessionId, { status: 'cancelled', turnsUsed: 0, usage: usage.stat }).catch(() => undefined);
      return;
    }

    // —— C2 章程分解（开跑前 1 次 LLM 调用 → 2~6 条子目标；软失败 = 无子目标，探索照常跑）——
    //  子目标进 system prompt（压缩安全）并落 coverage_ledger.goals（终态快照供人工评估覆盖度）。
    //  放在探针之后：探针不过这场会话直接失败，没必要再烧一次分解调用。
    const persona = getExplorationPersona(sessionRow.persona);
    const goals = await decomposeCharter({ charter: sessionRow.charter, persona: persona.directive });
    if (await heartbeat(sessionId)) {
      await finishSession(sessionId, { status: 'cancelled', turnsUsed: 0, usage: usage.stat }).catch(() => undefined);
      return;
    }
    // 探索墙钟从范围解析 + 探针 + 章程分解后起算——预算全部留给智能体阶段。
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

      // —— 视觉探针（浏览器内渲染唯一码读回）：失败不掀翻会话，降级纯文本模式 ——
      //    必须在 registerLiveView 之前：live view 会对同一 page 起 CDP screencast 镜像，
      //    prod228 实证镜像活跃时探针截图 5s 超时 → 会话被误降级为纯文本模式。
      const visionProbe = await visionProbeFailure(page, model);
      const vision = visionProbe === null;
      if (visionProbe) {
        logger.warn({ sessionId, channelName, reason: visionProbe }, 'exploration vision probe failed; text-only mode');
      }

      live = registerLiveView(`exploration:${sessionId}`);
      live.setPage(page);

      // —— D2 故障注入控制器：控制器始终创建（收尾 finally 要能复位），
      //    但工具**只在会话带显式授权位时装配**（未授权 = 工具不出现）。——
      fault = createFaultController(context, page);

      // —— C1 覆盖账本 + D3 错误信号采集（observe 回灌 + 终态落库）——
      const coverage = createCoverageTracker();
      coverage.setGoals(goals);
      coverageLedger = coverage;
      const collector = createErrorSignalCollector(page);
      errorSignals = collector;

      // —— A1 证据帧：finding 落库（决策帧截图 + 自上一条 finding 起的留痕片段）——
      const store = createFindingStore({
        sessionId,
        page,
        getTrailSince: () => trailSince,
        resetTrailSince: () => {
          trailSince = [];
        },
        sessionStepsLength: () => sessionSteps.length,
        onPersist: async () => {
          await flushTrailPersist();
        },
      });
      findingStore = store;

      // 凭据占位符替换器（fill 用）；替换失败（EnvMissing/SecretMissing）= 终止性错误 → onFatal。
      const valueSub = cred ? makeCredentialValueSub(buildCredentialSource({ envCtx })) : undefined;

      // 数据库取证通道（环境配了 db 对象才有；SqlProbeEnv 结构子集由 envCtx 直接满足）。
      const dbRefs = envCtx.dbs.map((d) => ({ label: d.label, dialect: d.dialect }));
      // 仓库读码通道（有代码提交范围才挂载；diff op 需要 from→to 基线）。
      const repoChannel = codeScope
        ? createRepoReadChannel({
            repoDir: versionWorkspaceDir(sessionRow.versionId),
            fromSha: codeScope.fromSha ?? null,
            toSha: codeScope.toSha ?? null,
            maxCalls: EXPLORATION_MAX_REPO_READS,
          })
        : undefined;

      const tools = createExplorationTools({
        page,
        vision,
        scopeOrigins,
        ...(valueSub ? { valueSub } : {}),
        onFatal: (err) => {
          fatalErr = err;
          piSession.abort();
        },
        allowDestructive: sessionRow.allowDestructive === true,
        errorSignals: () => collector.drainRendered(),
        coverageSummary: () => coverage.render(),
        findings: store,
        noteExcluded: (items) => {
          let accepted = 0;
          for (const item of items ?? []) {
            const claim = typeof item?.claim === 'string' ? item.claim.trim() : '';
            if (!claim || excludedLedger.length >= EXPLORATION_MAX_EXCLUDED) continue;
            if (excludedLedger.some((x) => x.claim === claim)) continue;
            excludedLedger.push({ claim, evidence: typeof item?.evidence === 'string' ? item.evidence.trim().slice(0, 500) : '' });
            accepted += 1;
          }
          if (accepted > 0) void persistSessionState();
          return accepted;
        },
        onFinish: (summary, goalUpdates) => {
          finishSummary = summary;
          // 模型回告的子目标完成情况 → 账本（终态快照随之落库）。
          if (goalUpdates && goalUpdates.length > 0) {
            coverage.markGoals(goalUpdates);
            void persistSessionState();
          }
          piSession.abort();
        },
        ...(dbRefs.length > 0 ? { sql: { env: envCtx, dbRefs } } : {}),
        ...(repoChannel ? { repo: { channel: repoChannel, hasDiff: !!(codeScope?.fromSha && codeScope?.toSha) } } : {}),
        ...(sessionRow.allowFaultInjection === true ? { fault } : {}),
      });
      const piSession = await createExplorationSession({
        cwd: versionWorkspaceDir(sessionRow.versionId),
        tools,
        model,
        explorationPrompt: composeExplorationPrompt({
          charter: sessionRow.charter,
          startUrl,
          persona: persona.directive,
          vision,
          login:
            !cachedState && cred
              ? { userPlaceholder: credentialPlaceholder('user', webRef), passwordPlaceholder: credentialPlaceholder('password', webRef) }
              : null,
          codeScope,
          dbs: dbRefs,
          goals,
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
            // 结果摘要（工具层产出）：这一步「看到了什么/变成了什么/为什么失败」——
            // 没有它，「会话过程」里 observe/截图/页内脚本这些步骤只有 target="-"，用户看不到价值。
            step.outcome = readToolSummary(ev.result) ?? (ev.isError ? fallbackFailureReason(ev.result) : undefined);
            // sql/repo 取证的结果原文进留痕 detail（trailToSteps 的 expected 用）。
            // 只取首行之后的部分：首行是「sql_probe（库）：N 行」这类抬头，已由 outcome 承担。
            if (ev.toolName === 'sql_probe' || ev.toolName === 'repo_read') {
              const content = ev.result?.content as Array<{ type: string; text?: string }> | undefined;
              const firstText = content?.find((b) => b.type === 'text' && typeof b.text === 'string');
              if (firstText?.text) {
                const body = firstText.text.includes('\n') ? firstText.text.slice(firstText.text.indexOf('\n') + 1) : firstText.text;
                step.detail = body.replace(/\s+/g, ' ').slice(0, 400);
              }
            }
            sessionSteps.push(step);
            trailSince.push(step);
            coverage.recordUrl(page);
            if (INTERACTION_KINDS.has(step.type)) coverage.recordInteraction(step.type);
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
      // fill 凭据缺失等终止性错误 → 按失败收尾（重试只会烧轮次，可行动指引在 message 里）。
      if (fatalErr) throw fatalErr;

      // 先落留痕再置终态（详情页一看到终态就停轮询，顺序反了尾段永远拉不到）。
      await flushTrailPersist();
      // 暖登录态回馈（fire-and-forget，失败不影响终态；与 legacy 同语义）
      if (loginKey) void context.storageState().then((s) => saveLoginState(loginKey, s)).catch(() => {});
      await finishSession(sessionId, {
        status: userCancelled ? 'cancelled' : 'completed',
        summary: terminalSummary(),
        turnsUsed: turnCount,
        usage: usage.stat,
      }).catch(() => undefined);
      // A3 独立评审（fire-and-forget：评审不改终态，失败也不影响会话）。
      void judgeExplorationSession(sessionId).catch(() => undefined);
    } finally {
      // D2 故障必须复原——不给被测系统留污染（先复位再关浏览器）。
      await fault?.reset();
      live?.close();
      await browser.close().catch(() => {});
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, sessionId, userCancelled, budgetExceeded }, 'exploration pi session failed');
    await flushTrailPersist();
    await finishSession(sessionId, {
      // finish 已提交总结的会话即使收尾链路抛错也按 completed 落终态（模型明确说完了）。
      status: finishSummary ? 'completed' : userCancelled ? 'cancelled' : budgetExceeded ? 'completed' : 'failed',
      error: finishSummary || userCancelled || budgetExceeded ? null : msg,
      summary: terminalSummary(),
      turnsUsed: turnCount,
      usage: usage.stat,
    }).catch(() => undefined);
    void judgeExplorationSession(sessionId).catch(() => undefined);
  } finally {
    // 兜底落库：正常/失败路径都已在置终态前 flush 过，这里只防意外漏写。
    await flushTrailPersist();
    errorSignals?.close();
    if (envCtx) await envCtx.close().catch(() => {});
  }
}
