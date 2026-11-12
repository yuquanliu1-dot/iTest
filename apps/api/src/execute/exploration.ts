/**
 * 探索式测试会话 runner：charter 驱动的独立 AI 浏览器会话——无 case/步骤绑定，
 * 模板 = pi/space/tools/login.ts perform_login（launch → newContext → registerLiveView → runAiTask）。
 * 产出 findings 缺陷候选（onFindings 即时截图落库）+ live view 整段录像。
 * 终止语义：正常 done → completed；shouldAbort 闭包标志分类（用户取消 → cancelled、
 * 预算耗尽 → completed+注记），绝不解析 runAiTask 的错误文案（文案是执行语境的，不可靠）。
 */
import { eq } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import type { ExplorationReproStep } from '@itest/shared';
import { db } from '../db/client.js';
import { explorationSessions, explorationFindings } from '../db/schema.js';
import {
  claimSession,
  finishSession,
  heartbeat,
  screenshotDiskPath,
  withFindingCounts,
  withTimeout,
} from './explorationShared.js';
import { EXPLORATION_MAX_TURNS, explorationWallClockMs } from './explorationBudget.js';
import { runExplorationSessionPi } from '../pi/exploration/runner.js';
import { judgeExplorationSession } from '../pi/exploration/judge.js';
import { resolveEnv } from './envContext.js';
import {
  runAiTask,
  credentialPlaceholder,
  makeCredentialValueSub,
  originOf,
  SQL_PROBE_MAX_ROWS,
  type AiAction,
  type SqlProbeResult,
  type RepoReadRequest,
  type RepoReadResult,
} from './aiTask.js';
import { runSql } from './sqlQuery.js';
import { buildCredentialSource, renderWebResourceManifest, defaultWebRef } from './credentialSource.js';
import { waitForPageSettled } from './pageSettle.js';
import { registerLiveView } from './liveView.js';
import { newAiUsage } from './aiUsage.js';
import { resolveCodeScope } from './codeScope.js';
import { createRepoReadChannel } from './repoRead.js';
import { versionWorkspaceDir } from '../pi/repo.js';
import {
  composeExplorationInstruction,
  coerceFindings,
  trailToSteps,
  EXPLORATION_SYSTEM_PROMPT_BASE,
  EXPLORATION_MAX_FINDINGS,
  EXPLORATION_MAX_SQL_PROBES,
  EXPLORATION_MAX_REPO_READS,
  EXPLORATION_MAX_EXCLUDED,
  renderRepoActionProtocol,
  type ExplorationStep,
} from './explorationPrompt.js';
import { logger } from '../logger.js';
import { loginStateKey, getLoginState, saveLoginState, type LoginStorageState } from '../pi/space/tools/loginStateCache.js';
import { resolveLlmClient } from '../agent/llmSettings.js';

// 轮次预算/墙钟常量移至 explorationShared.ts（pi 链路 runner 同用一份），按既有对外表面再导出。
export { EXPLORATION_MAX_TURNS, explorationWallClockMs } from './explorationBudget.js';

/** 单次只读取证的等待侧超时（只截断等待，不取消底层查询——只读查询代价可接受）。 */
const SQL_PROBE_TIMEOUT_MS = 10_000;

/** 留痕里单条 SQL 的最长文本：审计要看"查了什么"，但超长 query 不该让留痕膨胀。 */
const SQL_STEP_TARGET_MAX = 1000;

/** 运行时分派开关：EXPLORATION_RUNTIME=pi 走新链路（pi agent + Playwright 工具集），
 *  其余值走 legacy（runAiTask JSON 动作协议，完整保留可随时回退）。默认 legacy。
 *  idleTimeoutMs：空闲看门狗阈值（挂死判据），默认走常量；测试可注入小值。 */
export async function runExplorationSession(input: { sessionId: string; idleTimeoutMs?: number }): Promise<void> {
  if ((process.env.EXPLORATION_RUNTIME ?? 'legacy').trim().toLowerCase() === 'pi') {
    return runExplorationSessionPi(input);
  }
  return runLegacyExplorationSession(input);
}

