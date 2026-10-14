import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type {
  StepAction,
  Locator,
  IntentLocator,
  FailureReason,
  PreflightReport,
  HitLocator,
  WindowStrategy,
  DbQueryRowResult,
  ObserveLogLineResult,
  FillValue,
} from '@itest/shared';
import { deepEqual, materializeValue, substituteVars } from '@itest/shared';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testAttachments, testSteps } from '../db/schema.js';
import { decrypt } from '../lib/secret-crypto.js';
import { migrateAssertion } from '../lib/step-migration.js';
import { logger } from '../logger.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCandidates } from './locator-resolver.js';
import { LOCATOR_PROBE_ROUNDS, LOCATOR_PROBE_INTERVAL_MS } from './locator-probe.js';
import { waitForStable, ElementNotStable } from './stability.js';
import { classify } from './failureClassifier.js';
import { preflight } from './preflight.js';
import { domClick, domFill, domCheck, domSelect } from './domFallback.js';
import { resolveLlmClient } from '../agent/llmSettings.js';
import { runAiTask, solveCaptchaOnce, isCaptchaFailed, CAPTCHA_TASK_RE, USER_PH, PASSWORD_PH, SECRET_PH, type AiAction } from './aiTask.js';
import { mapAiActionsToCompiled } from './aiActionMap.js';
import { readAiTaskCache, writeAiTaskCache, bumpAiTaskCacheHit } from './aiTaskCache.js';
import type { EnvCtx } from './envContext.js';
import type { AiFallbackSettings } from './aiFallback.js';
import { runQueryDb } from './dbQuery.js';
import { runObserveLog } from './syslogReader.js';
import { runHttpRequest, type HttpStepResult } from './httpRequest.js';
import { runCaseVisionAssert } from './visionAssert.js';
import { newAiUsage, type AiUsageStat, type AiUsageAccumulator, type AiUsageAddend } from './aiUsage.js';
import { annotateAction, clearAnnotation, type LiveViewHandle } from './liveView.js';

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

/** 弹层/通知类元素 selector 兜底；用于 assertText errorMessage 目标。 */
const ERROR_MESSAGE_SELECTORS = [
  '.ant-message',
  '.toast',
  '[role="alert"]',
  '.el-message',
  '.ivu-message',
];

/** Postgres uuid 列形状校验，避免非法 id 触发 22P02。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExecStepResult {
  order: number;
  status: 'passed' | 'failed';
  durationMs: number;
  error?: string;
  screenshot?: string;
  warning?: string;
  /** 失败归类（failureClassifier 产出）；成功步为空 */
  failureReason?: FailureReason;
  /** 面向用户的失败说明 */
  humanMessage?: string;
  /** 本步实际命中的定位 kind/value */
  hitLocator?: HitLocator;
  /** switchTab 目标页在 tabMap 中的序号；非 tab 步为 0 */
  tabIndex?: number;
  /** queryDb 步骤的结果（仅 queryDb 步携带，其它步 undefined） */
  db?: DbQueryRowResult;
  /** observeLog 步骤的结果（仅 observeLog 步携带，其它步 undefined） */
  log?: ObserveLogLineResult;
  /** httpRequest 步骤的结果（仅 httpRequest 步携带，其它步 undefined） */
  http?: HttpStepResult;
  /** Track 1 用例级 vision 判定的回写结果（仅最后一步或追加失败步携带，其它步 undefined）。 */
  visionAssert?: { passed: boolean; reason: string; screenshot?: string; expected?: string; aiUsage?: AiUsageStat };
  /** aiTask 步骤本轮回放走了动作缓存（机械执行，零 LLM）；报告据此展示"缓存命中"。 */
  cached?: boolean;
  /** 本步 LLM 用量（aiTask / 验证码 / vision 判定产生的调用累加）；零调用步缺省。 */
  aiUsage?: AiUsageStat;
  /** 缓存条目存在但重放分叉、AI 自愈通过（仅 passed 步携带；首跑无缓存不算）。 */
  healed?: boolean;
  /** 本步机械执行受阻，由 AI 按步骤指令临场执行通过（回放 AI 降级）；报告据此醒目标注。 */
  degraded?: boolean;
}

export interface ExecContext {
  reportId: string;
  /** case 所属 project，用于 project-scoped 附件解析；缺省时不过滤（向后兼容） */
  projectId?: string;
  /** tabRef → Page（phase2 switchTab） */
  tabMap?: Map<string, Page>;
  /** fileId → 附件元数据；缺省回落 db 查询 */
  attachmentResolver?: (fileId: string) => Promise<{ storedPath: string; originalName: string } | null>;
  /** stepId → 敏感字段明文；缺省回落 db 查询 + 解密 */
  secretResolver?: (stepId: string) => Promise<string | null>;
  /** LLMClient 注入；缺省时按需 resolveLlmClient */
  llmClient?: import('../agent/llm-client.js').LLMClient;
  /** 环境上下文（含 pg.Pool / syslog 连接）；由 runCase 层注入，跨步骤复用。 */
  envCtx?: EnvCtx;
  /** Track 1：用例级 expectedOutcome（自然语言）。最后一步执行完毕后由 vision LLM 拿最终截图判终态。 */
  expectedOutcome?: string | null;
  /** 验证码多轮验证：aiTask 识别步骤成功后登记，后续 click（提交）步骤完成时按失败信号重试。
   *  hint = 录制时的语义定位（data-testid / name），重试识别时精确命中输入框。 */
  captchaRetry?: { hint: string | null; roundsLeft: number } | null;
  /** 用例标题（兜底语义锚，给 vision prompt 用）。 */
  caseTitle?: string;
  /** 用例 url（兜底语义锚，给 vision prompt 用）。 */
  caseUrl?: string | null;
  /** 数据集行初始变量（解密后明文，仅存在于执行期内存，不落库）。 */
  initialVars?: Record<string, string>;
  /** 数据集敏感列名集合：错误信息落报告前对相关变量值打码（与 recorder 敏感处理对齐）。 */
  sensitiveVarKeys?: string[];
  /** playground 实时画面源：每页新开时 setPage，让画面跟随执行（计划运行/单用例执行）。 */
  liveView?: LiveViewHandle;
  /** 回放 AI 降级开关（全局设置，runCase 层读入注入；缺省全关 = 保持既有失败语义）。 */
  aiFallback?: AiFallbackSettings;
}

/** 用例级窗口策略（maximize/current/custom），custom 时携带 width/height。 */
export interface CaseWindow {
  strategy: WindowStrategy;
  width?: number;
  height?: number;
}

interface DispatchOpts {
  page: Page;
  vars: Record<string, string>;
  ctx: ExecContext;
  /** 当前步骤 id（敏感填充解密用） */
  stepId?: string;
  /** 所属用例 id（aiTask 运行时缓存判定用；executeSteps 等无用例上下文的调用方缺省） */
  caseId?: string;
  /** 记录本步命中的定位 kind/value（由 tryFirstMatch 写入） */
  hitSink?: { current: HitLocator | null };
  /** 记录本步 queryDb 结果（由 queryDb 分支写入） */
  dbSink?: { current: DbQueryRowResult | null };
  /** 记录本步 observeLog 结果（由 observeLog 分支写入） */
  logSink?: { current: ObserveLogLineResult | null };
  /** 记录本步 httpRequest 结果（由 httpRequest 分支写入） */
  httpSink?: { current: HttpStepResult | null };
  /** 记录本步 aiTask 是否命中动作缓存（由 aiTask 分支写入） */
  cacheSink?: { current: boolean };
  /** 本步 LLM 用量累加器（aiTask / 验证码分支每轮 complete 后 add；stepResult 组装时读） */
  aiUsage?: AiUsageAccumulator;
  /** 记录本步是否发生缓存分叉后 AI 自愈成功（由 aiTask 分支写入） */
  healedSink?: { current: boolean };
}

