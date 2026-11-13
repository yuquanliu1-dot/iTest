/**
 * Exploratory testing session runner (pi chain): pi agent's native tool-calling loop + a Playwright custom tool set —
 * isomorphic to "Claude Code + chrome-devtools MCP" (native tool calls + visual tool results + interruptible).
 *
 * Orchestration reuses the shared foundation in explorationShared (claim/heartbeat/wrap-up share the same semantics as
 * legacy: idempotent claim, trail persisted before the final state is set, 1s debounce); the difference is the execution core:
 * - Capability probes run before the start: a channel without tool-call support → immediate failed + actionable error
 *   (no burning the turn budget); a vision probe that cannot read the unique code → degrade to plain-text mode (tools
 *   attach no images), session runs as usual.
 * - Heartbeat/cancel/budget hang off message_end + tool_execution_end (one pi round can chain multiple tools;
 *   hanging only off message_end would starve the 5min watchdog); a hit calls session.abort().
 * - Action trail: registered at tool_execution_start (args visible), ok backfilled at end —
 *   the tool_execution_end event carries no args (pi-agent-core AgentEvent union), so registration must happen at start.
 */
import { eq } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import { getExplorationPersona } from '@itest/shared';
import { db } from '../../db/client.js';
import { explorationSessions } from '../../db/schema.js';
import { claimSession, finishSession, heartbeat, persistTurnProgress } from '../../execute/explorationShared.js';
import {
  explorationWallClockMs,
  EXPLORATION_IDLE_TIMEOUT_MS,
  EXPLORATION_MAX_TURNS,
} from '../../execute/explorationBudget.js';
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
import { createCoverageTracker, coverageDigest } from './coverage.js';
import { createErrorSignalCollector } from './observation.js';
import { fallbackFailureReason, readToolSummary } from './trail.js';

/** Interaction action kinds counted by the coverage ledger (observation/verdict actions are not interactions — the ledger answers "where did it act"). */
const INTERACTION_KINDS = new Set(['click', 'fill', 'press', 'select', 'scroll', 'back', 'navigate']);

/**
 * Exploratory testing session runner (pi chain) entry point: dispatched here by execute/exploration.ts when EXPLORATION_RUNTIME=pi.
 */
