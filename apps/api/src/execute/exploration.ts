/**
 * Exploratory-testing session runner: a charter-driven standalone AI browser session — no case/step binding.
 * Template = pi/space/tools/login.ts perform_login (launch → newContext → registerLiveView → runAiTask).
 * Produces findings defect candidates (onFindings screenshots persisted immediately) + a live view full recording.
 * Termination semantics: normal done → completed; the shouldAbort closure flag is classified (user cancel → cancelled,
 * budget exhausted → completed+note); runAiTask's error wording is never parsed (it is execution-context wording, unreliable).
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

// Turn-budget/wall-clock constants moved to explorationShared.ts (the pi-chain runner uses the same copy); re-exported over the existing public surface.
export { EXPLORATION_MAX_TURNS, explorationWallClockMs } from './explorationBudget.js';

/** Waiting-side timeout for a single read-only evidence probe (only truncates the wait, never cancels the underlying query — an acceptable cost for read-only queries). */
const SQL_PROBE_TIMEOUT_MS = 10_000;

/** Max text length of a single SQL entry in the action trail: audit needs to see "what was queried", but an overlong query shouldn't bloat the trail. */
const SQL_STEP_TARGET_MAX = 1000;

/** Runtime dispatch switch: EXPLORATION_RUNTIME=pi takes the new chain (pi agent + Playwright toolset),
 *  any other value takes legacy (the runAiTask JSON action protocol, fully kept for rollback anytime). Default legacy.
 *  idleTimeoutMs: idle watchdog threshold (hang criterion), defaults to the constant; tests may inject a small value. */
export async function runExplorationSession(input: { sessionId: string; idleTimeoutMs?: number }): Promise<void> {
  if ((process.env.EXPLORATION_RUNTIME ?? 'legacy').trim().toLowerCase() === 'pi') {
    return runExplorationSessionPi(input);
  }
  return runLegacyExplorationSession(input);
}