/** 交互动作：执行前先做稳定性检查 */
const INTERACTIVE_KINDS: ReadonlyArray<StepAction['kind']> = ['click', 'fill', 'check', 'select', 'upload', 'aiTask'];
/** 验证码多轮验证的最大重试轮数（不含首轮识别提交）。 */
const CAPTCHA_RETRY_ROUNDS = 2;
/** 稳定性检查不过时可尝试 DOM 降级的动作 */
const DOM_FALLBACK_KINDS: ReadonlyArray<StepAction['kind']> = ['click', 'fill', 'check', 'select'];

/** DOM 降级：元素不稳定时绕过 playwright 直接在页面里派发事件。仅支持 click/fill/check/select。 */
async function tryDomFallback(action: StepAction, opts: DispatchOpts): Promise<{ ok: boolean; error?: string }> {
  const { page, vars } = opts;
  // 与 playwright 路径一致：fill/select 的字符串值先过 substituteVars，缺变量直接失败，避免把 {{var}} 原样写进表单。
  if (action.kind === 'fill' || action.kind === 'select') {
    const tpl = typeof action.value === 'string' ? action.value : '';
    if (tpl) {
      const { missing } = substituteVars(tpl, vars);
      if (missing.length > 0) return { ok: false, error: `var-missing: {{${missing[0]!}}}` };
    }
  }
  switch (action.kind) {
    case 'click':
      return domClick(page, action.locator);
    case 'fill':
      return domFill(page, action.locator, resolveFillValue(action.value ?? '', opts.ctx.envCtx, vars));
    case 'check':
      return domCheck(page, action.locator, action.checked);
    case 'select':
      return domSelect(page, action.locator, materializeValue(action.value, vars));
    default:
      return { ok: false, error: 'unsupported' };
  }
}

/** 交互动作前置稳定性检查；不稳定时尝试 DOM 降级，降级也失败则抛 ElementNotStable。 */
async function ensureStable(action: StepAction, opts: DispatchOpts): Promise<string | undefined> {
  try {
    // waitForStable 的 locator 参数当前未使用；不传 page.locator('body') 以避免多余的探测调用。
    await waitForStable(opts.page, undefined as never, { timeoutMs: 2000, pollMs: 100 });
    return undefined;
  } catch (e) {
    if (!(e instanceof ElementNotStable)) {
      // 探测本身失败（evaluate 不可用等）→ 无法评估稳定性，放行由动作自身的超时兜底。
      return undefined;
    }
    if (
      DOM_FALLBACK_KINDS.includes(action.kind) &&
      // 敏感填充的明文只有 secretResolver 能解，DOM 降级会写入占位符，故跳过降级。
      !(action.kind === 'fill' && action.sensitive)
    ) {
      const r = await tryDomFallback(action, opts);
      if (r.ok) return 'dom-fallback';
    }
    throw e;
  }
}

/** 默认附件解析：按 fileId 查 test_attachments（非 UUID 直接 miss，避免 22P02）。
 * 提供 projectId 时附加 project 过滤，避免跨 project 引用 fileId 解析。 */
async function defaultAttachmentResolver(fileId: string, projectId?: string): Promise<{ storedPath: string; originalName: string } | null> {
  if (!fileId || !UUID_RE.test(fileId)) return null;
  const where = projectId
    ? and(eq(testAttachments.id, fileId), eq(testAttachments.projectId, projectId))
    : eq(testAttachments.id, fileId);
  const rows = await db.select().from(testAttachments).where(where);
  const row = rows[0];
  return row ? { storedPath: row.storedPath, originalName: row.originalName } : null;
}

/** 默认密钥解析：按 stepId 查 test_steps 并解密（非 UUID 或密文字段缺失 → null）。 */
async function defaultSecretResolver(stepId: string): Promise<string | null> {
  if (!stepId || !UUID_RE.test(stepId)) return null;
  const rows = await db.select().from(testSteps).where(eq(testSteps.id, stepId));
  const s = rows[0];
  if (!s || !s.sensitive || !s.secretCiphertext || !s.secretIv || !s.secretTag) return null;
  return decrypt({
    ciphertext: Buffer.from(s.secretCiphertext, 'base64'),
    iv: Buffer.from(s.secretIv, 'base64'),
    tag: Buffer.from(s.secretTag, 'base64'),
  });
}

/** 机械派发路径的凭据占位符 → 环境 login 凭据真实值。
 *  AI 相（verify/solidify/perform_login）由 valueSub 在动作执行时刻替换（aiTask.ts），
 *  compiled 的机械派发没有那套替换，这里补齐同一语义 —— 否则占位符会被原样敲进表单、
 *  登录必然失败且步骤仍报 passed（2026-10-13 prod228 用例 394bdcb2 实测）。
 *  非占位符原样返回；引用了凭据但环境没配 login → EnvMissing，绝不静默填字面量。 */
function resolveEnvCredential(raw: string, envCtx: EnvCtx | undefined): string {
  if (raw === USER_PH || raw === PASSWORD_PH) {
    const login = envCtx?.login;
    if (!login) {
      const e = new Error(`env-missing: 用例步骤引用了 ${raw}，但当前环境未配置 login 凭据（请到项目设置→测试环境配置）`);
      e.name = 'EnvMissing';
      throw e;
    }
    return raw === USER_PH ? login.user : login.password;
  }
  if (raw === SECRET_PH) {
    // 步骤级密文只有 sensitive 分支（secretResolver）能解；compiled 里写占位符无处可解。
    const e = new Error(`secret-missing: 步骤 compiled 含 ${SECRET_PH}，敏感值只能走 sensitive=true + 密文，不能写占位符`);
    e.name = 'SecretMissing';
    throw e;
  }
  return raw;
}

/** fill 的最终入值：{{变量}} 物化后替换环境凭据占位符（非字符串 value 只做物化）。 */
function resolveFillValue(value: FillValue, envCtx: EnvCtx | undefined, vars: Record<string, string>): string {
  return resolveEnvCredential(materializeValue(value, vars), envCtx);
}

/**
 * 执行单步；返回 warning 文本（无则 undefined）。失败抛错由调用方记 failed。
 * 入口包 finally 清除动作高亮（blackboard）：无论动作成败，其后的 step 截图 / vision 断言 /
 * aiTask 轮截图都发生在清除之后，永不被描边框污染。递归（aiTask 缓存重放 dispatch 子动作）同样经过本入口。
 */
async function dispatch(action: StepAction, opts: DispatchOpts): Promise<string | undefined> {
  try {
    return await dispatchInner(action, opts);
  } finally {
    await clearAnnotation(opts.page);
  }
}