export async function runExplorationSessionPi(input: { sessionId: string; idleTimeoutMs?: number }): Promise<void> {
  const { sessionId } = input;
  const sessionRow = (await db.select().from(explorationSessions).where(eq(explorationSessions.id, sessionId)))[0];
  if (!sessionRow) return;
  if (!(await claimSession(sessionId))) return;
  // Cancelled during pending: wrap up directly without opening a browser
  if (sessionRow.cancelRequested) {
    await db
      .update(explorationSessions)
      .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(explorationSessions.id, sessionId));
    return;
  }

  let envCtx: Awaited<ReturnType<typeof resolveEnv>> | undefined;
  let live: ReturnType<typeof registerLiveView> | undefined;
  /** D2 fault controller (declared outside the try — the wrap-up finally must be able to reset it). */
  let fault: FaultController | undefined;
  const maxTurns = sessionRow.budgetTurns ?? EXPLORATION_MAX_TURNS;
  const usage = newAiUsage();
  let turnCount = 0;
  let userCancelled = false;
  let budgetExceeded = false;
  /** Model call hung (no pi event for over EXPLORATION_IDLE_TIMEOUT_MS) → abort the session. */
  let idleTimedOut = false;
  /** Time of the last pi event (the idle watchdog's criterion; refreshed on every chunk during streaming). */
  let lastEventAt = Date.now();
  /** Idle watchdog timer (must be cleared in finally). */
  let idleTimer: NodeJS.Timeout | undefined;
  /** Hung criterion: no pi event for this long = this round is never coming back. Default 5 minutes —
   *  reasoning gateways can take a long time before the first byte (no tokens during the thinking phase);
   *  a threshold too small would falsely kill normal calls. */
  const idleTimeoutMs = input.idleTimeoutMs ?? EXPLORATION_IDLE_TIMEOUT_MS;
  /** Watchdog polling interval (never above the threshold itself — must keep up when the threshold is small). */
  const idleCheckMs = Math.min(30_000, idleTimeoutMs);
  /** DB heartbeat refresh interval: after the wall-clock enlargement (up to 240 minutes), the heartbeat cannot be
   *  refreshed only at turn boundaries — one long thinking/streaming round can exceed the outer watchdog's
   *  dead-session window (5 minutes), at which point a live session would be misjudged as "executor interrupted".
   *  Every 30s: the heartbeat stays fresh, and the ruling on hangs is left to this runner's idle watchdog
   *  (the final state can then give an actionable reason like "no response for a long time" instead of failed). */
  const HEARTBEAT_REFRESH_MS = 30_000;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  /** Last assistant text (done summary: the summary when the pi loop ends naturally). */
  let summaryText = '';
  /** Summary submitted by the finish tool (finish aborts afterwards; both normal/error paths use it as the final summary). */
  let finishSummary: string | null = null;
  /** Fatal error (missing fill credentials etc.): terminates the session and wraps up as failed. */
  let fatalErr: Error | undefined;
  /** Finding store (created in-page; the catch path reads savedCount to assemble the summary). */
  let findingStore: FindingStore | undefined;
  /** Session-level action trail (tool events → ExplorationStep), persisted with the same debounce as legacy. */
  const sessionSteps: ExplorationStep[] = [];
  /** Trail fragment since the last finding (cleared when a finding persists successfully; goes into finding.actions_trail). */
  let trailSince: ExplorationStep[] = [];
  /** Exclusion ledger (same as legacy: stores exclusions, not beliefs; dedup + cap). */
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
  /** Action-level persistence debounce (same as legacy: 1s window; the detail page's 2s polling sees it grow step by step). */
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
  /** Final summary: finish submission > budget/hang annotation > last assistant text; the defect count and coverage digest ride along on both paths. */
  const terminalSummary = (): string | null => {
    const countsNote = (findingStore?.savedCount ?? 0) > 0 ? `（报告缺陷 ${findingStore!.savedCount} 条）` : '';
    // Coverage digest: how much was covered and which sub-goals were not — exploration depth is not just rounds run.
    const coverageNote = coverageLedger ? `（覆盖：${coverageDigest(coverageLedger.snapshot())}）` : '';
    // Notes join with a blank line: the summary is model markdown now, so platform notes render as their own paragraph instead of fusing into the last bullet.
    const notes = [countsNote, coverageNote].filter(Boolean).join('');
    if (finishSummary) return `${finishSummary}\n\n${notes}`.trim();
    const stopNote = idleTimedOut
      ? '（模型调用长时间无响应，已中止）'
      : budgetExceeded
        ? `（预算耗尽，${turnCount} 轮后停止）`
        : '';
    // finish never submitted: the last assistant text is not a formal summary (may be a mid-run observation note / English chatter),
    // so label it honestly before quoting — the user should not read wreckage as conclusions.
    const body = summaryText ? `模型未提交正式总结（以下为末条发言）：${summaryText}` : '探索结束';
    return `${body}${stopNote}${countsNote}${coverageNote}`.trim();
  };

  try {
    // Session liveness evidence: refreshed on a timer (covers the whole session run, including long thinking rounds —
    // the turn-boundary heartbeat does not fire during them).
    heartbeatTimer = setInterval(() => {
      void heartbeat(sessionId).catch((e) => logger.warn({ err: e, sessionId }, 'exploration heartbeat refresh failed'));
    }, HEARTBEAT_REFRESH_MS);
    await heartbeat(sessionId);
    envCtx = await resolveEnv({ versionId: sessionRow.versionId }, { expectedProjectId: sessionRow.projectId });
    const webRef = defaultWebRef({ envCtx });
    const cred = webRef ? envCtx.resolveLogin(webRef) : null;
    const startUrl = sessionRow.startUrl?.trim() || envCtx.baseUrl || cred?.loginUrl || '';
    if (!startUrl) throw new Error('缺少探索起点 URL（会话未填 startUrl，且环境未配置 baseUrl/loginUrl）');
    // Scope whitelist = the start origin, the only one allowed (same rule as legacy; unparseable → empty array = all navigate rejected).
    const startOrigin = originOf(startUrl);
    const scopeOrigins = startOrigin ? [startOrigin] : [];

    // —— Code commit scope (charter natural language → git scope; a heartbeat before and after: the watchdog does not
    // falsely kill during parsing and a cancel is caught along the way. none/failed → codeScope null, the exploration
    // runs the whole site as usual, repo_read not mounted) ——
    await heartbeat(sessionId);
    const { scope } = await resolveCodeScope({ sessionId, charter: sessionRow.charter, versionId: sessionRow.versionId });
    const codeScope: CodeScope | null = scope ?? null;
    if (await heartbeat(sessionId)) {
      await finishSession(sessionId, { status: 'cancelled', turnsUsed: 0, usage: usage.stat }).catch(() => undefined);
      return;
    }

    // —— Model resolution + tool-calling probe (before the browser starts: a bad channel fails immediately, no burning the turn budget) ——
    const { model, channelName } = await resolveExplorationModel();
    await heartbeat(sessionId);
    const toolProbe = await toolCallingProbeFailure(model);
    if (toolProbe) throw new Error(toolProbe);
    if (await heartbeat(sessionId)) {
      await finishSession(sessionId, { status: 'cancelled', turnsUsed: 0, usage: usage.stat }).catch(() => undefined);
      return;
    }

    // —— C2 charter decomposition (one LLM call before the run → 2~12 sub-goals; soft failure = no sub-goals, exploration runs as usual) ——
    //  Sub-goals go into the system prompt (compression-safe) and land in coverage_ledger.goals (final-state snapshot for human coverage assessment).
    //  Placed after the probes: if a probe fails the session fails outright, so there is no point burning another decomposition call.
    const persona = getExplorationPersona(sessionRow.persona);
    const goals = await decomposeCharter({ charter: sessionRow.charter, persona: persona.directive });
    if (await heartbeat(sessionId)) {
      await finishSession(sessionId, { status: 'cancelled', turnsUsed: 0, usage: usage.stat }).catch(() => undefined);
      return;
    }
    // The exploration wall clock starts after scope parsing + probes + charter decomposition — the whole budget goes to the agent phase.
    // The wall clock is materialized from turns (no longer a fixed 15 minutes): turns are the only depth knob; the wall clock is its materialization + backstop.
    const deadline = Date.now() + explorationWallClockMs(maxTurns);

    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
    try {
      const loginKey = cred ? loginStateKey(envCtx.envId, cred.user) : null;
      const cachedState = loginKey ? getLoginState(loginKey) : null;
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        // Two-state viewport, same as legacy: a width/height pair given at session creation = custom; default 1280×800.
        viewport:
          sessionRow.windowWidth && sessionRow.windowHeight
            ? { width: sessionRow.windowWidth, height: sessionRow.windowHeight }
            : { width: 1280, height: 800 },
        ...(cachedState ? { storageState: cachedState } : {}),
      });
      const page = await context.newPage();

      // —— Vision probe (render the unique code in-browser and read it back): failure does not capsize the session; degrade to plain-text mode ——
      //    Must run before registerLiveView: live view starts a CDP screencast mirror on the same page;
      //    proven on prod228: with the mirror active the probe screenshot timed out at 5s → the session was wrongly degraded to plain-text mode.
      const visionProbe = await visionProbeFailure(page, model);
      const vision = visionProbe === null;
      if (visionProbe) {
        logger.warn({ sessionId, channelName, reason: visionProbe }, 'exploration vision probe failed; text-only mode');
      }

      live = registerLiveView(`exploration:${sessionId}`);
      live.setPage(page);

      // —— D2 fault-injection controller: the controller is always created (the wrap-up finally must be able to reset it),
      //    but the tools are **assembled only when the session carries an explicit authorization flag** (unauthorized = the tools do not exist). ——
      fault = createFaultController(context, page);

      // —— C1 coverage ledger + D3 error signal collection (observe feedback + final-state persistence) ——
      const coverage = createCoverageTracker();
      coverage.setGoals(goals);
      coverageLedger = coverage;
      const collector = createErrorSignalCollector(page);
      errorSignals = collector;

      // —— A1 evidence frame: finding persistence (decision-frame screenshot + trail fragment since the last finding) ——
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

      // Credential placeholder substituter (used by fill); a substitution failure (EnvMissing/SecretMissing) = fatal error → onFatal.
      const valueSub = cred ? makeCredentialValueSub(buildCredentialSource({ envCtx })) : undefined;

      // DB forensics channel (only when the environment has a db object configured; the SqlProbeEnv structural subset is satisfied by envCtx directly).
      const dbRefs = envCtx.dbs.map((d) => ({ label: d.label, dialect: d.dialect }));
      // Repo-reading channel (mounted only with a code commit scope; the diff op needs a from→to baseline).
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
          // The model-reported sub-goal completion → ledger (the final-state snapshot is persisted along with it).
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

      // Cancel/budget check: the heartbeat also reads the cancel flag (same single-SQL semantics as legacy); a hit aborts.
      // Turn counting only counts assistant message_end (= one LLM round, consistent with legacy shouldAbort) —
      // tool_execution_end only drives the heartbeat (one pi round can chain multiple tools; counting per tool would bloat turnsUsed).
      // Serial chain execution: when multiple events arrive in the same tick, heartbeats do not run concurrently and counts do not duplicate.
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
              // Live progress: the detail page polls every 2s — without this write the charter card shows 0 until the session ends.
              void persistTurnProgress(sessionId, turnCount).catch(() => undefined);
              if (turnCount >= maxTurns || Date.now() > deadline) {
                budgetExceeded = true;
                piSession.abort();
              }
            }
          })
          .catch(() => {});
      };

      piSession.subscribe((ev) => {
        // Any event counts as "the session is alive" — during streaming, message_update arrives per chunk,
        // so the idle watchdog will not misjudge a hang while the model is thinking/outputting normally.
        lastEventAt = Date.now();
        if (ev.type === 'tool_execution_start') {
          const step = trailStepOf(ev.toolName, ev.args);
          if (step) pendingTrail.set(ev.toolCallId, step);
        } else if (ev.type === 'tool_execution_end') {
          const step = pendingTrail.get(ev.toolCallId);
          pendingTrail.delete(ev.toolCallId);
          if (step) {
            step.ok = !ev.isError;
            // Result summary (produced at the tool layer): what this step "saw / changed into / why it failed" —
            // without it, steps like observe/screenshot/in-page scripts in the "session process" show only target="-" and users see no value.
            step.outcome = readToolSummary(ev.result) ?? (ev.isError ? fallbackFailureReason(ev.result) : undefined);
            // The verbatim result of sql/repo forensics goes into the trail detail (used by trailToSteps' expected).
            // Only the part after the first line is taken: the first line is a header like "sql_probe（库）：N 行", already covered by outcome.
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

      // —— Idle watchdog: after the wall clock grew to 240 minutes, it must be the one catching "model call hung" ——
      //  No pi event for this long (EXPLORATION_IDLE_TIMEOUT_MS) = this round is never coming back.
      //  A hit aborts: the trail is fully preserved, and the final state notes a hang-abort rather than a completed run.
      idleTimer = setInterval(() => {
        if (userCancelled || budgetExceeded || idleTimedOut) return;
        if (Date.now() - lastEventAt > idleTimeoutMs) {
          idleTimedOut = true;
          logger.warn({ sessionId, idleMs: Date.now() - lastEventAt }, 'exploration idle timeout; aborting session');
          piSession.abort();
        }
      }, idleCheckMs);

      // Kickoff instruction + wall-clock hard gate: the event-driven maybeAbort covers normal rotation; this catches the
      // "LLM call hung with no events" path — aborting at the deadline lets the prompt settle, and wrap-up semantics run as usual (trail fully preserved).
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
      // The cancel/budget check is an event-driven async chain (while a heartbeat SQL on the chain is in flight, the prompt may already have resolved) —
      // wait for the last tick to settle before reading the flags at wrap-up, otherwise the final-state classification
      // (cancelled / completed+budget annotation) and turns_used would miss the last round's verdict.
      await abortCheckChain;
      // Fatal errors like missing fill credentials → wrap up as failure (retrying would only burn turns; actionable guidance is in the message).
      if (fatalErr) throw fatalErr;

      // Persist the trail before setting the final state (the detail page stops polling the moment it sees the final state; in the reverse order the tail segment would never be fetched).
      await flushTrailPersist();
      // Warm login-state give-back (fire-and-forget; failure does not affect the final state; same semantics as legacy)
      if (loginKey) void context.storageState().then((s) => saveLoginState(loginKey, s)).catch(() => {});
      await finishSession(sessionId, {
        status: userCancelled ? 'cancelled' : 'completed',
        summary: terminalSummary(),
        turnsUsed: turnCount,
        usage: usage.stat,
      }).catch(() => undefined);
      // A3 independent review (fire-and-forget: review never changes the final state; its failure does not affect the session).
      void judgeExplorationSession(sessionId).catch(() => undefined);
    } finally {
      // D2 faults must be restored — leave no pollution in the SUT (reset before closing the browser).
      await fault?.reset();
      live?.close();
      await browser.close().catch(() => {});
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn({ err: e, sessionId, userCancelled, budgetExceeded, idleTimedOut }, 'exploration pi session failed');
    await flushTrailPersist();
    await finishSession(sessionId, {
      // A session whose finish submitted a summary still lands a completed final state even if the wrap-up chain throws (the model clearly said it was done).
      // A hang-abort follows the budget-exhausted rule: not a failure, but a platform-initiated stop (the reason goes in the summary).
      status: finishSummary ? 'completed' : userCancelled ? 'cancelled' : budgetExceeded || idleTimedOut ? 'completed' : 'failed',
      error: finishSummary || userCancelled || budgetExceeded || idleTimedOut ? null : msg,
      summary: terminalSummary(),
      turnsUsed: turnCount,
      usage: usage.stat,
    }).catch(() => undefined);
    void judgeExplorationSession(sessionId).catch(() => undefined);
  } finally {
    // Backstop persistence: both the normal and failure paths already flushed before setting the final state; this only guards against an accidental missed write.
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    await flushTrailPersist();
    errorSignals?.close();
    if (envCtx) await envCtx.close().catch(() => {});
  }
}
