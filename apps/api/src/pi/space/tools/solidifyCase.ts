/**
 * solidify_case 工具：把视觉模式（aiTask / 纯 instruction）步骤固化为机械 compiled DSL，就地改写源用例。
 * 双模式用例的收敛路径：增量需求期步骤以自然语言由 AI 临场执行（视觉模式），功能稳定后固化成
 * 可机械回放的 compiled。编排与 verify_case 的 AI 相同骨架（登录占位符自愈 / 敏感解密 / watchdog），
 * 差异仅在 runAiTask 挂 onAction 收集器：AI 实际执行过的 click/fill/navigate 机械映射为 DSL 动作，
 * 映射结果经 stage_case_op update_step 暂存（草稿用例则整例重暂存），最终由 verify_case 验收
 * （含 compiled 机械干跑）后才落库。副作用与执行一致（会真实再跑一遍用例）。
 *
 * 安全：登录/敏感 fill 在 AI 相走占位符协议（valueSub 执行时刻替换），onAction 收到的是替换前的
 * 原始动作参数——占位符字面量出现在收集值里时该步不固化（凭据属于环境，不属于用例）。
 */
import { randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { asc, eq, and } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { testCases, testSteps, aiStageCaseOps, aiStageCases } from '../../../db/schema.js';
import { runAiTask, type AiAction } from '../../../execute/aiTask.js';
import { mapAiActionsToCompiled } from '../../../execute/aiActionMap.js';
import { writeStepScreenshot } from '../../../execute/cdp.js';
import { resolveEnv } from '../../../execute/envContext.js';
import { resolveCaseUrl } from '../../../lib/resolve-url.js';
import { decrypt } from '../../../lib/secret-crypto.js';
import { resolveLlmClient } from '../../../agent/llmSettings.js';
import { tryParseJson } from '../../../agent/llm-client.js';
import { extractPageElements, extractPageEvidence } from '../../inspectPage.js';
import { probeLocatorHits, diagnoseFailure } from './failureDiagnosis.js';
import { computeCaseOverlay, stageCaseOp, type EffectiveStep } from './case-ops-tools.js';
import { stageCase } from './stage-tools.js';
import { emitStage } from './stage.js';
import { diffText } from './diff.js';
import { getLoginState, loginStateKey, saveLoginState } from './loginStateCache.js';
import { registerLiveView } from '../../../execute/liveView.js';
import { buildStepInstruction, collectStepLocators, USER_PH, PASSWORD_PH, SECRET_PH } from './verifyCase.js';
import type { ToolExecutor } from '../../tools.js';
import type { SpaceToolsContext } from './context.js';
import { st, type StLang } from '../../../i18n.js';
import { aiLangFrom } from '../../../agent/langDirective.js';

// 与 verify_case 同量级：AI 逐步骤临场执行是慢路径。
const SOLIDIFY_TIMEOUT_MS = 300_000;
const STEP_MAX_TURNS = 5;

// 映射实现已下沉 execute/aiActionMap.ts（aiTask 运行时缓存共用），此处转出口径不变（测试直接 import 本模块）。
export { mapAiActionsToCompiled, type SolidifyMapResult } from '../../../execute/aiActionMap.js';

/** 步骤是否为视觉模式（可固化候选）：未编译（纯 instruction）或 compiled 全部由 aiTask 组成。 */
export function isVisualStep(step: { instruction: string | null; compiled: unknown; sensitive: boolean }): boolean {
  if (step.sensitive) return false; // 敏感步骤凭据不进 compiled，保持原样
  const compiled = Array.isArray(step.compiled) ? step.compiled : [];
  if (compiled.length === 0) {
    return typeof step.instruction === 'string' && step.instruction.trim().length > 0;
  }
  return compiled.every((a) => (a as { kind?: string }).kind === 'aiTask');
}

export function buildSolidifyCaseTool(ctx: SpaceToolsContext): ToolExecutor {
  return {
    name: 'solidify_case',
      description:
      '把用例中的视觉模式步骤（aiTask / 纯自然语言 instruction，运行时由 AI 看截图临场执行）固化（solidify）为可机械回放的 compiled DSL，就地改写源用例：真实执行一遍用例并收集 AI 实际执行的动作，机械映射为 click/fill/navigate 后经 stage_case_op 暂存到草稿区（暂存草稿用例则整例更新），用户在 StagePanel 勾选 → verify_case 验收（含机械干跑）→ 落库。功能稳定后的收敛路径：先视觉模式快速跟进需求，稳定后固化沉淀为机械资产。副作用：会真实再执行一遍用例。登录/敏感步骤不固化（归环境登录与敏感字段协议）；含 press/wait 等无 DSL 对应动作的步骤保持 aiTask 并附原因。',
    parameters: Type.Object({
      caseId: Type.String({ minLength: 1 }),
    }),
    promptGuidelines: [
      '调用时机（前置条件）：用户已确认/保存自然语言草稿后，你主动询问「是否需要固化为机械步骤」得到肯定答复，或用户明确要求把视觉步骤转为机械步骤时才调用。不要在 stage_case 刚落暂存就自动 solidify——草稿期保持自然语言更利于多轮讨论修改。',
      'solidify_case 真实执行一遍用例收集 AI 临场动作，机械映射为 compiled 后暂存为 update_step 修改（草稿用例整例更新）。暂存后必须引导 verify_case 验收——机械干跑通过才算固化完成；verify 失败由你根据失败归因修复 compiled 后重跑 verify，直到通过。通过后引导用户在暂存区勾选保存。',
      'solidify_case 结果里 status=kept-aiTask 的步骤附有 reason（press/wait 无机械对应 / 登录凭据占位 / 选择器不可映射 / 动作收集为空）：这些步骤保持视觉执行是预期行为，不要强行改写；确需机械化的（如选择器含 Playwright 专有语法）可先用 stage_case_op 换成平台可表达的选择器后重新固化。',
      '同一用例反复固化是安全幂等的：暂存 localId 按 stepId 确定（solidify-<stepId>），重复固化覆盖上一轮暂存；执行失败（任一步骤未过）时不会暂存任何修改，修正后重跑即可。',
      '被固化的 fill value 是 AI 当轮填入的原始值：若 instruction 引用了 {{变量}} 而 AI 填了具体值，固化会把该值冻结进 compiled——数据驱动用例（绑定数据集）不建议固化含变量填写的步骤，或固化后把 value 手工改回 {{变量}}。',
    ],
    execute: async (input) => {
      const lang: StLang = aiLangFrom(ctx.lang);
      const { caseId } = input as { caseId: string };
      try {
        // ── 前置校验（不启动浏览器）：caseId 双形态，与 verify_case 一致 ──
        const dbCase = (await db.select().from(testCases).where(eq(testCases.id, caseId)))[0];
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
            }
          : {
              title: stagedCase!.title,
              url: stagedCase!.url ?? null,
              expectedOutcome: stagedCase!.expectedOutcome ?? null,
              defaultEnvId: stagedCase!.defaultEnvId ?? null,
              versionId: stagedCase!.versionId,
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

        // 暂存叠加（与 verify_case 一致：基于暂存状态继续）
        let effectiveSteps = steps;
        const overlayPatches: { url?: string | null; defaultEnvId?: string | null } = {};
        let opsApplied = 0;
        if (dbCase) {
          const stagedOps = await db
            .select({ op: aiStageCaseOps.op, payload: aiStageCaseOps.payload })
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

        const visualSteps = effectiveSteps.filter(isVisualStep);
        if (visualSteps.length === 0) {
          return { ok: false, error: '用例没有视觉模式步骤（全部已编译或为敏感步骤），无需固化。若要把已编译步骤回退为视觉模式，先用 stage_case_op update_step 把 compiled 置 null。' };
        }
        const effectiveCase = { ...caseMeta, ...overlayPatches };

        // ── LLM 前置检查 ──
        let client: Awaited<ReturnType<typeof resolveLlmClient>>['client'];
        try {
          client = (await resolveLlmClient()).client;
        } catch (e) {
          return { ok: false, error: `LLM 未配置，无法执行 AI 固化: ${(e as Error).message}` };
        }

        // ── 环境解析 ──
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

        // ── 浏览器 + watchdog → 逐步骤 AI 驱动执行（与 verify_case AI 相同骨架）+ onAction 收集 ──
        let browser: Browser | undefined;
        let live: ReturnType<typeof registerLiveView> | undefined;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (browser) void browser.close().catch(() => undefined);
        }, SOLIDIFY_TIMEOUT_MS);
        try {
          const resolvedUrl = await resolveCaseUrl(
            {
              url: effectiveCase.url,
              // 草稿无 DB 行:groupId 在传 envCtx 时未被使用(仅 defaultEnvFallback 的 displayWebEnv 需要),填空串;
              // webServiceRef 草稿无法绑定命名服务 → null 走默认 web 服务。
              groupId: stagedCase ? '' : dbCase!.groupId,
              webServiceRef: stagedCase ? null : (dbCase!.webServiceRef ?? null),
            },
            { envCtx },
          );
          const targetUrl = resolvedUrl && /^https?:\/\//.test(resolvedUrl) ? resolvedUrl : undefined;
          browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
          const loginKey = loginStateKey(envCtx.envId, envCtx.login?.user);
          const cachedState = getLoginState(loginKey);
          const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width: 1280, height: 800 },
            ...(cachedState ? { storageState: cachedState } : {}),
          });
          const page = await context.newPage();
          // playground 实时画面：与 verify_case 同模式（注册页面源 → start 事件带流地址 → finally close）
          live = registerLiveView();
          live.setPage(page);
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

          const cred = envCtx.login;
          let stepSecret: string | undefined;
          const valueSub = (v: string): string => {
            if (v === USER_PH) return cred?.user ?? '';
            if (v === PASSWORD_PH) return cred?.password ?? '';
            if (v === SECRET_PH) return stepSecret ?? '';
            return v;
          };

          const reportId = `solidify-${randomUUID()}`;
          // stepId → 该步骤收集到的成功动作（按执行顺序）。AI 相对动作的原始参数（占位符未替换）。
          const collected = new Map<string, AiAction[]>();
          let failedIndex = -1;
          let failedError = '';
          let failedScreenshot: string | undefined;
          ctx.emit({
            type: 'solidify_progress', phase: 'start', caseId, total: effectiveSteps.length,
            solidifiable: visualSteps.length,
            targetUrl: targetUrl ?? null,
            loginCache: cachedState ? ('hit' as const) : ('miss' as const),
            liveUrl: `/api/assistant/threads/${ctx.threadId}/live/${live.key}`,
          });
          for (let i = 0; i < effectiveSteps.length; i++) {
            const s = effectiveSteps[i]!;
            const solidifiable = isVisualStep(s) && !s.sensitive;

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
            );
            let stepActions: AiAction[] = [];
            try {
              const summary = await runAiTask(page, instruction, client, false, {
                maxTurns: STEP_MAX_TURNS,
                valueSub,
                lang: ctx.lang,
                // 只收集可固化步骤的动作；敏感步骤凭据动作不进收集（占位符协议值本就无真实凭据，但语义上凭据不属于用例）
                onAction: (action, ok) => {
                  if (solidifiable && ok) stepActions.push(action);
                },
              });
              const parsed = tryParseJson(summary);
              if (parsed && parsed.status === 'failed') {
                failedIndex = i;
                failedError = typeof parsed.reason === 'string' ? parsed.reason : summary.slice(0, 200);
                failedScreenshot = await writeStepScreenshot(reportId, i + 1, page);
                break;
              }
              if (solidifiable && stepActions.length > 0) collected.set(s.id, stepActions);
            } catch (e) {
              if (timedOut) return { ok: false, error: `固化超时（${SOLIDIFY_TIMEOUT_MS / 1000}s）已终止` };
              failedIndex = i;
              failedError = (e as Error).message.slice(0, 300);
              failedScreenshot = await writeStepScreenshot(reportId, i + 1, page);
              break;
            }
          }

          // 登录态回写（与 verify_case 一致：无条件存当前会话，未登录存匿名会话亦自愈）
          const savedState = await context.storageState().catch(() => null);
          if (savedState) saveLoginState(loginKey, savedState);

          // 执行失败：不暂存任何修改（原子语义），失败页元素清单供 agent 修正 instruction 后重跑
          if (failedIndex >= 0) {
            const failurePage = await extractPageElements(page).catch(() => null);
            const failedStep = effectiveSteps[failedIndex]!;
            // 失败归因（与 verify_case 同一判别）：形态无关探针（每条 locator 实时命中数）+ 浮层清单 + 元素清单交 LLM 归因。
            const probes = await probeLocatorHits(page, collectStepLocators(failedStep.compiled));
            const evidence = await extractPageEvidence(page).catch(() => ({ overlays: [] as Array<{ tag: string; selector: string; text: string }> }));
            const diag = failurePage
              ? await diagnoseFailure({ client, step: failedStep, assertion: failedStep.assertion, probes, overlays: evidence.overlays, elements: failurePage, lang: ctx.lang })
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
          if (timedOut) return { ok: false, error: `固化超时（${SOLIDIFY_TIMEOUT_MS / 1000}s）已终止` };

          // ── 映射 + 暂存：全部步骤执行通过，逐视觉步骤把收集到的动作映射为 compiled ──
          const stepReports: Array<Record<string, unknown>> = [];
          let solidifiedCount = 0;
          let keptCount = 0;
          const draftSteps = stagedCase
            ? (stagedCase.steps as Array<{ action?: unknown; assertion?: unknown; compiled?: unknown }>)
            : null;
          for (const s of effectiveSteps) {
            const base = { order: s.order, instruction: s.instruction };
            if (!isVisualStep(s)) {
              stepReports.push({ ...base, status: 'skipped-compiled', reason: s.sensitive ? '敏感步骤（凭据不进 compiled）' : '已编译步骤不动' });
              continue;
            }
            if (s.sensitive) {
              stepReports.push({ ...base, status: 'skipped-sensitive', reason: '敏感步骤保持原样（凭据走加密协议）' });
              continue;
            }
            const mapped = mapAiActionsToCompiled(collected.get(s.id) ?? []);
            if (!mapped.ok) {
              keptCount += 1;
              stepReports.push({ ...base, status: 'kept-aiTask', reason: mapped.reason });
              continue;
            }
            solidifiedCount += 1;
            stepReports.push({
              ...base,
              status: 'solidified',
              compiled: mapped.compiled,
              ...(mapped.skippedCount > 0 ? { warning: `跳过 ${mapped.skippedCount} 个观察性截图动作` } : {}),
            });
            // 暂存写：DB 用例逐步骤 update_step（确定性 localId，重复固化幂等覆盖）；草稿整例重暂存
            if (dbCase) {
              const localId = `solidify-${s.id}`;
              const doc = {
                localId,
                caseId,
                op: 'update_step',
                payload: { action: 'update_step', caseId, stepId: s.id, compiled: mapped.compiled },
                summary: st(lang, 'step.solidified', { order: s.order, count: mapped.compiled.length }),
                diff: diffText({ compiled: s.compiled ?? null }, { compiled: mapped.compiled }),
                stagedAt: new Date().toISOString(),
              };
              await stageCaseOp(ctx.threadId, ctx.versionId, doc);
              emitStage(ctx, { kind: 'case_op' as const, id: localId, action: 'stage', payload: doc });
            } else if (draftSteps) {
              const idx = Number(/^staged-(\d+)$/.exec(s.id)?.[1] ?? 0) - 1;
              if (idx >= 0 && idx < draftSteps.length) {
                draftSteps[idx] = { ...draftSteps[idx]!, compiled: mapped.compiled };
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
                ? `已暂存 ${solidifiedCount} 个步骤的固化修改（草稿区可见）${keptCount > 0 ? `，${keptCount} 个步骤保持视觉模式（见各步 reason）` : ''}。下一步必须调用 verify_case 验收：机械干跑通过后引导用户在右侧暂存区勾选保存，固化才算完成。注意:固化产出的 compiled 是 AI 当轮实际动作的单候选映射——verify_case 若报 AmbiguousLocator/LocatorMismatch,用 failure.page.elements 里该元素的真实选择器把对应步骤补成多候选链(属性候选如 [placeholder=...] 优先、纯 #id 其次,规则同 stage_case 的 locator 规范),不要依赖单候选碰运气。`
                : '没有步骤被固化（各步保持视觉模式，原因见 steps[].reason）。多为登录/验证码/键盘时序类步骤——属预期保守行为，无需修正。',
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