async function dispatchInner(action: StepAction, opts: DispatchOpts): Promise<string | undefined> {
  const { page, vars } = opts;
  // 交互动作前置稳定性检查；不稳定且 DOM 降级成功时以 warning 短路返回。
  if (INTERACTIVE_KINDS.includes(action.kind)) {
    const stableWarning = await ensureStable(action, opts);
    if (stableWarning) return stableWarning;
  }
  switch (action.kind) {
    case 'navigate': {
      const { value, missing } = substituteVars(action.url, vars);
      if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.url}")`);
      await page.goto(value, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // navigate 同样需要等 SPA hydrate 后再让后续步骤探测元素（与 init-goto 行为对齐）。
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      return;
    }
    case 'click':
      try {
        // React 受控表单的 button 经常在 onChange → setState → re-render 之前仍是 disabled。
        // 这里用 force: true 跳过 enabled 检查直接 click（按钮在 click 时只要 password state 非空就能触发 submit）。
        await (await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink)).click({ timeout: 5000, force: true });
      } catch (e) {
        if (e instanceof Error && /strict mode violation/.test(e.message)) {
          const loc = await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink);
          // 不能裸 first()：Element-UI 在 .el-table 首子节点渲染 display:none 的 .hidden-columns
          // 模板克隆（.el-table__fixed 里还有隐藏克隆），DOM 顺序早于真实元素，first() 会抓到
          // 不可见副本等 5s 超时（规则查看 回测根因）。与 assertVisible 兜底同款 visible 过滤。
          await loc.filter({ visible: true }).first().click({ timeout: 5000 });
          return;
        }
        throw e;
      }
      return;
    case 'fill': {
      let value: string;
      if (action.sensitive) {
        const secret = opts.ctx.secretResolver
          ? await opts.ctx.secretResolver(opts.stepId ?? '')
          : await defaultSecretResolver(opts.stepId ?? '');
        if (secret == null) throw new Error(`secret-missing: step ${opts.stepId ?? '(no id)'}`);
        value = secret;
      } else {
        if (typeof action.value === 'string') {
          const sub = substituteVars(action.value, vars);
          if (sub.missing.length > 0) {
            throw new Error(`var-missing: {{${sub.missing[0]!}}} (template="${action.value}")`);
          }
        }
        value = resolveFillValue(action.value, opts.ctx.envCtx, vars);
      }
      const fillLoc = await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink);
      try {
        // React 受控表单：fill() 只改 DOM value，onChange 不一定冒泡。
        // 先 fill('')，再用 pressSequentially 模拟真实键入，确保组件重新计算 state（disabled 状态、错误信息等）。
        await fillLoc.fill('', { timeout: 5000 });
        await fillLoc.pressSequentially(value, { delay: 20 });
        // 触发 blur 让 onChange 提交（Antd 等库在 blur 时同步校验/格式化）
        await page.keyboard.press('Tab').catch(() => undefined);
      } catch (e) {
        // strict-mode violation（getByRole 命中多个同名元素）→ 退到可见匹配的 first()
        // （visible 过滤防隐藏克隆劫持，同 click 兜底）
        if (e instanceof Error && /strict mode violation/.test(e.message)) {
          await fillLoc.filter({ visible: true }).first().fill(value, { timeout: 5000 });
          return;
        }
        throw e;
      }
      return;
    }
    case 'hover': {
      const hoverLoc = await tryFirstMatch(page, action.locator, undefined, opts.hitSink);
      try {
        await hoverLoc.hover({ timeout: 5000 });
      } catch (e) {
        // strict-mode violation（文本/role 命中多个元素，录制场景常见：表格里重复的日期、同名链接）
        // → 退到可见匹配的 first()，与 click/fill 的兜底一致（visible 过滤防隐藏克隆劫持）。
        if (e instanceof Error && /strict mode violation/.test(e.message)) {
          await hoverLoc.filter({ visible: true }).first().hover({ timeout: 5000 });
          return;
        }
        throw e;
      }
      return;
    }
    case 'waitFor': {
      // tryFirstMatch 的 count() 是单帧探测：waitFor 语义是「等元素出现」，
      // 点击/导航后元素尚不存在时必须轮询重试，否则 t=0 探测一次 count=0 立即失败。
      const timeoutMs = action.timeoutMs ?? 5000;
      const deadline = Date.now() + timeoutMs;
      let lastErr: unknown;
      while (Date.now() < deadline) {
        try {
          const loc = await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink);
          await loc.waitFor({ state: 'visible', timeout: Math.max(100, deadline - Date.now()) });
          return;
        } catch (e) {
          lastErr = e;
          await page.waitForTimeout(200);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(`waitFor timeout: ${action.locator[0]?.value}`);
    }
    case 'assertVisible': {
      const assertLoc = await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink);
      try {
        if (!(await assertLoc.isVisible({ timeout: 5000 }))) {
          throw new Error(`assertVisible failed: ${action.locator[0]?.value}`);
        }
      } catch (e) {
        // strict-mode violation（text/role 命中多个元素，如表格列头+筛选区同名文本）
        // → 退到「任一匹配可见」即通过，与 click/fill/hover 的兜底一致。
        // 注意不能只查 first()：Element-UI 固定列会在 .el-table__fixed 里渲染隐藏克隆，
        // DOM 顺序靠前的匹配可能是 visibility:hidden 的副本，必须过滤后再判。
        if (e instanceof Error && /strict mode violation/.test(e.message)) {
          if (!(await assertLoc.filter({ visible: true }).first().isVisible())) {
            throw new Error(`assertVisible failed: ${action.locator[0]?.value}`);
          }
          return;
        }
        throw e;
      }
      return;
    }
    case 'assertText': {
      const a = action as StepAction & { kind: 'assertText' };
      const { value, missing } = substituteVars(a.equals, vars);
      if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${a.equals}")`);
      const actual = await resolveAssertTextActual(page, a, opts.hitSink);
      const ok = matchAssertText(actual, value, a.match ?? 'equals');
      if (!ok) {
        throw new Error(`assertText failed (${a.target ?? 'specifiedElement'}/${a.match ?? 'equals'}): expected ${JSON.stringify(value)}, actual ${JSON.stringify(actual.slice(0, 100))}`);
      }
      return;
    }
    case 'assertJson': {
      const { value: textTemplate, missing: missingJson } = substituteVars(
        JSON.stringify(action.equals ?? null),
        vars,
      );
      if (missingJson.length > 0) {
        throw new Error(`var-missing: {{${missingJson[0]!}}} (template="${JSON.stringify(action.equals).slice(0, 100)}")`);
      }
      const text = (await (await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink)).innerText({ timeout: 5000 })).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`assertJson: 元素文本不是合法 JSON: ${text.slice(0, 100)}`);
      }
      let expected: unknown;
      try {
        expected = JSON.parse(textTemplate);
      } catch {
        throw new Error(`assertJson: 变量替换后期望值不是合法 JSON: ${textTemplate.slice(0, 100)}`);
      }
      if (!deepEqual(parsed, expected)) {
        throw new Error(`assertJson 深比较失败: 实际 ${text.slice(0, 100)}`);
      }
      return;
    }
    case 'screenshot': {
      const { value, missing } = substituteVars(action.name, vars);
      if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.name}")`);
      await page.screenshot({ path: value || 'snap' });
      return;
    }
    case 'check': {
      const loc = await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink);
      const current = await loc.isChecked({ timeout: 5000 });
      if (current !== action.checked) {
        if (action.checked) await loc.check({ timeout: 5000 });
        else await loc.uncheck({ timeout: 5000 });
      }
      return;
    }
    case 'select': {
      const { value, missing } = substituteVars(action.value, vars);
      if (missing.length > 0) throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.value}")`);
      await (await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink)).selectOption(value, { timeout: 5000 });
      return;
    }
    case 'upload': {
      const meta = opts.ctx.attachmentResolver
        ? await opts.ctx.attachmentResolver(action.fileId)
        : await defaultAttachmentResolver(action.fileId, opts.ctx.projectId);
      if (!meta) throw new Error(`attachment-missing: ${action.fileId}`);
      await (await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink)).setInputFiles(meta.storedPath, { timeout: 5000 });
      return;
    }
    case 'switchTab': {
      let target = opts.ctx.tabMap?.get(action.tabRef);
      if (!target) {
        // 模糊匹配兜底：tabMap 未命中时取 context 中最后一个 page。
        try {
          const pages = page.context().pages();
          if (pages.length > 0) target = pages[pages.length - 1]!;
        } catch {
          // context 不可用（已关闭/测试桩）→ 维持 tab-missing 语义
        }
        if (!target) throw new Error(`tab-missing: ${action.tabRef}`);
        opts.ctx.tabMap?.set(action.tabRef, target);
        await target.bringToFront();
        // 后续步骤（含截图）都落在切换后的页面上。
        opts.page = target;
        return 'tab-fuzzy-match';
      }
      await target.bringToFront();
      // 后续步骤（含截图）都落在切换后的页面上。
      opts.page = target;
      return;
    }
    case 'extract': {
      const loc = await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink);
      let text: string;
      try {
        text = await loc.inputValue({ timeout: 5000 });
      } catch {
        text = await loc.innerText({ timeout: 5000 });
      }
      const raw = text.trim();
      let resolved = raw;
      if (action.mode === 'regex') {
        if (!action.pattern) throw new Error(`extract-missing: var=${action.varName} 未配置 pattern`);
        const re = new RegExp(action.pattern, 'g');
        const matches = [...raw.matchAll(re)];
        if (matches.length === 0) {
          throw new Error(`extract-missing: var=${action.varName} pattern=${action.pattern} 无匹配 (raw="${raw.slice(0, 100)}")`);
        }
        const group = action.group ?? 0;
        const m = matches[0]!;
        resolved = group === 0 ? (m[0] ?? '') : (m[group] ?? '');
      }
      // completeValue 与 smartExtract 都用 raw；smartExtract 已编译为 regex 但保留 mode 字段以便 UI 标注
      vars[action.varName] = resolved;
      return;
    }
    case 'aiTask': {
      const { value, missing } = substituteVars(action.instruction, vars);
      if (missing.length > 0) {
        throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.instruction}")`);
      }
      // 运行时动作缓存（自动挡固化）：可缓存 = DB 步骤（UUID stepId）+ 用例回放上下文
      // + 非验证码（每次必须真识别）+ 指令无数据集变量（缓存值含物化数据，跨行复用必错）。
      const cacheable = !!opts.caseId && !!opts.stepId && UUID_RE.test(opts.stepId)
        && !CAPTCHA_TASK_RE.test(action.instruction)
        && value === action.instruction;
      if (cacheable) {
        const cached = await readAiTaskCache(opts.stepId!, action.instruction);
        if (cached && cached.length > 0) {
          let cacheDiverged = false;
          try {
            // 缓存动作经完整 dispatch：稳定性检查 / 多候选探测 / DOM 降级 / hitSink 全部生效。
            for (const sub of cached) await dispatch(sub, opts);
            void bumpAiTaskCacheHit(opts.stepId!).catch(() => undefined);
            if (opts.cacheSink) opts.cacheSink.current = true;
            return `aiTask(缓存命中): ${cached.length} 个机械动作`;
          } catch {
            // 页面分叉：静默回退 AI 重做（自愈），成功后覆写缓存。
            cacheDiverged = true;
          }
          if (cacheDiverged && opts.healedSink) opts.healedSink.current = true;
        }
      }
      const client = opts.ctx.llmClient ?? (await resolveLlmClient()).client;
      const collected: AiAction[] = [];
      const aiOpts: { onAction: (a: AiAction, ok: boolean) => void; onUsage?: (r: AiUsageAddend) => void } = {
        onAction: (a, ok) => { if (ok) collected.push(a); },
      };
      if (opts.aiUsage) aiOpts.onUsage = (r) => opts.aiUsage!.add(r);
      const summary = await runAiTask(opts.page, value, client, undefined, aiOpts);
      // 验证码类指令：登记多轮验证上下文。提交（后续 click 步骤）若被系统判验证码错误/过期，
      // 执行器自动重新识别（失败后验证码通常已被前端换新）并重新提交，而非直接判用例失败。
      if (CAPTCHA_TASK_RE.test(value)) {
        opts.ctx.captchaRetry = { hint: action.intentLocator?.semanticRole ?? null, roundsLeft: CAPTCHA_RETRY_ROUNDS };
      }
      if (cacheable) {
        const mapped = mapAiActionsToCompiled(collected);
        if (mapped.ok) {
          void writeAiTaskCache(opts.stepId!, action.instruction, mapped.compiled).catch(() => undefined);
        }
      }
      return summary ? `aiTask: ${summary}` : undefined;
    }
    case 'queryDb': {
      const envCtx = opts.ctx.envCtx;
      if (!envCtx?.pool) {
        const e = new Error('env db missing'); e.name = 'EnvDbMissing'; throw e;
      }
      const result = await runQueryDb({ pool: envCtx.pool, action });
      if (result.assertion && !result.assertion.matched) {
        // 先把结果写到 sink，调用方即便抛错也能在 step.result.db 里看到 rows
        if (opts.dbSink) opts.dbSink.current = result;
        const e = new Error('queryDb assertion failed'); e.name = 'QueryDbAssertionFailed'; throw e;
      }
      if (opts.dbSink) opts.dbSink.current = result;
      return;
    }
    case 'observeLog': {
      const envCtx = opts.ctx.envCtx;
      if (!envCtx?.syslog) {
        const e = new Error('env syslog missing'); e.name = 'EnvSyslogMissing'; throw e;
      }
      const result = await runObserveLog({ env: envCtx.syslog, action, since: new Date() });
      if (result.assertion && !result.assertion.matched) {
        if (opts.logSink) opts.logSink.current = result;
        const e = new Error('observeLog assertion failed'); e.name = 'LogAssertionFailed'; throw e;
      }
      if (opts.logSink) opts.logSink.current = result;
      return;
    }
    case 'httpRequest': {
      const result = await runHttpRequest({ action, page: opts.page, vars: opts.vars });
      // saveAs 提取的变量写回 vars，后续步骤 {{var}} 可消费
      if (result.saved) opts.vars[result.saved.varName] = result.saved.value;
      if (result.assertion && !result.assertion.matched) {
        // 先把结果写到 sink，调用方即便抛错也能在 step.result.http 里看到请求/响应
        if (opts.httpSink) opts.httpSink.current = result;
        const e = new Error('httpRequest assertion failed'); e.name = 'HttpRequestAssertionFailed'; throw e;
      }
      if (opts.httpSink) opts.httpSink.current = result;
      return;
    }
  }
}