/** Legacy runner (the execution core before 2026-11-11, kept as the fallback chain; the new chain is pi/exploration/runner.ts). */
async function runLegacyExplorationSession(input: { sessionId: string }): Promise<void> {
  const { sessionId } = input;
  const session = (await db.select().from(explorationSessions).where(eq(explorationSessions.id, sessionId)))[0];
  if (!session) return;
  if (!(await claimSession(sessionId))) return;
  // Cancelled while pending: finish up directly without opening a browser
  if (session.cancelRequested) {
    await db.update(explorationSessions).set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() }).where(eq(explorationSessions.id, sessionId));
    return;
  }

  let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
  let live: ReturnType<typeof registerLiveView> | undefined;
  // Turn budget: user-configurable at session creation (null = default). The wall clock doesn't scale up with it (a single stuck turn is unrelated to exploration depth).
  const maxTurns = session.budgetTurns ?? EXPLORATION_MAX_TURNS;
  const usage = newAiUsage();
  let turnCount = 0;
  let userCancelled = false;
  let budgetExceeded = false;
  /** Findings count (function scope: the catch branch also uses it to state "model reported N, persisted M"). */
  let savedCount = 0;
  let modelReported = 0;
  /** Database evidence probe count (session-level quota, keeping the model from burning its budget scanning the DB). */
  let sqlProbeCount = 0;
  /** Summary of the latest DB query result (row count/first row recorded platform-side) — attached to the action trail so findings' repro steps can show what was probed. */
  let lastSqlDetail = '';
  /** Session-level action trail (the whole run's action sequence, never reset) — the step view of the detail page's "session activity".
   *  Difference from the finding-level trail: the finding level is the fragment "since the previous finding",
   *  while this keeps even the tail after the last finding (otherwise actions before finishing would be untraceable). */
  const sessionSteps: ExplorationStep[] = [];
  /** Persistence serialization chain: with concurrent writes to one row a later request may land first, and an old snapshot overwriting a newer one would drop steps. */
  let persistChain: Promise<void> = Promise.resolve();
  /** Persists the session-level action trail + the negative-result ledger. Failures are only logged — the trail is an audit aid and must not topple the whole session. */
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
   * Action-level persistence debounce: onAction is a synchronous callback (can't await), so consecutive actions merge into one write.
   * Window 1s — the detail page polls every 2s, so 1s suffices for steps to grow one by one while running;
   * without the debounce, one UPDATE per action would pound the DB flat over long sessions.
   * The timer is not renewed (counts from the first pending action): a continuous action stream won't starve this write either.
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
  /** Persist immediately (for finishing): cancel the pending debounced write so the trail in the DB is complete at this moment. */
  const flushTrailPersist = async (): Promise<void> => {
    if (trailTimer) {
      clearTimeout(trailTimer);
      trailTimer = undefined;
    }
    await persistSessionState();
  };
  /**
   * Negative-result ledger (the smallest slice of externalized memory): the model-declared "excluded hypotheses + evidence".
   * Store exclusions, never beliefs — a blackboard storing beliefs freezes observations into conclusions and self-confirms.
   */
  const excludedLedger: Array<{ claim: string; evidence: string }> = [];
  /** Model-declared exclusions → accumulate, dedupe, persist (visible on the detail page while running). */
  const onExcluded = (items: Array<{ claim: string; evidence: string }>): void => {
    for (const e of items) {
      if (excludedLedger.length >= EXPLORATION_MAX_EXCLUDED) break;
      if (excludedLedger.some((x) => x.claim === e.claim)) continue;
      excludedLedger.push(e);
    }
    void flushTrailPersist();
  };

  try {
    // — Code commit scope resolution (charter natural language → git scope; LLM+git can take 180s, done before browser launch) —
    // A heartbeat before and after: the watchdog won't miskill during resolution, and a cancel request during it is caught too.
    // none/failed → codeScope undefined, exploration proceeds site-wide as usual (soft failure, the session isn't toppled).
    await heartbeat(sessionId);
    const { scope: codeScope } = await resolveCodeScope({ sessionId, charter: session.charter, versionId: session.versionId });
    if (await heartbeat(sessionId)) {
      await finishSession(sessionId, { status: 'cancelled', turnsUsed: 0, usage: usage.stat }).catch(() => undefined);
      return;
    }
    // The exploration wall clock starts after scope resolution ends — the whole budget goes to the agent phase.
    // The wall clock is materialized from turns (no longer a fixed 15 minutes): turns are the only depth knob.
    const deadline = Date.now() + explorationWallClockMs(maxTurns);

    envCtx = await resolveEnv({ versionId: session.versionId }, { expectedProjectId: session.projectId });
    // The probe closures need env (envCtx is a let; TS doesn't narrow it inside closures)
    const env = envCtx;
    const client = (await resolveLlmClientForExploration()).client;
    const webRef = defaultWebRef({ envCtx });
    const cred = webRef ? envCtx.resolveLogin(webRef) : null;
    const startUrl = session.startUrl?.trim() || envCtx.baseUrl || cred?.loginUrl || '';
    if (!startUrl) throw new Error('缺少探索起点 URL（会话未填 startUrl，且环境未配置 baseUrl/loginUrl）');
    // Exploration scope whitelist = the starting origin (the only entry).
    // runAiTask rejects out-of-scope navigates upfront — the charter's "no leaving" is only a prompt constraint;
    // proven on 2026-11-10 prod that it can't stop the model (SUT down → autonomous navigation to the real system + login with real credentials + data writes).
    // Deliberately NOT adding "the environment web resources' loginUrl origin": that origin is often the real SUT itself
    // (prod's SOC 192.168.30.123:1688), and whitelisting it would reopen the out-of-scope data-write path above.
    // Unresolvable starting origin → empty whitelist array = all navigates rejected (conservative closure; the model outputs fail).
    const startOrigin = originOf(startUrl);
    const scopeOrigins = startOrigin ? [startOrigin] : [];
    // Database evidence channel: exists only when the environment has db objects (label is the ref; listed one by one in the prompt so the model can name which DB to query).
    // The channel itself is read-only — the read-only guard passes first on the aiTask side, and runSql backs it up internally.
    const dbRefs = envCtx.dbs.map((d) => ({ label: d.label, dialect: d.dialect }));

    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
    try {
      const loginKey = cred ? loginCacheKey(envCtx.envId, cred.user) : null;
      const cachedState = loginKey ? getLoginStateFor(loginKey) : null;
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        // Two-state viewport: a width/height pair at session creation = custom; default 1280×800 (matching the case's "default maximize" headless
        // approximation). The aiTask coordinate system reads viewportSize dynamically (viewport-normalized 0-1000), compatible with any size.
        viewport:
          session.windowWidth && session.windowHeight
            ? { width: session.windowWidth, height: session.windowHeight }
            : { width: 1280, height: 800 },
        ...(cachedState ? { storageState: cachedState } : {}),
      });
      const page = await context.newPage();
      // Live view + full recording (a stable key = session replay capability; close collects the stream at the end, the recording kept for replay)
      live = registerLiveView(`exploration:${sessionId}`);
      live.setPage(page);

      // Findings collection closure: seenTitles dedupes across turns, the trail accumulates since the previous finding, order increments
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
          // Keep the full SQL (audit must see "what was actually queried"); only normalize whitespace and cap length —
          // the model can emit an overlong query; the guard may reject it, but the trail must not bloat because of that.
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
          // Raw-shape fields (the promoted case's mechanical mapping needs them; the action value onAction receives is still the model's output —
          // placeholder literals/plain text, never the substituted real credentials — substitution happens inside the executor).
          ...(a.type === 'fill' ? { value: a.value } : {}),
          ...(a.type === 'wait' ? { ms: a.ms } : {}),
          ...(a.type === 'press' ? { key: a.key } : {}),
        };
        trail.push(step);
        sessionSteps.push(step);
        // Action-level incremental persistence (debounced): the detail page sees steps grow one by one while running,
        // instead of jumping in one block only at the next finding (or dragging all the way to the finish when no findings are ever reported).
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
          } catch { /* best-effort settle: screenshot even on failure */ }
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
            savedCount -= 1; // roll back the quota on persistence failure so the next round can re-report
            logger.warn({ err: e, sessionId }, 'exploration finding insert failed');
          }
        }
        // Reset the trail only when a finding actually persisted: when a whole batch was dropped as duplicates, the action sequence must be kept for the next finding,
        // otherwise the "accumulated since the previous finding" semantics would be truncated by the dropped batch.
        if (accepted.length > 0) trail.length = 0;
        // Persist the session-level trail synchronously (progress is visible on the detail page while running, not waiting for the session to end)
        await flushTrailPersist();
      };

      /** Database evidence probe: the model supplies a read-only query → executed against the SUT DB → a row summary is fed back next turn.
       *  The read-only guard passes first on the aiTask side (a guarded-out query never reaches here), and runSql backs it up internally.
       *  Quota is per session: DB queries are an evidence channel, not the main exploration path — over quota is rejected. */
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

      /** Repo code-reading channel (mounted only on sessions with a code commit scope): all four ops read/grep/ls/diff are read-only;
       *  the sandbox confined to the version worktree + session quota + output caps all close inside createRepoReadChannel.
       *  This only wraps a trail summary — each repo action in "session activity" carries a one-line result summary. */
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
          // The soft turn budget fires via shouldAbort first; the +16 hard gate only catches runaway (scales with the budget)
          maxTurns: maxTurns + 16,
          valueSub: cred ? makeCredentialValueSub(buildCredentialSource({ envCtx })) : undefined,
          resourceManifest: renderWebResourceManifest({ envCtx }),
          scopeOrigins,
          // The repo-reading protocol is appended only with a code scope (scopeless sessions' system prompt stays byte-identical to today — zero regression)
          systemPromptBase: codeScope ? EXPLORATION_SYSTEM_PROMPT_BASE + '\n\n' + renderRepoActionProtocol() : EXPLORATION_SYSTEM_PROMPT_BASE,
          runSqlProbe: dbRefs.length > 0 ? runSqlProbe : undefined,
          runRepoRead: codeScope ? runRepoRead : undefined,
          // Destructive-action gate: rejected by default (passes only with explicit authorization at session creation). Charter wording is not authorization.
          destructivePolicy: { allow: !!session.allowDestructive },
          onUsage: (r) => usage.add(r),
          onAction,
          onFindings,
          onExcluded,
          shouldAbort: async () => {
            // Heartbeat + cancel flag in the same SQL (once per turn): the watchdog declares zombie sessions dead by it.
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
      // Persist the trail before setting the final state: the detail page stops polling the moment it sees a final state (the frontend polls only while running);
      // in the wrong order, "the tail after the last finding" would never be fetched — only a manual refresh would show it.
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
      // A3 independent review (fire-and-forget: the review doesn't change the final state, and its failure doesn't affect the session).
      void judgeExplorationSession(sessionId).catch(() => undefined);
      // Warm login-state cache fed back to verify_case/perform_login (fire-and-forget; failure doesn't affect the session's final state)
      if (loginKey) void context.storageState().then((s) => saveLoginStateFor(loginKey, s)).catch(() => {});
    } finally {
      live?.close();
      await browser.close().catch(() => {});
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, sessionId, userCancelled, budgetExceeded }, 'exploration session failed');
    // User cancel/budget exhaustion is not a failure (findings already captured are all kept); other real exceptions → failed
    // Budget exhaustion arrives as the interruption thrown by shouldAbort (runAiTask throws rather than returning normally),
    // so the summary can only be filled in here — otherwise the session ends as "completed with no summary", hiding why it stopped.
    // Same as above: persist the trail before setting the final state; the step sequence in the DB must be complete at that moment.
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
    // Fallback persistence: both the normal and failure paths already flushed before setting the final state; this only guards an accidental missed write.
    await flushTrailPersist();
    if (envCtx) await envCtx.close().catch(() => {});
  }
}

/** Cleans up the evidence screenshot directory when a session is deleted (same contract as reports.unlinkReportScreenshots). */
export async function removeExplorationScreenshots(sessionId: string): Promise<void> {
  await rm(join(process.cwd(), 'screenshots', sessionId), { recursive: true, force: true }).catch(() => undefined);
}

// — Indirect dependencies (the seams tests can mock): loginStateCache / llmSettings closed over as function references —
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