/** legacy runner（2026-11-11 前的执行核心，保留为回退链路；新链路见 pi/exploration/runner.ts）。 */
async function runLegacyExplorationSession(input: { sessionId: string }): Promise<void> {
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
  // 轮次预算：用户创建会话时可配（null=默认）。墙钟不随它放大（防单轮卡死与探索深度无关）。
  const maxTurns = session.budgetTurns ?? EXPLORATION_MAX_TURNS;
  const usage = newAiUsage();
  let turnCount = 0;
  let userCancelled = false;
  let budgetExceeded = false;
  /** findings 计数（函数作用域：catch 分支也要用来说明「模型报 N 条、落库 M 条」）。 */
  let savedCount = 0;
  let modelReported = 0;
  /** 数据库取证次数（会话级配额，防模型把预算烧在扫库上）。 */
  let sqlProbeCount = 0;
  /** 最近一次查库的结果摘要（平台侧记录的行数/首行）——挂进动作留痕，findings 的复现步骤据此可见取证内容。 */
  let lastSqlDetail = '';
  /** 会话级动作留痕（整场动作序列，永不重置）——详情页「会话过程」的逐步视图。
   *  与 finding 级 trail 的差别：finding 级是"自上一条 finding 起"的片段，
   *  这里连最后一条 finding 之后的尾段也留住（否则收尾前的动作无处可查）。 */
  const sessionSteps: ExplorationStep[] = [];
  /** 落库串行链：并发写同一行时后发请求可能先落库，旧快照覆盖新快照会丢步。 */
  let persistChain: Promise<void> = Promise.resolve();
  /** 会话级动作留痕 + 负面结果账本落库。失败只记日志——留痕是审计辅助，不能因此掀翻整场会话。 */
  const persistSessionState = async (): Promise<void> => {
    persistChain = persistChain
      .then(async () => {
        await db
          .update(explorationSessions)
          .set({ actionsTrail: sessionSteps, excludedLedger, updatedAt: new Date() })
          .where(eq(explorationSessions.id, sessionId));
      })
      .catch((e) => {
        logger.warn({ err: e, sessionId }, 'exploration session state persist failed');
      });
    return persistChain;
  };
  /**
   * 动作级落库防抖：onAction 是同步回调（不能 await），连续动作合并成一次写。
   * 窗口 1s——详情页 2s 轮询一次，1s 足够让步骤在跑动中逐条长出来；
   * 不做防抖的话每个动作一次 UPDATE，长会话把库打爆。
   * 定时器不续期（第一个待写动作起算）：动作流不断时也不会饿死这次写。
   */
  const TRAIL_PERSIST_DEBOUNCE_MS = 1000;
  let trailTimer: NodeJS.Timeout | undefined;
  const scheduleTrailPersist = (): void => {
    if (trailTimer) return;
    trailTimer = setTimeout(() => {
      trailTimer = undefined;
      void persistSessionState();
    }, TRAIL_PERSIST_DEBOUNCE_MS);
  };
  /** 立刻落库（收尾用）：清掉待触发的防抖写，保证此刻库里的留痕是全的。 */
  const flushTrailPersist = async (): Promise<void> => {
    if (trailTimer) {
      clearTimeout(trailTimer);
      trailTimer = undefined;
    }
    await persistSessionState();
  };
  /**
   * 负面结果账本（外化记忆最小切片）：模型申报的「已排除的假设 + 依据」。
   * 只存排除项不存信念——黑板存信念会把观察冻成结论、自我印证。
   */
  const excludedLedger: Array<{ claim: string; evidence: string }> = [];
  /** 模型申报排除项 → 累加去重 + 落库（跑动中详情页即可见）。 */
  const onExcluded = (items: Array<{ claim: string; evidence: string }>): void => {
    for (const e of items) {
      if (excludedLedger.length >= EXPLORATION_MAX_EXCLUDED) break;
      if (excludedLedger.some((x) => x.claim === e.claim)) continue;
      excludedLedger.push(e);
    }
    void flushTrailPersist();
  };

  try {
    // —— 代码提交范围解析（charter 自然语言 → git 范围；LLM+git 可达 180s，浏览器启动前做）——
    // 前后各一次心跳：解析期间看门狗不至于误杀，顺带捕捉解析期间的取消请求。
    // none/failed → codeScope undefined，探索照常全站跑（软失败，会话不掀翻）。
    await heartbeat(sessionId);
    const { scope: codeScope } = await resolveCodeScope({ sessionId, charter: session.charter, versionId: session.versionId });
    if (await heartbeat(sessionId)) {
      await finishSession(sessionId, { status: 'cancelled', turnsUsed: 0, usage: usage.stat }).catch(() => undefined);
      return;
    }
    // 探索墙钟从范围解析结束后起算——预算全部留给智能体阶段。
    // 墙钟由轮次物化（不再固定 15 分钟）：轮次是深度的唯一旋钮。
    const deadline = Date.now() + explorationWallClockMs(maxTurns);

    envCtx = await resolveEnv({ versionId: session.versionId }, { expectedProjectId: session.projectId });
    // 探针闭包里要用 env（envCtx 是 let，闭包内 TS 不做窄化）
    const env = envCtx;
    const client = (await resolveLlmClientForExploration()).client;
    const webRef = defaultWebRef({ envCtx });
    const cred = webRef ? envCtx.resolveLogin(webRef) : null;
    const startUrl = session.startUrl?.trim() || envCtx.baseUrl || cred?.loginUrl || '';
    if (!startUrl) throw new Error('缺少探索起点 URL（会话未填 startUrl，且环境未配置 baseUrl/loginUrl）');
    // 探索范围白名单 = 起点 origin（唯一）。
    // runAiTask 侧对越界 navigate 事前拒收——charter 的「禁止离开」只是提示词约束，
    // 2026-11-10 prod 实证过它拦不住模型（SUT 挂掉 → 自主导航到真实系统 + 真凭据登录 + 写数据）。
    // 刻意不加「环境 web 资源的 loginUrl origin」：那个 origin 往往正是真实被测系统本身
    // （prod 的 SOC 192.168.30.123:1688），加进白名单等于把上面那条越界写数据路径重新打开。
    // 起点 origin 不可解析 → 白名单为空数组 = navigate 全拒（保守收口，模型输出 fail）。
    const startOrigin = originOf(startUrl);
    const scopeOrigins = startOrigin ? [startOrigin] : [];
    // 数据库取证通道：环境配了 db 对象才有（label 即 ref；提示词里逐个列出，模型可点名查哪个库）。
    // 通道本身是只读的——只读守卫在 aiTask 侧先过一道，runSql 内部再兜一道。
    const dbRefs = envCtx.dbs.map((d) => ({ label: d.label, dialect: d.dialect }));

    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
    try {
      const loginKey = cred ? loginCacheKey(envCtx.envId, cred.user) : null;
      const cachedState = loginKey ? getLoginStateFor(loginKey) : null;
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        // 两态视口：会话建时给了成对宽高=自定义；缺省 1280×800（与用例「默认最大化」headless
        // 近似值一致）。aiTask 坐标系按视口归一化 0-1000 动态读 viewportSize，任意尺寸兼容。
        viewport:
          session.windowWidth && session.windowHeight
            ? { width: session.windowWidth, height: session.windowHeight }
            : { width: 1280, height: 800 },
        ...(cachedState ? { storageState: cachedState } : {}),
      });
      const page = await context.newPage();
      // 实时画面 + 整段录像（key 稳定 = 会话回放能力；结束 close 收流，录制留供回放）
      live = registerLiveView(`exploration:${sessionId}`);
      live.setPage(page);

      // findings 收集闭包：seenTitles 跨轮去重、trail 自上一条 finding 起累积、order 递增
      const seenTitles = new Set<string>();
      const trail: ExplorationStep[] = [];
      const onAction = (a: AiAction, ok: boolean): void => {
        let target = '-';
        let detail: string | undefined;
        if (a.type === 'click' || a.type === 'fill') {
          if (typeof a.selector === 'string' && a.selector) target = a.selector;
          else if (typeof a.x === 'number' && typeof a.y === 'number') target = `(${a.x},${a.y})`;
        } else if (a.type === 'navigate') {
          target = a.url;
        } else if (a.type === 'sql') {
          // 留完整 SQL（审计要看到"到底查了什么"），只归一空白并限长——
          // 模型可以吐出超长 query，守卫虽会拒，但留痕不能因此膨胀。
          target = a.query.replace(/\s+/g, ' ').slice(0, SQL_STEP_TARGET_MAX);
          detail = lastSqlDetail || undefined;
        } else if (a.type === 'repo') {
          target = `${a.op} ${a.path ?? a.pattern ?? ''}`.trim();
          detail = lastRepoDetail || undefined;
        } else if (a.type === 'press') {
          target = a.key;
        } else if (a.type === 'wait') {
          target = String(a.ms);
        } else if (a.type === 'screenshot') {
          target = a.selector ?? (typeof a.x === 'number' && typeof a.y === 'number' ? `@${a.x},${a.y}` : '-');
        }
        const step: ExplorationStep = {
          type: a.type,
          target,
          ok,
          ...(detail ? { detail } : {}),
          // 原形字段（升格用例的机械映射需要；onAction 收到的动作 value 仍是模型输出的
          // 占位符字面量/普通文本，绝不是替换后的真实凭据——替换发生在执行器内部）。
          ...(a.type === 'fill' ? { value: a.value } : {}),
          ...(a.type === 'wait' ? { ms: a.ms } : {}),
          ...(a.type === 'press' ? { key: a.key } : {}),
        };
        trail.push(step);
        sessionSteps.push(step);
        // 动作级增量落库（防抖）：跑动中详情页就能看到步骤逐条长出来，
        // 而不是攒到下一条 finding 才整块跳一次（甚至全程不报 finding 时拖到收尾才出现）。
        scheduleTrailPersist();
      };
      const onFindings = async (raw: unknown[]): Promise<void> => {
        modelReported += raw.length;
        const { accepted, dropped, invalid, invalidShapes } = coerceFindings(raw, {
          existingTitles: [...seenTitles],
          max: Math.max(0, EXPLORATION_MAX_FINDINGS - savedCount),
        });
        if (dropped > 0) {
          logger.warn({ sessionId, reported: raw.length, dropped, invalid, invalidShapes }, 'exploration findings dropped');
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
              reproSteps: f.reproSteps.length > 0 ? f.reproSteps : trailToSteps(trail),
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
        // 只有落了 finding 才重置留痕：整批被去重丢弃时，动作序列要留给下一条 finding，
        // 否则「自上一条 finding 起累积」的语义会被丢弃批次截断。
        if (accepted.length > 0) trail.length = 0;
        // 会话级留痕同步落库（跑动中就能在详情页看到进度，不等会话结束）
        await flushTrailPersist();
      };

      /** 数据库取证探针：模型给一条只读查询 → 对被测库执行 → 行摘要回灌下一轮。
       *  只读守卫在 aiTask 侧先过一道（守卫不过绝不调到这里），runSql 内部再兜一道。
       *  配额按会话计：查库是取证手段不是探索主路径，超额即拒。 */
      const runSqlProbe = async (query: string, opts: { limit: number; db?: string }): Promise<SqlProbeResult> => {
        if (sqlProbeCount >= EXPLORATION_MAX_SQL_PROBES) {
          lastSqlDetail = '取证次数已用尽';
          return { ok: false, error: `本会话数据库取证次数已用尽（上限 ${EXPLORATION_MAX_SQL_PROBES} 次）` };
        }
        sqlProbeCount += 1;
        const entry = env.resolveDb(opts.db ?? null);
        if (!entry) {
          const names = dbRefs.map((d) => d.label);
          lastSqlDetail = '库未命中';
          return {
            ok: false,
            error: `数据库对象未命中${opts.db ? `「${opts.db}」` : '（未指定 db，走环境默认库）'}，可用:${names.join('、') || '(无)'}`,
          };
        }
        try {
          const pool = await env.resolveDbPool(entry.label);
          const limit = Math.min(Math.max(1, opts.limit), SQL_PROBE_MAX_ROWS);
          const r = await withTimeout(
            runSql({ pool, action: { kind: 'sql', sql: query, params: [], limit }, dbRef: entry.label }),
            SQL_PROBE_TIMEOUT_MS,
            `查询超时（${SQL_PROBE_TIMEOUT_MS / 1000}s 未返回）`,
          );
          const head = r.rows.length > 0
            ? Object.entries(r.rows[0]!)
                .map(([k, v]) => `${k}=${v == null ? 'NULL' : String(v).slice(0, 30)}`)
                .join(' | ')
                .slice(0, 160)
            : '（无行）';
          lastSqlDetail = `${r.rowCount} 行${r.truncated ? '（已按 limit 截断）' : ''}｜首行：${head}`;
          return { ok: true, rowCount: r.rowCount, truncated: !!r.truncated, rows: r.rows };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lastSqlDetail = `失败：${msg.slice(0, 120)}`;
          return { ok: false, error: msg.slice(0, 200) };
        }
      };

      /** 仓库读码通道（只在有代码提交范围的会话挂上）：read/grep/ls/diff 四 op 全只读，
       *  沙箱限版本工作树内 + 会话级配额 + 输出封顶都收口在 createRepoReadChannel。
       *  这里只包一层留痕摘要——「会话过程」每条 repo 动作要带一行结果摘要。 */
      let lastRepoDetail = '';
      const repoReadChannel = createRepoReadChannel({
        repoDir: versionWorkspaceDir(session.versionId),
        fromSha: codeScope?.fromSha ?? null,
        toSha: codeScope?.toSha ?? null,
        maxCalls: EXPLORATION_MAX_REPO_READS,
      });
      const runRepoRead = async (req: RepoReadRequest): Promise<RepoReadResult> => {
        const r = await repoReadChannel(req);
        lastRepoDetail = r.ok
          ? `${r.content.split('\n').filter(Boolean).length} 行`
          : `失败：${r.error.slice(0, 120)}`;
        return r;
      };

      logger.info({ sessionId, promptBase: 'exploration', dbCount: dbRefs.length }, 'exploration system prompt base applied');

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
          dbs: dbRefs,
          codeScope: codeScope ?? undefined,
        }),
        client,
        false,
        {
          // 轮次软预算由 shouldAbort 先触发；+16 硬闸仅 runaway 兜底（随预算放大）
          maxTurns: maxTurns + 16,
          valueSub: cred ? makeCredentialValueSub(buildCredentialSource({ envCtx })) : undefined,
          resourceManifest: renderWebResourceManifest({ envCtx }),
          scopeOrigins,
          // 有代码范围才追加 repo 读码协议（无范围会话的系统提示词与今天逐字节一致——零回归）
          systemPromptBase: codeScope ? EXPLORATION_SYSTEM_PROMPT_BASE + '\n\n' + renderRepoActionProtocol() : EXPLORATION_SYSTEM_PROMPT_BASE,
          runSqlProbe: dbRefs.length > 0 ? runSqlProbe : undefined,
          runRepoRead: codeScope ? runRepoRead : undefined,
          // 破坏性动作闸：默认拒（会话建时显式授权才放行）。charter 说辞不算授权。
          destructivePolicy: { allow: !!session.allowDestructive },
          onUsage: (r) => usage.add(r),
          onAction,
          onFindings,
          onExcluded,
          shouldAbort: async () => {
            // 心跳 + 取消标志同一条 SQL（每轮一次）：看门狗据此判死僵死会话。
            if (await heartbeat(sessionId)) {
              userCancelled = true;
              return true;
            }
            turnCount += 1;
            if (turnCount > maxTurns || Date.now() > deadline) {
              budgetExceeded = true;
              return true;
            }
            return false;
          },
        },
      );
      // 先落留痕再置终态：详情页一看到终态就停轮询（前端只在 running 时轮询），
      // 顺序反了则「最后一条 finding 之后的尾段」永远拉不到，得手动刷新才看得到。
      await flushTrailPersist();
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
      // A3 独立评审（fire-and-forget：评审不改终态，失败也不影响会话）。
      void judgeExplorationSession(sessionId).catch(() => undefined);
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
    // 同上：置终态前先落留痕，终态那一刻库里的步骤序列必须是全的。
    await flushTrailPersist();
    await finishSession(sessionId, {
      status: userCancelled ? 'cancelled' : budgetExceeded ? 'completed' : 'failed',
      error: userCancelled || budgetExceeded ? null : msg,
      summary: budgetExceeded
        ? withFindingCounts(`探索结束（预算耗尽，${turnCount} 轮后停止）`, modelReported, savedCount)
        : null,
      turnsUsed: turnCount,
      usage: usage.stat,
    }).catch(() => undefined);
    void judgeExplorationSession(sessionId).catch(() => undefined);
  } finally {
    // 兜底落库：正常/失败路径都已在置终态前 flush 过，这里只防意外漏写。
    await flushTrailPersist();
    if (envCtx) await envCtx.close().catch(() => {});
  }
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