/** 把 test_steps.assertion 规整为 dispatch 认识的 StepAction；非法形态返回 undefined 表示跳过断言。
 *  Track 1：target:'page' + match:'contains' + 空 locator 的「整页模糊文本断言」一律跳过；
 *  AI 写出来的描述性断言（"登录表单正常展示"等）正是这个形态，过滤后回放不再因 page innerText 命中失败。
 *  真正的元素断言（specifiedElement + 非空 locator）继续生效。 */
function normalizeStepAssertion(raw: unknown): StepAction | undefined {
  if (raw == null) return undefined;
  const migrated = migrateAssertion(raw);
  if (!migrated || typeof migrated !== 'object') return undefined;
  // 只放行 assertText（唯一支持的步骤级断言类型）；其它 kind 当作未设置以免污染错误信息。
  if ((migrated as { kind?: string }).kind !== 'assertText') return undefined;
  const a = migrated as StepAction & { target?: string; match?: string; locator?: ReadonlyArray<unknown> };
  // 整页模糊文本断言 → 跳过（用例级 expectedOutcome + vision 才是终态判定）
  if (a.target === 'page' && (a.locator?.length ?? 0) === 0) return undefined;
  return migrated as StepAction;
}

/** 依命中的候选 kind 反解出可读的定位表达式（用于报告展示）。 */
function locatorForCandidate(locator: Locator[], intent: IntentLocator | undefined, kind: string): string {
  if (kind === 'intent-testid' && intent?.semanticRole) return `[data-testid="${intent.semanticRole}"]`;
  if (kind === 'intent-text' && intent?.contextText) return `text=${intent.contextText}`;
  for (const l of locator) {
    if (kind === 'stable-css' && l.strategy === 'css') return l.value;
    if (kind === 'css' && l.strategy === 'css') return l.value;
    if (kind === 'xpath' && l.strategy === 'xpath') return l.value;
    if (kind === 'role' && l.strategy === 'role') return l.value;
    if (kind === 'text' && l.strategy === 'text') return l.value;
    if (kind === 'testId' && l.strategy === 'testId') return l.value;
  }
  return kind;
}

