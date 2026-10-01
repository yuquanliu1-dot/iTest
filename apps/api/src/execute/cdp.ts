import { chromium, type Browser, type Page } from 'playwright-core';
import type {
  StepAction,
  Locator,
  IntentLocator,
  FailureReason,
  PreflightReport,
  HitLocator,
  WindowStrategy,
} from '@itest/shared';
import { deepEqual, materializeValue, substituteVars } from '@itest/shared';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testAttachments, testSteps } from '../db/schema.js';
import { decrypt } from '../lib/secret-crypto.js';
import { logger } from '../logger.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCandidates } from './locator-resolver.js';
import { waitForStable, ElementNotStable } from './stability.js';
import { classify } from './failureClassifier.js';
import { preflight } from './preflight.js';
import { domClick, domFill, domCheck, domSelect } from './domFallback.js';

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
  /** 记录本步命中的定位 kind/value（由 tryFirstMatch 写入） */
  hitSink?: { current: HitLocator | null };
}

/** 交互动作：执行前先做稳定性检查 */
const INTERACTIVE_KINDS: ReadonlyArray<StepAction['kind']> = ['click', 'fill', 'check', 'select', 'upload'];
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
      return domFill(page, action.locator, materializeValue(action.value ?? '', vars));
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

function locatorToPlaywright(page: Page, loc: Locator) {
  // 按 strategy 顺序尝试：testId → role → text → css/xpath。
  // 真实项目中应做 role[name=...] 等语义解析；这里取最宽松可达成的形式。
  switch (loc.strategy) {
    case 'testId': {
      const v = loc.value.startsWith('[') ? loc.value : `[data-testid="${loc.value}"]`;
      return page.locator(v);
    }
    case 'role': {
      // value 形如 'button[name="登录"]' 或裸 'button'
      const m = loc.value.match(/^([\w-]+)(?:\[name="([^"]*)"\]|\[name='([^']*)'\])$/);
      if (m) {
        const [, role, name1, name2] = m;
        return page.getByRole(role as never, { name: name1 ?? name2 ?? undefined });
      }
      return page.getByRole(loc.value as never);
    }
    case 'text':
      return page.getByText(loc.value);
    case 'css':
      return page.locator(loc.value);
    case 'xpath':
      return page.locator(`xpath=${loc.value}`);
  }
}

/** 执行单步；返回 warning 文本（无则 undefined）。失败抛错由调用方记 failed。 */
async function dispatch(action: StepAction, opts: DispatchOpts): Promise<string | undefined> {
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
      return;
    }
    case 'click':
      await (await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink)).click({ timeout: 5000 });
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
        value = materializeValue(action.value, vars);
      }
      await (await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink)).fill(value, { timeout: 5000 });
      return;
    }
    case 'hover':
      await (await tryFirstMatch(page, action.locator, undefined, opts.hitSink)).hover({ timeout: 5000 });
      return;
    case 'waitFor':
      await (await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink)).waitFor({ state: 'visible', timeout: action.timeoutMs ?? 5000 });
      return;
    case 'assertVisible':
      if (!(await (await tryFirstMatch(page, action.locator, action.intentLocator, opts.hitSink)).isVisible({ timeout: 5000 }))) {
        throw new Error(`assertVisible failed: ${action.locator[0]?.value}`);
      }
      return;
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
    case 'aiStep': {
      if (!action.compiled) throw new Error('AI 步骤未编译');
      const { missing } = substituteVars(action.instruction, vars);
      if (missing.length > 0) {
        throw new Error(`var-missing: {{${missing[0]!}}} (template="${action.instruction}")`);
      }
      for (const sub of action.compiled) {
        await dispatch(sub, opts);
      }
      return;
    }
  }
}

