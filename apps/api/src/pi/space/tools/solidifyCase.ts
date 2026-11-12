/**
 * solidify_case tool: solidifies visual-mode (aiTask / pure instruction) steps into mechanical compiled DSL, rewriting the source case in place.
 * The convergence path for dual-mode cases: during incremental-requirement periods steps run live as natural language by the AI (visual mode);
 * once the functionality stabilizes they solidify into mechanically replayable compiled. Orchestration shares the verify_case AI skeleton
 * (login placeholder self-heal / sensitive decryption / watchdog); the only difference is that runAiTask hooks an onAction collector:
 * the click/fill/navigate the AI actually executed map mechanically to DSL actions, the mapping is staged via stage_case_op update_step
 * (draft cases get the whole case re-staged), and only after verify_case acceptance (including a compiled mechanical dry run) does it persist.
 * Side effects match real execution (it genuinely re-runs the case).
 *
 * Safety: login/sensitive fill go through the placeholder protocol in the AI phase (valueSub substitutes at execution time); onAction receives
 * the pre-substitution original action params — when a placeholder literal shows up in the collected values, that step is not mechanically
 * solidified (credentials belong to the environment, not the case), but it does solidify into an aiTask execution step carrying a credential
 * placeholder hint: the replay aiTask branch goes through valueSub/preflight substitution and gating, the literal itself carries no real
 * credentials, and aiTaskCache never caches credential fills (cdp writes the cache only on successful mapping).
 */
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import type { StepAction } from '@itest/shared';
import { createConsoleCapture } from '../../../execute/consoleCapture.js';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { asc, eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { testCases, testSteps, aiStageCaseOps, aiStageCases } from '../../../db/schema.js';
import { runAiTask, makeCredentialValueSub, type AiAction } from '../../../execute/aiTask.js';
import { buildCredentialSource, renderWebResourceManifest } from '../../../execute/credentialSource.js';
import { mapAiActionsToCompiled, isVisualStep } from '../../../execute/aiActionMap.js';
import { hashEffectiveSteps, hashVerifyMeta, traceKey, takeFreshTrace } from './verifyTrace.js';
import { writeStepScreenshot } from '../../../execute/cdp.js';
import { resolveEnv } from '../../../execute/envContext.js';
import { resolveCaseUrl } from '../../../lib/resolve-url.js';
import { decrypt } from '../../../lib/secret-crypto.js';
import { resolveLlmClient } from '../../../agent/llmSettings.js';
import { tryParseJson } from '../../../agent/llm-client.js';
import { extractPageElements, extractPageEvidence } from '../../inspectPage.js';
import { probeLocatorHits, diagnoseFailure } from './failureDiagnosis.js';
import { computeCaseOverlay, overlayInsertLocalId, stageCaseOp, type EffectiveStep } from './case-ops-tools.js';
import { stageCase } from './stage-tools.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { getLoginState, loginStateKey, saveLoginState } from './loginStateCache.js';
import { registerLiveView } from '../../../execute/liveView.js';
import { buildStepInstruction, collectStepLocators, USER_PH, PASSWORD_PH, SECRET_PH } from './verifyCase.js';
import { abortGuard, type ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { st, type StLang } from '../../../i18n.js';
import { aiLangFrom } from '../../../agent/langDirective.js';

/** Only a UUID-shaped caseId may query testCases.id directly (uuid column); otherwise it can only be a draft localId — skip the DB query
 *  (same defense as verify_case: querying a uuid column with a non-UUID throws invalid input syntax for type uuid). */
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the step is already the stable product of "AI-execution-step solidification" (compiled=[aiTask] and its instruction unmodified).
 *  Key to idempotency: this class of step's solidify output is a deterministic function of its instruction — re-solidifying would only overwrite identically;
 *  but unguarded, every round would still really run the AI and re-map it — any trace change (e.g. being overwritten by a second full run's cache) makes the product drift.
 *  Already-solidified steps skip remapping outright; a user-edited instruction (≠ the stored aiTask.instruction) counts as a re-solidify request. */
function isAiTaskSolidified(s: EffectiveStep): boolean {
  const c = Array.isArray(s.compiled) ? s.compiled : [];
  if (c.length !== 1) return false;
  const a = c[0] as { kind?: unknown; instruction?: unknown };
  if (a?.kind !== 'aiTask' || typeof a.instruction !== 'string') return false;
  const inst = typeof s.instruction === 'string' ? s.instruction.trim() : '';
  return inst.length > 0 && a.instruction === inst;
}

// Stretching budget, same as verify_case: AI live per-step execution is the slow path (prod228 measured 85~107s/step);
// a fixed 300s only fits 2~3-step cases — multi-step cases would always time out (measured in the batch-solidify report).
// Budget = max(floor 300s, steps × 130s/step); the formula matches verify_case's computeVerifyTimeoutMs.
const SOLIDIFY_TIMEOUT_BASE_MS = 300_000;
const SOLIDIFY_TIME_PER_STEP_MS = 130_000;
const STEP_MAX_TURNS = 5;

/** Global watchdog budget = max(base 300s, steps × 130s per step). */
export function computeSolidifyTimeoutMs(stepCount: number): number {
  return Math.max(SOLIDIFY_TIMEOUT_BASE_MS, stepCount * SOLIDIFY_TIME_PER_STEP_MS);
}

// The mapping implementation sank to execute/aiActionMap.ts (shared with the aiTask runtime cache); the re-export surface here is unchanged (tests import this module directly).
// isVisualStep sank the same way (shared with verify_case trace collection); the re-export surface is unchanged.
export { mapAiActionsToCompiled, isVisualStep, type SolidifyMapResult } from '../../../execute/aiActionMap.js';

/**
 * Mapping + staging: maps the collected AI action trail per visual step into compiled and stages it (DB cases get per-step
 * update_step overwrites keyed by deterministic localId, idempotent; draft cases get the whole case re-staged). Shared by both the
 * real-run collection path and the trace-cache path.
 * Steps whose mapping failed (credential placeholder / press / unmappable selector / pure observational action) but that have an
 * instruction solidify into explicit aiTask execution steps — leaving null would deadlock mechanical acceptance and formal replay
 * at that step with compile-missing (measured on prod228).
 */
/** Redundant-navigation detection for the first step (advisory only, never deletes): when case.url is a deep link (non-root path,
 *  non-login page) that lands on the target page directly, a first step saying 「进入 XX 菜单」 is redundant navigation — the init
 *  goto already landed on the target page, so the menu click/navigate in replay is a repeated action and may even carry the page
 *  away from the deep-link landing page. 2026-10-28 prod228 record: the case url went straight to an asset-detail page yet the
 *  first step still said 「进入资产管理菜单」. Wording varies endlessly; only menu-semantic words are recognized. */
const NAV_STEP_RE = /进入|导航|跳转|打开.{0,10}菜单|点击.{0,10}菜单/;

export function isDeepLinkUrl(raw: string): boolean {
  try {
    const path = new URL(raw).pathname.replace(/\/+$/, '');
    return path.length > 0 && path !== '/login';
  } catch {
    return false;
  }
}

async function mapAndStageSteps(
  ctx: SpaceToolsContext,
  effectiveSteps: EffectiveStep[],
  collected: Map<string, AiAction[]>,
  opts: {
    dbCase: typeof testCases.$inferSelect | null | undefined;
    stagedCase: typeof aiStageCases.$inferSelect | null;
    lang: StLang;
    /** The case's effective url (after staging overlay): used for first-step redundant-navigation detection. */
    caseUrl?: string | null;
    /** This thread's staged ops for the case (with localId): overlay-state steps write their compiled back to the matching insert row. */
    stagedOps?: Array<{ localId: string; op: string; payload: unknown }>;
  },
): Promise<{ stepReports: Array<Record<string, unknown>>; solidifiedCount: number; keptCount: number }> {
  const { stagedCase, lang } = opts;
  const dbCase = opts.dbCase ?? null;
  const caseId = dbCase ? dbCase.id : stagedCase!.localId;
  const stepReports: Array<Record<string, unknown>> = [];
  let solidifiedCount = 0;
  let keptCount = 0;
  // First-step redundant-navigation note (advisory): only when deep-link direct + the first step is a 「进入菜单」-style navigation.
  const navNote = (() => {
    const url = typeof opts.caseUrl === 'string' ? opts.caseUrl : '';
    const first = effectiveSteps[0];
    const inst = typeof first?.instruction === 'string' ? first.instruction : '';
    if (!url || !isDeepLinkUrl(url) || !NAV_STEP_RE.test(inst)) return null;
    return `case.url（${url}）已直达目标页，首步「进入菜单」类导航在回放时冗余（init goto 已落地目标页）——建议删除该导航步，或把 case.url 改为系统首页由步骤自行导航`;
  })();
  const draftSteps = stagedCase
    ? (stagedCase.steps as Array<{ action?: unknown; assertion?: unknown; compiled?: unknown }>)
    : null;
  for (const s of effectiveSteps) {
    const base = { order: s.order, instruction: s.instruction };
    const navWarn: string | null = navNote && s.order === effectiveSteps[0]!.order ? navNote : null;
    if (!isVisualStep(s)) {
      stepReports.push({ ...base, status: 'skipped-compiled', reason: s.sensitive ? '敏感步骤（凭据不进 compiled）' : '已编译步骤不动', ...(navWarn ? { warning: navWarn } : {}) });
      continue;
    }
    if (isAiTaskSolidified(s)) {
      stepReports.push({ ...base, status: 'unchanged-aiTask', reason: '已是 AI 执行步固化且指令未变，保持原样（幂等）' });
      continue;
    }
    if (s.sensitive) {
      stepReports.push({ ...base, status: 'skipped-sensitive', reason: '敏感步骤保持原样（凭据走加密协议）' });
      continue;
    }
    const mapped = mapAiActionsToCompiled(collected.get(s.id) ?? []);
    const inst = typeof s.instruction === 'string' ? s.instruction.trim() : '';
    if (!mapped.ok && !inst) {
      // A step without even an instruction cannot solidify into an aiTask (no execution semantics); it can only stay null
      keptCount += 1;
      stepReports.push({ ...base, status: 'kept-aiTask', reason: mapped.reason });
      continue;
    }
    // Mapping failed but an instruction exists: solidify into an explicit AI execution step (the platform convention is that AI execution
    // steps must be explicit aiTask — leaving null would deadlock mechanical acceptance/formal replay at that step with compile-missing).
    // The mechanical-replay aiTask branch genuinely executes the step (including credential self-service login); the mapping reason is
    // attached in reason for human review.
    const fallback = !mapped.ok;
    const credentialBlock = fallback && /凭据占位符/.test(mapped.reason);
    // For credential-refused steps the instruction teaches the replay AI self-service login: bare placeholders aren't in {{}} form so
    // substituteVars doesn't touch them; valueSub/credentialPreflight substitute/gate at fill time (fail-fast when the environment has no credentials).
    const aiInstruction = credentialBlock
      ? `${inst}（若页面已处于登录后状态则直接完成；用户名输入框填 ${USER_PH}、密码填 ${PASSWORD_PH}，平台在填入瞬间替换为环境真实凭据）`.slice(0, 2000)
      : inst;
    const finalCompiled: StepAction[] = fallback
      ? [{ kind: 'aiTask', instruction: aiInstruction }]
      : mapped.compiled;
    solidifiedCount += 1;
    const mapWarn = mapped.ok && mapped.skippedCount > 0 ? `跳过 ${mapped.skippedCount} 个观察性截图动作` : null;
    const warning = [mapWarn, navWarn].filter(Boolean).join('；') || undefined;
    stepReports.push(
      fallback
        ? { ...base, status: 'aiTask-fallback', compiled: finalCompiled, reason: `${mapped.reason}——已固化为 AI 执行步（aiTask），机械验收时由 AI 真实执行`, ...(warning ? { warning } : {}) }
        : {
            ...base,
            status: 'solidified',
            compiled: mapped.compiled,
            ...(warning ? { warning } : {}),
          },
    );
    // Staging write: DB cases get per-step update_step (deterministic localId; re-solidify overwrites idempotently); drafts get the whole case re-staged.
    //
    // Overlay-state steps (id shaped like staged:<insertLocalId>, i.e. "inserted in staging, not yet persisted"):
    // the mechanical compiled is written back to that one insert staging row, not staged as update_step — the synthetic stepId
    // is not a uuid, so the uuid validation at persist time would reject the whole op and the user would only see
    // 「参数校验失败，请检查输入」 when clicking save (measured on prod228 2026-11-11).
    if (dbCase) {
      const insertLocalId = overlayInsertLocalId(s.id);
      if (insertLocalId) {
        const pending = opts.stagedOps?.find((o) => o.localId === insertLocalId);
        if (!pending || pending.op !== 'insert_step') {
          // No matching insert staging row found (shouldn't happen) → produce no invalid op; call it out in the report.
          stepReports.push({ ...base, status: 'skipped-overlay', reason: '叠加态步骤找不到对应的暂存插入行，未暂存修改' });
          continue;
        }
        const prevCompiled = (pending.payload as { compiled?: unknown }).compiled ?? null;
        const doc = {
          localId: insertLocalId,
          caseId,
          op: 'insert_step',
          payload: { ...(pending.payload as object), compiled: finalCompiled },
          summary: st(lang, 'step.solidified', { order: s.order, count: finalCompiled.length }),
          diff: diffText({ compiled: prevCompiled }, { compiled: finalCompiled }),
          stagedAt: new Date().toISOString(),
        };
        await stageCaseOp(ctx.threadId, ctx.versionId, doc);
        emitStage(ctx, { kind: 'case_op' as const, id: insertLocalId, action: 'stage', payload: doc });
      } else {
        const localId = `solidify-${s.id}`;
        const doc = {
          localId,
          caseId,
          op: 'update_step',
          payload: { action: 'update_step', caseId, stepId: s.id, compiled: finalCompiled },
          summary: st(lang, 'step.solidified', { order: s.order, count: finalCompiled.length }),
          diff: diffText({ compiled: s.compiled ?? null }, { compiled: finalCompiled }),
          stagedAt: new Date().toISOString(),
        };
        await stageCaseOp(ctx.threadId, ctx.versionId, doc);
        emitStage(ctx, { kind: 'case_op' as const, id: localId, action: 'stage', payload: doc });
      }
    } else if (draftSteps) {
      const idx = Number(/^staged-(\d+)$/.exec(s.id)?.[1] ?? 0) - 1;
      if (idx >= 0 && idx < draftSteps.length) {
        draftSteps[idx] = { ...draftSteps[idx]!, compiled: finalCompiled };
      }
    }
  }
  if (!dbCase && draftSteps) {
    const draftBody = {
      localId: stagedCase!.localId,
      title: stagedCase!.title,
      description: stagedCase!.description,
      priority: stagedCase!.priority,
      url: stagedCase!.url ?? null,
      steps: draftSteps,
      defaultEnvId: stagedCase!.defaultEnvId ?? null,
      expectedOutcome: stagedCase!.expectedOutcome ?? null,
      datasetLocalId: stagedCase!.datasetLocalId ?? null,
    };
    await stageCase(ctx.threadId, ctx.versionId, draftBody);
    emitStage(ctx, {
      kind: 'case' as const,
      id: stagedCase!.localId,
      action: 'stage',
      payload: { ...draftBody, stagedAt: new Date().toISOString() },
    });
  }
  return { stepReports, solidifiedCount, keptCount };
}

export function buildSolidifyCaseTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'solidify_case',
      description:
      '把用例中的视觉模式步骤（aiTask / 纯自然语言 instruction，运行时由 AI 看截图临场执行）固化（solidify）为可机械回放的 compiled DSL，就地改写源用例：收集 AI 实际执行的动作，机械映射为 click/fill/navigate 后经 stage_case_op 暂存到草稿区（暂存草稿用例则整例更新），用户在 StagePanel 勾选 → verify_case 验收（含机械干跑）→ 落库。**若此前 verify_case(mode="full") 实测通过且步骤/环境未变，本工具会复用那份实测轨迹零执行完成固化（秒级，无需浏览器与 LLM）**；轨迹过期或步骤已变才真实执行一遍用例。功能稳定后的收敛路径：先视觉模式快速跟进需求，稳定后固化沉淀为机械资产。副作用：走真实执行路径时会真实再执行一遍用例。无法机械映射的步骤（登录凭据填充 / press / 选择器不可映射 / 纯等待截图观察动作）固化为显式 AI 执行步（aiTask）并附原因，机械验收与正式回放时由 AI 真实执行——不再留 compiled=null 卡死回放（wait 与真实动作混合时映射为固定时长 waitFor 正常固化）。',
    parameters: Type.Object({
      caseId: Type.String({ minLength: 1 }),
    }),
    promptGuidelines: [
      '调用时机（前置条件）：用户确认自然语言草稿后（无论草稿是否已落库,固化可直接作用于暂存草稿）,你主动询问「是否需要固化为机械步骤」得到肯定答复，或用户明确要求把视觉步骤转为机械步骤时才调用。不要在 stage_case 刚落暂存就自动 solidify——草稿期保持自然语言更利于多轮讨论修改。',
      'solidify_case 优先复用 verify_case 实测缓存的轨迹零执行完成固化（结果里 traceReused=true）：只要上一步实测通过、步骤内容与环境未变，就不需要再跑一遍用例。没有轨迹可复用时（如从未实测、轨迹超过 30 分钟、或步骤已改）才真实执行一遍收集 AI 临场动作，机械映射为 compiled 后暂存为 update_step 修改（草稿用例整例更新）。暂存后必须立即 verify_case(mode="mechanical") 验收（跳过 AI 相，只做机械干跑 + 终态判定）——机械干跑通过才算固化完成；verify 失败由你根据失败归因修复 compiled 后重跑 mechanical，同因连续两轮失败或归因不明则改 mode="full" 重测。通过后引导用户在暂存区勾选保存。固化前后**不要重复跑 full 实测**（每步 AI 相 1~2 分钟，重复跑纯浪费）。',
      'solidify_case 结果里 status=aiTask-fallback 的步骤是「无法机械映射但已固化为 AI 执行步（aiTask）」（原因见 reason：登录凭据占位 / press 无机械对应 / 选择器不可映射 / 纯等待截图观察动作）：机械验收与正式回放时这些步由 AI 真实执行（凭据步的 instruction 已带自助登录提示），不要强行改写；确需机械化的（如选择器含 Playwright 专有语法）可先用 stage_case_op 换成平台可表达的选择器后重新固化。status=kept-aiTask（连 instruction 都没有）才保持视觉模式。wait 与真实动作混合时映射为固定时长 waitFor 一并固化，纯等待步不再产出盲等 waitFor（视为观察动作走 aiTask 化）。',
      '同一用例反复固化是安全幂等的：暂存 localId 按 stepId 确定（solidify-<stepId>），重复固化覆盖上一轮暂存；已固化为 aiTask 执行步且指令未变的步骤直接保持原样（steps[].status=unchanged-aiTask），不重跑不重映射；执行失败（任一步骤未过）时不会暂存任何修改，修正后重跑即可。',
      '被固化的 fill value 是 AI 当轮填入的原始值：若 instruction 引用了 {{变量}} 而 AI 填了具体值，固化会把该值冻结进 compiled——数据驱动用例（绑定数据集）不建议固化含变量填写的步骤，或固化后把 value 手工改回 {{变量}}。',
    ],
    execute: async (input, signal) => {
      const lang: StLang = aiLangFrom(ctx.lang);
      const { caseId } = input as { caseId: string };
      // Stop checkpoint: if the session already stopped, short-circuit directly — no browser launch, no LLM spend.
      if (signal?.aborted) return { ok: false, error: '已停止：用户中断了本次固化' };
      try {
        // ── Preflight validation (no browser launch): caseId dual shape, same as verify_case ──
        // Non-UUID-shaped localIds skip the uuid-column query and go straight to drafts (same as verify_case)
        const dbCase = UUID_SHAPE_RE.test(caseId)
          ? (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0]
          : undefined;
        let stagedCase: typeof aiStageCases.$inferSelect | null = null;
        if (!dbCase) {
          stagedCase =
            (await db.select().from(aiStageCases)
              .where(and(eq(aiStageCases.threadId, ctx.threadId), eq(aiStageCases.localId, caseId))))[0] ?? null;
          if (!stagedCase) {
            return { ok: false, error: `用例不存在: ${caseId}（既非落库用例，也非本线程暂存草稿）` };
          }
        }
        if (dbCase?.platform === 'mobile') {
          return { ok: false, error: 'solidify_case 暂不支持移动端用例（v1 仅支持 web）' };
        }
        const caseMeta = dbCase
          ? {
              title: dbCase.title,
              url: dbCase.url,
              expectedOutcome: dbCase.expectedOutcome,
              defaultEnvId: dbCase.defaultEnvId,
              versionId: dbCase.versionId,
              // The case-bound web service name: credential ownership for non-@ref placeholders (same yardstick as the execution layer / verify_case).
              webServiceRef: dbCase.webServiceRef ?? null,
            }
          : {
              title: stagedCase!.title,
              url: stagedCase!.url ?? null,
              expectedOutcome: stagedCase!.expectedOutcome ?? null,
              defaultEnvId: stagedCase!.defaultEnvId ?? null,
              versionId: stagedCase!.versionId,
              // The staging table has no web_service_ref column; drafts always take the default chain.
              webServiceRef: null,
            };
        const steps: EffectiveStep[] = dbCase
          ? await db.select().from(testSteps).where(eq(testSteps.caseId, caseId)).orderBy(asc(testSteps.order))
          : (stagedCase!.steps as Array<{ action?: unknown; assertion?: unknown; compiled?: unknown }>).map((s, i) => ({
              id: `staged-${i + 1}`,
              order: i + 1,
              instruction: typeof s.action === 'string' ? s.action : null,
              compiled: Array.isArray(s.compiled) ? s.compiled : null,
              assertion: typeof s.assertion === 'string' ? s.assertion : null,
              sensitive: false,
              delayMs: null,
              secretCiphertext: null,
              secretIv: null,
              secretTag: null,
            }));
        if (steps.length === 0) return { ok: false, error: '用例没有可执行的步骤' };

        // Staging overlay (same as verify_case: continue from the staged state)
        let effectiveSteps = steps;
        const overlayPatches: { url?: string | null; defaultEnvId?: string | null } = {};
        let opsApplied = 0;
        // The staged-op listing carries localId: an overlay-state step's synthetic id is staged:<the insert op's localId>,
        // and solidify must write the mechanical compiled back to that one insert staging row — without localId the target row can't be located.
        let stagedOps: Array<{ localId: string; op: string; payload: unknown }> = [];
        if (dbCase) {
          stagedOps = await db
            .select({ localId: aiStageCaseOps.localId, op: aiStageCaseOps.op, payload: aiStageCaseOps.payload })
            .from(aiStageCaseOps)
            .where(and(eq(aiStageCaseOps.threadId, ctx.threadId), eq(aiStageCaseOps.caseId, caseId)))
            .orderBy(asc(aiStageCaseOps.stagedAt));
          const overlay = computeCaseOverlay(steps, stagedOps);
          if (overlay.deleteStaged) {
            return { ok: false, error: '用例已暂存删除，请先在暂存区取消删除（或落库）后再固化' };
          }
          if (overlay.steps) effectiveSteps = overlay.steps;
          if (overlay.url !== undefined) overlayPatches.url = overlay.url;
          if (overlay.defaultEnvId !== undefined) overlayPatches.defaultEnvId = overlay.defaultEnvId;
          opsApplied = overlay.opsApplied;
        }
        if (effectiveSteps.length === 0) return { ok: false, error: '用例没有可执行的步骤' };

        // Solidifiable candidates = visual mode, non-sensitive, and not already an AI-execution-step solidification (isAiTaskSolidified
        // already-solidified steps stay as they are → re-solidify is idempotent, see P1-1). With zero candidates, return early; no browser launch.
        const visualSteps = effectiveSteps.filter((s) => isVisualStep(s) && !isAiTaskSolidified(s));
        if (visualSteps.length === 0) {
          return { ok: false, error: '用例没有待固化的视觉模式步骤（全部已编译、已是 AI 执行步固化或为敏感步骤），无需固化——重复调用是幂等的。若要重新固化某步，先用 stage_case_op update_step 把该步 compiled 置 null（或改它的 instruction）。' };
        }
        const effectiveCase = { ...caseMeta, ...overlayPatches };

        // ── Trace cache hit: verify_case's measured full pass with steps/environment unchanged → zero-execution second-level solidify ──
        // No browser launch, no LLM/environment resolution needed (all hash inputs come from effectiveCase/effectiveSteps);
        // a stale hit deletes the entry and falls back to a real run (solidify's own solidify-* ops change the overlay → hash changes → naturally invalidated).
        const cachedTrace = takeFreshTrace(
          traceKey(ctx.threadId, caseId),
          hashEffectiveSteps(effectiveSteps),
          hashVerifyMeta({ url: effectiveCase.url, defaultEnvId: effectiveCase.defaultEnvId, versionId: effectiveCase.versionId }),
          effectiveSteps.filter((s) => isVisualStep(s) && !s.sensitive && !isAiTaskSolidified(s)).map((s) => s.id),
        );
        if (cachedTrace) {
          ctx.emit({
            type: 'solidify_progress', phase: 'start', caseId, total: effectiveSteps.length,
            solidifiable: visualSteps.length, targetUrl: effectiveCase.url ?? null, traceReused: true,
          });
          const { stepReports, solidifiedCount, keptCount } = await mapAndStageSteps(
            ctx, effectiveSteps, cachedTrace, { dbCase, stagedCase, lang, caseUrl: effectiveCase.url, stagedOps },
          );
          const result = solidifiedCount > 0 ? 'solidified' : 'nothing-solidified';
          ctx.emit({ type: 'solidify_progress', phase: 'end', result, solidified: solidifiedCount, kept: keptCount });
          return {
            ok: true,
            data: JSON.stringify({
              result,
              caseId,
              envId: null,
              targetUrl: effectiveCase.url ?? null,
              basedOn: stagedCase || opsApplied > 0 ? ('staged' as const) : ('db' as const),
              stagedOpsApplied: opsApplied,
              traceReused: true,
              steps: stepReports,
              note: `复用 verify_case 实测轨迹零执行完成固化（步骤与环境未变，轨迹缓存 30 分钟内有效）：已暂存 ${solidifiedCount} 个步骤的固化修改（status=aiTask-fallback 的步是 AI 执行步固化，机械验收时由 AI 真实执行）${keptCount > 0 ? `，${keptCount} 个步骤保持视觉模式（见各步 reason）` : ''}。下一步调用 verify_case(mode='mechanical') 做机械验收：跳过 AI 相，仅机械干跑 + 终态判定。`,
            }),
          };
        }

        // ── LLM preflight check ──
        let client: Awaited<ReturnType<typeof resolveLlmClient>>['client'];
        try {
          client = (await resolveLlmClient()).client;
        } catch (e) {
          return { ok: false, error: `LLM 未配置，无法执行 AI 固化: ${(e as Error).message}` };
        }

        // ── Environment resolution ──
        let envCtx: Awaited<ReturnType<typeof resolveEnv>>;
        try {
          envCtx = await resolveEnv(
            { caseEnvId: effectiveCase.defaultEnvId ?? null, versionId: effectiveCase.versionId ?? ctx.versionId },
            { expectedProjectId: ctx.projectId },
          );
        } catch (e) {
          const errName = e instanceof Error ? e.name : '';
          if (errName === 'EnvMissing') return { ok: false, error: '缺少环境配置，请到项目环境页配置默认环境' };
          if (errName === 'EnvProjectMismatch') return { ok: false, error: '环境所属项目与当前用例不匹配' };
          return { ok: false, error: `环境解析失败: ${(e as Error).message}` };
        }
        // Web-service listing for prompts (name/origin/credential-presence only, never real values); computed once after environment resolution, reused per step.
        const webManifest = (() => {
          try { return renderWebResourceManifest({ envCtx }); } catch { return ''; }
        })();

        // ── Browser + watchdog → per-step AI-driven execution (same skeleton as verify_case's AI phase) + onAction collection ──
        let browser: Browser | undefined;
        let live: ReturnType<typeof registerLiveView> | undefined;
        let timedOut = false;
        const solidifyTimeoutMs = computeSolidifyTimeoutMs(effectiveSteps.length);
        const timer = setTimeout(() => {
          timedOut = true;
          if (browser) void browser.close().catch(() => undefined);
        }, solidifyTimeoutMs);
        // Stop guard: a user stop preempts the in-flight AI; the finally block closes the browser so residual work terminates with it.
        const stopGuard = abortGuard(signal, '已停止：用户中断了本次固化');
        try {
          const resolvedUrl = await resolveCaseUrl(
            {
              url: effectiveCase.url,
              // Drafts have no DB row: groupId goes unused when passing envCtx (only defaultEnvFallback's displayWebEnv needs it), so pass an empty string;
              // a draft's webServiceRef can't bind a named service → null takes the default web service.
              groupId: stagedCase ? '' : dbCase!.groupId,
              webServiceRef: stagedCase ? null : (dbCase!.webServiceRef ?? null),
            },
            { envCtx },
          );
          const targetUrl = resolvedUrl && /^https?:\/\//.test(resolvedUrl) ? resolvedUrl : undefined;
          // Stop checkpoint: probe once more before launching the browser (the user may have hit stop during preflight/environment resolution).
          if (signal?.aborted) return { ok: false, error: '已停止：用户中断了本次固化' };
          browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
          const loginKey = loginStateKey(envCtx.envId, envCtx.login?.user);
          const cachedState = getLoginState(loginKey);
          const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width: 1280, height: 800 },
            ...(cachedState ? { storageState: cachedState } : {}),
          });
          const page = await context.newPage();
          // Browser console error / pageerror capture: this path doesn't go through runStepsInContext (the AI phase manages the page itself),
          // so subscribe once here and drain into the attribution evidence on failure.
          const consoleCapture = createConsoleCapture(page);
          // Playground live view: same pattern as verify_case (register the page source → the start event carries the stream url → finally close).
          // ctx.liveView === false means a batch background path: no page source is registered, saving the 0.5fps screenshot polling cost.
          if (ctx.liveView !== false) {
            live = registerLiveView();
            live.setPage(page);
          }
          if (targetUrl) {
            const firstCompiled = effectiveSteps[0]?.compiled;
            const firstAction = (Array.isArray(firstCompiled) && firstCompiled.length > 0
              ? firstCompiled[0]
              : undefined) as { kind?: string; url?: string } | undefined;
            const skipInit = firstAction?.kind === 'navigate' && firstAction.url === targetUrl;
            if (!skipInit) {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
            }
          }

          // Placeholder → real value. Reuses the execution layer's single implementation (same yardstick as verify_case/mechanical replay).
          let stepSecret: string | undefined;
          // Reconstruct the source on every evaluation: stepSecret is decrypted per step before being assigned — snapshotting at construction would freeze sensitive values at undefined.
          const valueSub = (v: string): string =>
            makeCredentialValueSub(
              buildCredentialSource({ envCtx, caseWebServiceRef: effectiveCase.webServiceRef }, stepSecret),
            )(v);

          const reportId = `solidify-${randomUUID()}`;
          // stepId → the successful actions collected for that step (in execution order). The AI phase's original action params (placeholders unsubstituted).
          const collected = new Map<string, AiAction[]>();
          let failedIndex = -1;
          let failedError = '';
          let failedScreenshot: string | undefined;
          ctx.emit({
            type: 'solidify_progress', phase: 'start', caseId, total: effectiveSteps.length,
            solidifiable: visualSteps.length,
            targetUrl: targetUrl ?? null,
            loginCache: cachedState ? ('hit' as const) : ('miss' as const),
            liveUrl: live ? `/api/assistant/threads/${ctx.threadId}/live/${live.key}` : undefined,
          });
          for (let i = 0; i < effectiveSteps.length; i++) {
            const s = effectiveSteps[i]!;
            const solidifiable = isVisualStep(s) && !s.sensitive && !isAiTaskSolidified(s);
            // Stop checkpoint: probe at the start of each step; on hit, wrap up as cancelled (nothing gets staged).
            if (signal?.aborted) {
              ctx.emit({ type: 'solidify_progress', phase: 'end', result: 'cancelled' });
              return { ok: false, error: '已停止：用户中断了本次固化（未暂存任何修改）' };
            }

            stepSecret = undefined;
            if (s.sensitive) {
              if (!s.secretCiphertext || !s.secretIv || !s.secretTag) {
                failedIndex = i;
                failedError = 'sensitive 步骤缺少密文（secret-missing）';
                break;
              }
              try {
                stepSecret = decrypt({
                  ciphertext: Buffer.from(s.secretCiphertext, 'base64'),
                  iv: Buffer.from(s.secretIv, 'base64'),
                  tag: Buffer.from(s.secretTag, 'base64'),
                });
              } catch {
                failedIndex = i;
                failedError = '敏感字段解密失败（secret-decrypt）';
                break;
              }
            }

            if (s.delayMs) await page.waitForTimeout(s.delayMs);
            const instruction = buildStepInstruction(
              { order: s.order, instruction: s.instruction, compiled: s.compiled, assertion: s.assertion },
              effectiveSteps.length,
              { hasLogin: !!envCtx.login, hasSecret: stepSecret !== undefined },
              undefined,
              webManifest,
            );
            let stepActions: AiAction[] = [];
            let aiRun: Promise<string> | undefined;
            try {
              aiRun = runAiTask(page, instruction, client, false, {
                maxTurns: STEP_MAX_TURNS,
                valueSub,
                lang: ctx.lang,
                // Only collect actions from solidifiable steps; sensitive steps' credential actions stay out of the collection (placeholder protocol values carry no real credentials anyway, but semantically credentials don't belong to the case)
                onAction: (action, ok) => {
                  if (solidifiable && ok) stepActions.push(action);
                },
              });
              const summary = await Promise.race([aiRun, stopGuard]);
              const parsed = tryParseJson(summary);
              if (parsed && parsed.status === 'failed') {
                failedIndex = i;
                failedError = typeof parsed.reason === 'string' ? parsed.reason : summary.slice(0, 200);
                failedScreenshot = await writeStepScreenshot(reportId, i + 1, page);
                break;
              }
              if (solidifiable && stepActions.length > 0) collected.set(s.id, stepActions);
            } catch (e) {
              // User stopped: drop the in-flight aiRun (the finally block closes the browser, terminating it), stage nothing.
              if (signal?.aborted) {
                void aiRun?.catch(() => undefined);
                ctx.emit({ type: 'solidify_progress', phase: 'end', result: 'cancelled' });
                return { ok: false, error: '已停止：用户中断了本次固化（未暂存任何修改）' };
              }
              if (timedOut) return { ok: false, error: `固化超时（${solidifyTimeoutMs / 1000}s）已终止` };
              failedIndex = i;
              failedError = (e as Error).message.slice(0, 300);
              failedScreenshot = await writeStepScreenshot(reportId, i + 1, page);
              break;
            }
          }

          // Login-state writeback (same as verify_case: unconditionally store the current session; storing an anonymous session when not logged in also self-heals)
          const savedState = await context.storageState().catch(() => null);
          if (savedState) saveLoginState(loginKey, savedState);

          // Execution failed: stage nothing (atomic semantics); the failed page's element list lets the agent fix the instruction and re-run.
          if (failedIndex >= 0) {
            const failurePage = await extractPageElements(page).catch(() => null);
            const failedStep = effectiveSteps[failedIndex]!;
            // Failure attribution (same discriminator as verify_case): shape-agnostic probes (per-locator live hit counts) + overlay list + element list handed to the LLM for attribution.
            const probes = await probeLocatorHits(page, collectStepLocators(failedStep.compiled));
            const evidence = await extractPageEvidence(page).catch(() => ({ overlays: [] as Array<{ tag: string; selector: string; text: string }> }));
            const consoleEntries = consoleCapture.drain();
            const diag = failurePage
              ? await diagnoseFailure({ client, step: failedStep, assertion: failedStep.assertion, probes, overlays: evidence.overlays, elements: failurePage, lang: ctx.lang, ...(consoleEntries.length ? { consoleErrors: consoleEntries } : {}) })
              : null;
            const evidenceField =
              probes.length > 0 || evidence.overlays.length > 0
                ? { evidence: { overlays: evidence.overlays, probes } }
                : {};
            ctx.emit({ type: 'solidify_progress', phase: 'end', result: 'failed', reason: failedError.slice(0, 120) });
            return {
              ok: true,
              data: JSON.stringify({
                result: 'failed',
                caseId,
                envId: envCtx.envId,
                targetUrl: targetUrl ?? null,
                failure: {
                  stepOrder: failedStep.order,
                  instruction: failedStep.instruction,
                  error: failedError,
                  screenshot: failedScreenshot ?? null,
                  page: failurePage,
                  ...evidenceField,
                  note: `固化要求全部步骤 AI 执行通过（与 verify_case 同标准），失败步及后续步骤保持视觉模式，未暂存任何修改。可用 failure.page.elements 里的真实选择器修正该步（stage_case_op / 重发 stage_case）后重新固化。${diag ? ` ⚠ 归因:${diag.note}` : ''}`,
                },
              }),
            };
          }
          if (timedOut) return { ok: false, error: `固化超时（${solidifyTimeoutMs / 1000}s）已终止` };
          // Stop checkpoint: probe once more before mapping/staging — a stop means nothing gets staged.
          if (signal?.aborted) {
            ctx.emit({ type: 'solidify_progress', phase: 'end', result: 'cancelled' });
            return { ok: false, error: '已停止：用户中断了本次固化（未暂存任何修改）' };
          }

          // ── Mapping + staging: all steps executed successfully; map each visual step's collected actions into compiled ──
          const { stepReports, solidifiedCount, keptCount } = await mapAndStageSteps(
            ctx, effectiveSteps, collected, { dbCase, stagedCase, lang, caseUrl: effectiveCase.url, stagedOps },
          );

          const result = solidifiedCount > 0 ? 'solidified' : 'nothing-solidified';
          ctx.emit({
            type: 'solidify_progress', phase: 'end', result,
            solidified: solidifiedCount, kept: keptCount,
          });
          return {
            ok: true,
            data: JSON.stringify({
              result,
              caseId,
              envId: envCtx.envId,
              targetUrl: targetUrl ?? null,
              basedOn: stagedCase || opsApplied > 0 ? ('staged' as const) : ('db' as const),
              stagedOpsApplied: opsApplied,
              steps: stepReports,
              note: solidifiedCount > 0
                ? `已暂存 ${solidifiedCount} 个步骤的固化修改（草稿区可见；status=aiTask-fallback 的步是 AI 执行步固化，机械验收时由 AI 真实执行）${keptCount > 0 ? `，${keptCount} 个步骤保持视觉模式（见各步 reason）` : ''}。下一步必须调用 verify_case 验收：机械干跑通过后引导用户在右侧暂存区勾选保存，固化才算完成。注意:固化产出的 compiled 是 AI 当轮实际动作的单候选映射——verify_case 若报 AmbiguousLocator/LocatorMismatch,用 failure.page.elements 里该元素的真实选择器把对应步骤补成多候选链(属性候选如 [placeholder=...] 优先、纯 #id 其次,规则同 stage_case 的 locator 规范),不要依赖单候选碰运气。`
                : '没有步骤被固化（各步保持视觉模式，原因见 steps[].reason）。仅当步骤连 instruction 都没有时才会出现——属预期保守行为，无需修正。',
            }),
          };
        } finally {
          clearTimeout(timer);
          live?.close();
          if (browser) await browser.close().catch(() => undefined);
          await envCtx.close().catch(() => undefined);
        }
      } catch (e) {
        return { ok: false, error: `固化失败: ${(e as Error).message}` };
      }
    },
  };
}