/** tryFirstMatch 探测视角的 locator 形状：count() 探测存在性，filter({visible}) 取可见子集。 */
interface ProbeLocator {
  count?: () => Promise<number>;
  filter?: (opts: { visible: boolean }) => ProbeLocator;
}

/**
 * 三层定位候选顺序尝试；任一成功即返回。所有候选失败抛错。
 * 使用 buildCandidates 构造候选；优先用 intent.testid / contextText，再稳定 #id CSS，最后是 XPath / 其它 CSS。
 * 候选探测通过 count()，避免后续动作（如 click）抛错；text/role 路径可能没有 count()，接受即成功。
 * 命中时把候选 kind/value 写入 hitSink（若提供），供 step 结果记录 hitLocator。
 */
async function tryFirstMatch(
  page: Page,
  locator: Locator[],
  intentLocator?: IntentLocator,
  hitSink?: { current: HitLocator | null },
): Promise<ReturnType<Page['locator']>> {
  // 2026-10-07: mobile-only locator strategy 在 web engine dispatcher 中标 unsupported,
  // 避免误用(如 web case 误用 accessibilityId 命中空节点导致 fail)。
  // 这里 guard 早于 buildCandidates：buildCandidates 是纯 web 形态,接受 mobile-only strategy 会误生成 css 候选,
  // 因此直接在此处抛错。MobileEngine 不走 buildCandidates,不会受影响。
  for (const l of locator) {
    if (l.strategy === 'accessibilityId' || l.strategy === 'label' || l.strategy === 'predicate') {
      throw new Error(`locator strategy '${l.strategy}' is mobile-only; cannot run on web engine`);
    }
  }
  const cands = buildCandidates(page, { locator, intentLocator });
  if (cands.length === 0) {
    throw new Error('locator array is empty');
  }
  // 2026-10-10: 候选探测从「单候选 count=0 后单次 150ms 重试」改为有界轮询窗口——
  // 首轮立即按序探测全部候选,全部落空则每 250ms 轮转再探,任一命中即返回,最多 12 轮(≈3s)。
  // 根因一(a11y 滞后,150ms 够用):playwright 的 count() 走 a11y 树,rebuild 是 lazy 的,
  //   networkidle 后 DOM 已渲染但 a11y 树可能滞后 ~100-200ms(实测 SOC 登录页 150ms 后变 1)。
  // 根因二(SPA 挂载滞后,150ms 差一个数量级):深链路由挂载在 networkidle 后仍可持续秒级,
  //   实测 8a178d83 回测 step-1 探测放弃约 2s 后页面才挂载完成(失败截图已是完整渲染页)。
  // 用轮数上限而非墙钟 deadline:窗口语义固定(12×250ms≈3s),且测试里 mock 的 waitForTimeout
  // 不推进墙钟,墙钟 deadline 会死循环。探测异常按该轮落空处理进下一轮(瞬时错误可自愈);
  // 无 count() 的候选(如 getByText 路径)保持直接接受。
  let lastErr: unknown;
  for (let round = 0; round < LOCATOR_PROBE_ROUNDS; round++) {
    if (round > 0) await page.waitForTimeout(LOCATOR_PROBE_INTERVAL_MS);
    for (const c of cands) {
      const probe = c.loc as unknown as ProbeLocator;
      if (!probe || typeof probe.count !== 'function') {
        // 没有 count()（如 getByText 路径）直接接受
        if (hitSink) hitSink.current = { kind: c.kind, value: locatorForCandidate(locator, intentLocator, c.kind) };
        await annotateAction(page, () => c.loc.boundingBox().catch(() => null));
        return c.loc;
      }
      const n = await probe.count().catch((e) => { lastErr = e; return -1; });
      if (n > 0) {
        // 2026-10-10 Fix C（可见性感知探测）: raw 命中后还需存在「可见」实例才返回,
        // 并把可见子集交给后续动作。Element-UI 固定列/模板克隆会让链式选择器解析到
        // 不可见副本,生产上有两种失败形态:
        //  ① 单匹配不可见 → click 无坐标可算,~1s 抛 "Element is not visible"(克隆/导入导出);
        //  ② force:true 点中不可见副本"通过"但实际无效果,后续步骤 count=0(查看/编辑)。
        // 可见子集为空 → 视为本轮落空,继续轮询/下一候选(行重渲染竞态下下轮会出现可见实例);
        // 可见性探测异常或 locator 无 filter() → 维持旧行为返回原 locator。
        const visibleLoc = probe.filter?.({ visible: true });
        const vn = visibleLoc && typeof visibleLoc.count === 'function'
          ? await visibleLoc.count().catch((e) => { lastErr = e; return -1; })
          : -1;
        if (vn === 0) {
          lastErr = new Error(`resolved ${n} match(es) but none visible (${c.kind})`);
          continue;
        }
        if (hitSink) hitSink.current = { kind: c.kind, value: locatorForCandidate(locator, intentLocator, c.kind) };
        const chosen = (vn > 0 ? visibleLoc! : c.loc) as ReturnType<Page['locator']>;
        await annotateAction(page, () => chosen.boundingBox().catch(() => null));
        return chosen;
      }
      if (n === 0) lastErr = new Error(`count=0 (${c.kind})`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('all locator candidates failed');
}

/** resolveAssertTextActual: 根据 action.target 决定 actual 字符串的来源。 */
async function resolveAssertTextActual(
  page: Page,
  action: StepAction & { kind: 'assertText' },
  hitSink?: { current: HitLocator | null },
): Promise<string> {
  const target = action.target ?? 'specifiedElement';
  if (target === 'page') {
    return (await page.evaluate(() => (globalThis as { document?: { body?: { innerText?: string } } }).document?.body?.innerText ?? '')) as string;
  }
  if (target === 'url') {
    return page.url();
  }
  if (target === 'errorMessage') {
    const sel = ERROR_MESSAGE_SELECTORS.join(', ');
    const loc = page.locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout: 5000 });
    return (await loc.innerText({ timeout: 5000 })).trim();
  }
  // specifiedElement（默认）
  if (action.locator.length === 0) throw new Error('assertText: specifiedElement 模式需要 locator');
  const loc = await tryFirstMatch(page, action.locator, action.intentLocator, hitSink);
  return (await loc.innerText({ timeout: 5000 })).trim();
}

/** matchAssertText: 断言匹配规则（equals/contains/notContains/regex）。 */
function matchAssertText(actual: string, expected: string, match: 'equals' | 'contains' | 'notContains' | 'regex'): boolean {
  switch (match) {
    case 'equals': return actual.trim() === expected.trim();
    case 'contains': return actual.includes(expected);
    case 'notContains': return !actual.includes(expected);
    case 'regex': return new RegExp(expected).test(actual);
  }
}

/** 验证码多轮验证：提交（click）后页面出现验证码失败提示时，重新识别并重新提交。
 *  兼容两类真实失败：LLM 识别错误、验证码过期——多数系统登录失败后前端自动换新验证码，
 *  直接识别当前图重试即可。轮数耗尽仍有失败提示 → 抛错判本步失败。返回 warning 文本。 */
async function runCaptchaRetry(opts: DispatchOpts, clickActions: StepAction[]): Promise<string | undefined> {
  const pending = opts.ctx.captchaRetry;
  if (!pending) return undefined;
  const client = opts.ctx.llmClient ?? (await resolveLlmClient()).client;
  const notes: string[] = [];
  try {
    while (pending.roundsLeft > 0) {
      // 给登录接口往返和错误提示渲染留时间
      await opts.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      await opts.page.waitForTimeout(600);
      const onUsage = opts.aiUsage ? (r: AiUsageAddend) => opts.aiUsage!.add(r) : undefined;
      if (!(await isCaptchaFailed(opts.page, client, onUsage))) break;
      pending.roundsLeft--;
      const round = CAPTCHA_RETRY_ROUNDS - pending.roundsLeft;
      // 快路径一次 vision 调用（~10s，抢 TTL）；机械失败回落通用多轮回路。
      const solved = await solveCaptchaOnce(opts.page, client, pending.hint, onUsage).catch(() => null)
        ?? await runAiTask(opts.page, '识别当前验证码图片中的字符并填入验证码输入框', client, undefined, onUsage ? { onUsage } : undefined).catch(() => null);
      if (!solved) {
        notes.push(`第 ${round} 轮：识别失败`);
        break;
      }
      notes.push(`第 ${round} 轮：${solved}`);
      for (const a of clickActions) {
        await dispatch(a, opts);
      }
    }
    if (pending.roundsLeft <= 0) {
      await opts.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
      await opts.page.waitForTimeout(600);
      const onUsage = opts.aiUsage ? (r: AiUsageAddend) => opts.aiUsage!.add(r) : undefined;
      if (await isCaptchaFailed(opts.page, client, onUsage)) {
        throw new Error('验证码多轮重试后仍校验失败（识别错误或验证码已过期）');
      }
    }
  } finally {
    opts.ctx.captchaRetry = null;
  }
  return notes.length > 0 ? `验证码重试：${notes.join('；')}` : undefined;
}

export async function writeStepScreenshot(reportId: string, stepIndex: number, page: Page): Promise<string | undefined> {
  try {
    // navigate/click 触发跳转后立即截图会拍到白屏（SPA 在 domcontentloaded 后才渲染）。
    // 先等 networkidle 让渲染落地；带 2s 兜底，长连接页面等不到 idle 也不阻塞截图。
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);
    const dir = join(SCREENSHOTS_DIR, reportId);
    await mkdir(dir, { recursive: true });
    const filename = `step-${stepIndex}.png`;
    await page.screenshot({ path: join(dir, filename), fullPage: false });
    return `/screenshots/${reportId}/${filename}`;
  } catch (e) {
    logger.warn({ err: e, reportId, stepIndex }, 'failed to capture step screenshot');
    return undefined;
  }
}