/** 多个 locator 候选中取第一个能解析的——避免主候选失效时直接报错。 */
function firstMatch(page: Page, locators: Locator[]) {
  if (locators.length === 0) throw new Error('locator array is empty');
  return locatorToPlaywright(page, locators[0]!);
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
  const cands = buildCandidates(page, { locator, intentLocator });
  if (cands.length === 0) {
    throw new Error('locator array is empty');
  }
  let lastErr: unknown;
  for (const c of cands) {
    const probe = c.loc as unknown as { count?: () => Promise<number>; isVisible?: () => Promise<boolean> };
    if (probe && typeof probe.count === 'function') {
      try {
        const n = await probe.count();
        if (n > 0) {
          if (hitSink) hitSink.current = { kind: c.kind, value: locatorForCandidate(locator, intentLocator, c.kind) };
          return c.loc;
        }
        lastErr = new Error(`count=0 (${c.kind})`);
      } catch (e) {
        lastErr = e;
      }
      continue;
    }
    // 没有 count()（如 getByText 路径）直接接受
    if (hitSink) hitSink.current = { kind: c.kind, value: locatorForCandidate(locator, intentLocator, c.kind) };
    return c.loc;
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

async function writeStepScreenshot(reportId: string, stepIndex: number, page: Page): Promise<string | undefined> {
  try {
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

/** 真实浏览器执行用例（playwright-core 驱动 chromium）。返回 step 粒度的执行结果。
 * onPreflight：执行前 preflight 检查报告的旁路回调（由 runCase 层决定是否落库），
 * 保持既有返回签名（ExecStepResult[]）不变以兼容既有调用方。
 * caseWindow/incognito：窗口策略与隐身模式；incognito 时不注入 storageState。 */
export async function executeCaseReal(
  caseId: string,
  steps: Array<{
    order: number;
    action: unknown;
    delayMs?: number | null;
    id?: string;
    tabRef?: string | null;
    componentKind?: string | null;
    sensitive?: boolean | null;
  }>,
  ctx: ExecContext,
  targetUrl?: string,
  storageState?: unknown,
  onPreflight?: (report: PreflightReport) => void,
  caseWindow?: CaseWindow,
  incognito?: boolean,
): Promise<ExecStepResult[]> {
  let browser: Browser | undefined;
  const results: ExecStepResult[] = [];
  const vars: Record<string, string> = {};
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
    });
    const page = await context.newPage();
    // 导航到第一个 navigate 动作或外部传入的 targetUrl，否则就让用户先 navigate。
    if (targetUrl) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    // preflight：执行前置检查（URL 可达 / 登录态 / 标签页 / origin）。失败不阻塞执行。
    try {
      const report = await preflight(page, { url: targetUrl ?? null, title: '' });
      onPreflight?.(report);
    } catch (e) {
      logger.warn({ err: e, caseId }, 'preflight failed; continuing');
    }
    const opts: DispatchOpts = { page, vars, ctx };
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const started = Date.now();
      opts.stepId = step.id;
      opts.hitSink = { current: null };
      const tabIndex =
        ctx.tabMap && step.tabRef ? Array.from(ctx.tabMap.keys()).indexOf(step.tabRef) : 0;
      try {
        if (step.delayMs) await opts.page.waitForTimeout(step.delayMs);
        const warning = await dispatch(step.action as StepAction, opts);
        const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
        results.push({
          order: step.order,
          status: 'passed',
          durationMs: Date.now() - started,
          warning,
          screenshot,
          hitLocator: opts.hitSink.current ?? undefined,
          tabIndex: tabIndex >= 0 ? tabIndex : 0,
        });
      } catch (e) {
        const durationMs = Date.now() - started;
        const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
        const classified = classify(e, { action: step.action as StepAction, durationMs });
        results.push({
          order: step.order,
          status: 'failed',
          durationMs,
          error: e instanceof Error ? e.message : String(e),
          screenshot,
          failureReason: classified.reason,
          humanMessage: classified.humanMessage,
          hitLocator: opts.hitSink.current ?? undefined,
          tabIndex: tabIndex >= 0 ? tabIndex : 0,
        });
        // 失败立即终止，避免后续步骤被前一步污染的页面状态搞乱。
        break;
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
  return results;
}