/** 报告侧脱敏：把 text 中出现的敏感变量值全部替换为 ******。
 *  用 split/join 而非 RegExp，避免值里含正则元字符；
 *  按值长度降序替换，防止短值是长值子串时留下残段。 */
export function maskSensitiveValues(text: string, vars: Record<string, string>, keys: readonly string[]): string {
  const vals = keys
    .map((k) => vars[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of vals) out = out.split(v).join('******');
  return out;
}

/** 行级预期物化：expectedOutcome 模板按当次运行最终 vars（数据集初始变量 + extract）替换后交 vision 判定。
 *  missing 保留字面量 —— vision 大概率不匹配 → 该行失败且报告可见原因，诚实失败优于静默跳过。 */
export function materializeExpectedOutcome(text: string, vars: Record<string, string>): string {
  return substituteVars(text, vars).value;
}

/** 在已持有的 browser context 中跑用例步骤：init-goto → preflight → 步骤循环 → vision 兜底。
 *  与 `executeCaseReal` 共享核心逻辑；区别是不负责 launch/newContext/close，调用方持有生命周期。 */
async function runStepsInContext(
  caseId: string,
  steps: Array<{
    order: number;
    assertion?: unknown;
    delayMs?: number | null;
    id?: string;
    tabRef?: string | null;
    componentKind?: string | null;
    sensitive?: boolean | null;
    /** 可执行 DSL 数组；回放唯一依据。空数组/null = 未编译,抛 compile-missing。 */
    compiled?: unknown[] | null;
    /** 行级自然语言指令；回放仅 AI 降级兜底用，机械回放不读。 */
    instruction?: string | null;
  }>,
  ctx: ExecContext,
  context: BrowserContext,
  targetUrl?: string,
  onPreflight?: (report: PreflightReport) => void,
  caseWindow?: CaseWindow,
  /** 每步结束（passed/failed）后回调——供调用方增量落库，报告页轮询即可逐步看到结果。 */
  onStep?: (r: ExecStepResult) => void,
  /** 失败即停钩子（verify_case 用）：失败 break 前携带失败步骤下标与当前页触发；钩子抛错忽略。 */
  onFailurePage?: (page: Page, failedIndex: number) => Promise<void>,
): Promise<ExecStepResult[]> {
  const results: ExecStepResult[] = [];
  const vars: Record<string, string> = { ...(ctx.initialVars ?? {}) };
  const page = await context.newPage();
  // playground 实时画面跟随：切换到本页（切换页 switchTab / 逐用例新 page 都会经过这里）。
  ctx.liveView?.setPage(page);
  // 初始导航：用例级 init URL（targetUrl）始终先 goto 一次。
  // 若首条 step 也是 navigate 且 URL 与 init 相同，让 step 来做这一步，避免重复加载。
  const firstCompiled = steps[0]?.compiled;
  const firstStepKind = (Array.isArray(firstCompiled) && firstCompiled.length > 0
    ? (firstCompiled[0] as { kind?: string } | undefined)?.kind
    : undefined);
  const firstStepIsSameNav =
    steps.length > 0
    && firstStepKind === 'navigate'
    && (() => {
        const u = (Array.isArray(firstCompiled) && firstCompiled.length > 0
          ? (firstCompiled[0] as { url?: string }).url
          : undefined);
        return typeof u === 'string' && u === targetUrl;
      })();
  if (targetUrl && !firstStepIsSameNav) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // SPA 就绪等待：domcontentloaded 后 Vue/React SPA 还在异步加载 chunk + mount,
    // 此时探测 [name=...] / role 都会得到 count=0。实测 SOC 登录页在 domcontentloaded 后
    // ~300ms 表单才渲染完成；networkidle 是最稳的「JS 跑完 + DOM 渲染完」信号。
    // 5s 兜底（长连接页面等不到 idle 也不阻塞执行）；空文档（HTML-only）会立刻 idle。
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  }
  // preflight：执行前置检查（URL 可达 / 登录态 / 标签页 / origin）。失败不阻塞执行。
  try {
    const report = await preflight(page, { url: targetUrl ?? null, title: '' });
    onPreflight?.(report);
  } catch (e) {
    logger.warn({ err: e, caseId }, 'preflight failed; continuing');
  }
  const opts: DispatchOpts = { page, vars, ctx, caseId };
  // 回放 AI 降级开关（全局设置，runCase 层注入 ctx.aiFallback；缺省全关 = 保持既有失败语义）。
  const fallback = ctx.aiFallback ?? { compileMissing: false, locatorFailed: false };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const started = Date.now();
    opts.stepId = step.id;
    opts.hitSink = { current: null };
    opts.dbSink = { current: null };
    opts.logSink = { current: null };
    opts.httpSink = { current: null };
    opts.cacheSink = { current: false };
    const aiUsage = newAiUsage();
    opts.aiUsage = aiUsage;
    opts.healedSink = { current: false };
    const tabIndex =
      ctx.tabMap && step.tabRef ? Array.from(ctx.tabMap.keys()).indexOf(step.tabRef) : 0;
    const assertionAction = normalizeStepAssertion(step.assertion);
    try {
      if (step.delayMs) await opts.page.waitForTimeout(step.delayMs);
      // dispatcher 唯一回放路径:按 compiled 数组派原子步骤。
      // 1) compiled 为数组且非空 → 逐条派,收集 warning
      // 2) compiled 为空数组 / null / undefined → 未编译,抛 compile-missing
      let warning: string | undefined;
      let degraded = false;
      const compiled = (step as { compiled?: unknown }).compiled;
      if (Array.isArray(compiled) && compiled.length > 0) {
        for (const sub of compiled as StepAction[]) {
          const w = await dispatch(sub, opts);
          if (w && !warning) warning = w;
        }
      } else {
        // AI 降级（可选）：compiled 为空 + 全局开关开 + 有行级指令 → 指令临场执行；成功留 warning 照常过，
        // 失败维持原 compile-missing 语义（开关开但无 LLM / 指令含未定义变量 / AI 放弃都走这里）。
        const inst = step.instruction?.trim();
        if (fallback.compileMissing && inst) {
          const { value: instResolved, missing } = substituteVars(inst, vars);
          if (missing.length === 0) {
            try {
              const client = ctx.llmClient ?? (await resolveLlmClient()).client;
              const summary = await runAiTask(opts.page, instResolved, client, undefined, { onUsage: (r) => aiUsage.add(r) });
              degraded = true;
              warning = `未编译，AI 按指令临场执行${summary ? `：${summary}` : ''}`;
            } catch {
              // AI 不可用/失败 → 维持原 compile-missing 语义（下面 throw）
            }
          }
        }
        if (!warning) {
          throw new Error(`compile-missing: 第 ${step.order} 步未编译,请点击「AI 编译」生成 DSL`);
        }
      }
      // action 通过后才执行步骤级断言；断言失败同样记 failed 并终止后续。
      if (assertionAction) {
        await dispatch(assertionAction, opts);
      }
      // 验证码多轮验证：本步含 click（提交）且此前有验证码 aiTask 步骤时,按页面失败信号重试。
      if (ctx.captchaRetry) {
        const clickActions = (compiled as StepAction[]).filter((a) => a.kind === 'click');
        if (clickActions.length > 0) {
          const retryWarning = await runCaptchaRetry(opts, clickActions);
          if (retryWarning) warning = warning ? `${warning}; ${retryWarning}` : retryWarning;
        }
      }
      const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
      const passedResult: ExecStepResult = {
        order: step.order,
        status: 'passed',
        durationMs: Date.now() - started,
        warning,
        screenshot,
        hitLocator: opts.hitSink.current ?? undefined,
        tabIndex: tabIndex >= 0 ? tabIndex : 0,
        db: opts.dbSink.current ?? undefined,
        log: opts.logSink.current ?? undefined,
        http: opts.httpSink.current ?? undefined,
        ...(opts.cacheSink.current ? { cached: true } : {}),
        ...(aiUsage.stat.calls > 0 ? { aiUsage: aiUsage.stat } : {}),
        ...(opts.healedSink.current ? { healed: true } : {}),
        ...(degraded ? { degraded: true } : {}),
      };
      results.push(passedResult);
      onStep?.(passedResult);
    } catch (e) {
      const durationMs = Date.now() - started;
      const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
      // 断言失败时 classify 应拿到 assertion 的形态（若归类器关心 action.kind）；
      // 把实际跑的那条作为归类输入更准确——失败于 action 还是 assertion 一目了然。
      // 归类输入取 compiled[0]（未编译时为空,classify 对空 kind 走默认分支）。
      const compiledForClassify = (step as { compiled?: unknown }).compiled;
      const firstCompiledAction = (Array.isArray(compiledForClassify) && compiledForClassify.length > 0
        ? (compiledForClassify[0] as StepAction)
        : undefined);
      const failedAction = (assertionAction ?? firstCompiledAction);
      // 数据集敏感列脱敏：assertText 等错误信息带物化后的期望值（{{password}} 明文），
      // classify/humanMessage 可能复用 e.message —— 落报告前统一打码（非 Error 抛出物也走 String 后打码），闭环列级加密。
      let rawMsg = e instanceof Error ? e.message : String(e);
      if (ctx.sensitiveVarKeys && ctx.sensitiveVarKeys.length > 0) {
        rawMsg = maskSensitiveValues(rawMsg, vars, ctx.sensitiveVarKeys);
        if (e instanceof Error) e.message = rawMsg;
      }
      const classified = classify(e, { action: failedAction, durationMs });
      // AI 降级（可选）：元素识别失败（LocatorAllFailed）+ 全局开关开 + 有行级指令 → 用指令让 AI 整步重做。
      // 成功 → 步骤 passed + warning 标注（不置 healed，避免污染双通过率口径）；失败维持原 failedResult。
      // aiTask 步骤本就在跑 AI，元素识别失败时再“按指令临场执行”毫无增益 → 一律不降级，维持原失败。
      const inst = step.instruction?.trim();
      if (
        classified.reason === 'LocatorAllFailed'
        && fallback.locatorFailed
        && inst
        && failedAction?.kind !== 'aiTask'
      ) {
        const { value: instResolved, missing } = substituteVars(inst, vars);
        if (missing.length === 0) {
          let aiSummary: string | undefined;
          try {
            const client = ctx.llmClient ?? (await resolveLlmClient()).client;
            aiSummary = (await runAiTask(opts.page, instResolved, client, undefined, { onUsage: (r) => aiUsage.add(r) })) || undefined;
          } catch {
            // AI 不可用/失败 → 维持原 LocatorAllFailed 失败（走下方 failedResult）
          }
          if (aiSummary !== undefined) {
            const aiScreenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
            const aiPassed: ExecStepResult = {
              order: step.order,
              status: 'passed',
              durationMs: Date.now() - started,
              // 原机械失败原因（如 count=0 (css #gone)）一并带进 warning，报告页可看到“识别到什么程度失败”。
              warning: `元素识别失败（${rawMsg}），AI 按指令重做本步${aiSummary ? `：${aiSummary}` : ''}`,
              screenshot: aiScreenshot,
              hitLocator: opts.hitSink.current ?? undefined,
              tabIndex: tabIndex >= 0 ? tabIndex : 0,
              db: opts.dbSink.current ?? undefined,
              log: opts.logSink.current ?? undefined,
              http: opts.httpSink.current ?? undefined,
              ...(aiUsage.stat.calls > 0 ? { aiUsage: aiUsage.stat } : {}),
              degraded: true,
            };
            results.push(aiPassed);
            onStep?.(aiPassed);
            continue; // 本步降级通过，跳到下一 step（不走 break / onFailurePage）
          }
        }
      }
      const failedResult: ExecStepResult = {
        order: step.order,
        status: 'failed',
        durationMs,
        error: rawMsg,
        screenshot,
        failureReason: classified.reason,
        humanMessage: classified.humanMessage,
        hitLocator: opts.hitSink.current ?? undefined,
        tabIndex: tabIndex >= 0 ? tabIndex : 0,
        db: opts.dbSink.current ?? undefined,
        log: opts.logSink.current ?? undefined,
        http: opts.httpSink.current ?? undefined,
        ...(aiUsage.stat.calls > 0 ? { aiUsage: aiUsage.stat } : {}),
      };
      results.push(failedResult);
      onStep?.(failedResult);
      if (onFailurePage) await onFailurePage(opts.page, i).catch(() => undefined);
      // 失败立即终止，避免后续步骤被前一步污染的页面状态搞乱。
      break;
    }
  }
  // Track 1：用例级 vision 判定。所有 step.action 都通过后再做；走最终截图。
  // 若中途已 failed，vision 不再覆盖（避免 vision 误判把真失败洗白）。
  const failedSoFar = results.some((r) => r.status === 'failed');
  if (!failedSoFar && ctx.expectedOutcome && ctx.expectedOutcome.trim()) {
    const va = await runCaseVisionAssert({
      page: opts.page,
      reportId: ctx.reportId,
      caseTitle: ctx.caseTitle ?? caseId,
      caseUrl: ctx.caseUrl ?? null,
      expectedOutcome: ctx.expectedOutcome,
      vars,
      sensitiveVarKeys: ctx.sensitiveVarKeys ?? [],
      llmClient: ctx.llmClient,
    });
    if (va?.failureStep) {
      results.push(va.failureStep);
    } else if (va?.onLastPass) {
      const last = results[results.length - 1];
      if (last) last.visionAssert = { passed: true, ...va.onLastPass };
    }
  }
  return results;
}

/** 真实浏览器执行用例（playwright-core 驱动 chromium）。返回 step 粒度的执行结果。
 * onPreflight：执行前 preflight 检查报告的旁路回调（由 runCase 层决定是否落库），
 * 保持既有返回签名（ExecStepResult[]）不变以兼容既有调用方。
 * caseWindow/incognito：窗口策略与隐身模式；incognito 时不注入 storageState。 */
export async function executeCaseReal(
  caseId: string,
  steps: Array<{
    order: number;
    /** 可选步骤级断言（任意 StepAction 子集）；为 null/undefined 时跳过。 */
    assertion?: unknown;
    delayMs?: number | null;
    id?: string;
    tabRef?: string | null;
    componentKind?: string | null;
    sensitive?: boolean | null;
    /** 可执行 DSL 数组；回放唯一依据。空数组/null = 未编译,抛 compile-missing。 */
    compiled?: unknown[] | null;
    /** 行级自然语言指令；回放仅 AI 降级兜底用，机械回放不读。 */
    instruction?: string | null;
  }>,
  ctx: ExecContext,
  targetUrl?: string,
  storageState?: unknown,
  onPreflight?: (report: PreflightReport) => void,
  caseWindow?: CaseWindow,
  incognito?: boolean,
  onStep?: (r: ExecStepResult) => void,
): Promise<ExecStepResult[]> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    const viewport =
      caseWindow?.strategy === 'custom' && caseWindow.width && caseWindow.height
        ? { width: caseWindow.width, height: caseWindow.height }
        : caseWindow?.strategy === 'current'
          ? undefined
          : { width: 1280, height: 800 }; // maximize 近似值（headless）
    const context = await browser.newContext({
      ...(storageState && !incognito ? { storageState: storageState as never } : {}),
      ...(viewport ? { viewport } : {}),
      // 自签证书 / 内网 https 站点：执行期允许 ERR_CERT_AUTHORITY_INVALID 继续执行
      // （用户仍可在浏览器手动信任证书；这条只影响回放链路）。
      ignoreHTTPSErrors: true,
      // navigator.language 设成 zh-CN:被测系统多数为中文产品,i18next 会按浏览器语种渲染;
      // 暂硬编码,未来如需随 env/project 切换可挪到 envContext。
      locale: 'zh-CN',
    });
    return await runStepsInContext(caseId, steps, ctx, context, targetUrl, onPreflight, caseWindow, onStep);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/** 在调用方持有的 chromium + context 中跑用例步骤（用于 loginPrepare 链路共享登录态）。
 *  与 `executeCaseReal` 行为一致但跳过 launch / newContext / close —— context 已含登录 cookie，
 *  不再注入 storageState（覆盖会破坏登录态）；忽略 incognito（caller 持有的 ctx 已是登录态）。 */
export async function executeCaseInBrowser(
  caseId: string,
  steps: Array<{
    order: number;
    assertion?: unknown;
    delayMs?: number | null;
    id?: string;
    tabRef?: string | null;
    componentKind?: string | null;
    sensitive?: boolean | null;
    compiled?: unknown[] | null;
    /** 行级自然语言指令；回放仅 AI 降级兜底用，机械回放不读。 */
    instruction?: string | null;
  }>,
  ctx: ExecContext,
  browser: Browser,
  context: BrowserContext,
  targetUrl?: string,
  onPreflight?: (report: PreflightReport) => void,
  caseWindow?: CaseWindow,
  onStep?: (r: ExecStepResult) => void,
  onFailurePage?: (page: Page, failedIndex: number) => Promise<void>,
): Promise<ExecStepResult[]> {
  // 显式持有 browser 参数以便调用方阅读意图；执行路径不直接用 browser（context 已就绪）。
  void browser;
  return runStepsInContext(caseId, steps, ctx, context, targetUrl, onPreflight, caseWindow, onStep, onFailurePage);
}