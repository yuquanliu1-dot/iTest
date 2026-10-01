import { chromium, type Browser, type Page } from 'playwright-core';
import type { StepAction, Locator, IntentLocator } from '@itest/shared';
import { deepEqual, materializeValue } from '@itest/shared';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { testAttachments, testSteps } from '../db/schema.js';
import { decrypt } from '../lib/secret-crypto.js';
import { logger } from '../logger.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCandidates } from './locator-resolver.js';

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
}

interface DispatchOpts {
  page: Page;
  vars: Record<string, string>;
  ctx: ExecContext;
  /** 当前步骤 id（敏感填充解密用） */
  stepId?: string;
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
  switch (action.kind) {
    case 'navigate':
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return;
    case 'click':
      await (await tryFirstMatch(page, action.locator, action.intentLocator)).click({ timeout: 5000 });
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
        value = materializeValue(action.value, vars);
      }
      await (await tryFirstMatch(page, action.locator, action.intentLocator)).fill(value, { timeout: 5000 });
      return;
    }
    case 'hover':
      await (await tryFirstMatch(page, action.locator, undefined)).hover({ timeout: 5000 });
      return;
    case 'waitFor':
      await (await tryFirstMatch(page, action.locator, action.intentLocator)).waitFor({ state: 'visible', timeout: action.timeoutMs ?? 5000 });
      return;
    case 'assertVisible':
      if (!(await (await tryFirstMatch(page, action.locator, action.intentLocator)).isVisible({ timeout: 5000 }))) {
        throw new Error(`assertVisible failed: ${action.locator[0]?.value}`);
      }
      return;
    case 'assertText': {
      const a = action as StepAction & { kind: 'assertText' };
      const actual = await resolveAssertTextActual(page, a);
      const ok = matchAssertText(actual, a.equals, a.match ?? 'equals');
      if (!ok) {
        throw new Error(`assertText failed (${a.target ?? 'specifiedElement'}/${a.match ?? 'equals'}): expected ${JSON.stringify(a.equals)}, actual ${JSON.stringify(actual.slice(0, 100))}`);
      }
      return;
    }
    case 'assertJson': {
      const text = (await (await tryFirstMatch(page, action.locator, action.intentLocator)).innerText({ timeout: 5000 })).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`assertJson: 元素文本不是合法 JSON: ${text.slice(0, 100)}`);
      }
      if (!deepEqual(parsed, action.equals)) {
        throw new Error(`assertJson 深比较失败: 实际 ${text.slice(0, 100)}`);
      }
      return;
    }
    case 'screenshot':
      await page.screenshot({ path: action.name || 'snap' });
      return;
    case 'check': {
      const loc = await tryFirstMatch(page, action.locator, action.intentLocator);
      const current = await loc.isChecked({ timeout: 5000 });
      if (current !== action.checked) {
        if (action.checked) await loc.check({ timeout: 5000 });
        else await loc.uncheck({ timeout: 5000 });
      }
      return;
    }
    case 'select':
      await (await tryFirstMatch(page, action.locator, action.intentLocator)).selectOption(materializeValue(action.value, vars), { timeout: 5000 });
      return;
    case 'upload': {
      const meta = opts.ctx.attachmentResolver
        ? await opts.ctx.attachmentResolver(action.fileId)
        : await defaultAttachmentResolver(action.fileId, opts.ctx.projectId);
      if (!meta) throw new Error(`attachment-missing: ${action.fileId}`);
      await (await tryFirstMatch(page, action.locator, action.intentLocator)).setInputFiles(meta.storedPath, { timeout: 5000 });
      return;
    }
    case 'switchTab': {
      const target = opts.ctx.tabMap?.get(action.tabRef);
      if (!target) throw new Error(`tab-missing: ${action.tabRef}`);
      await target.bringToFront();
      // 后续步骤（含截图）都落在切换后的页面上。
      opts.page = target;
      return;
    }
    case 'extract': {
      const loc = await tryFirstMatch(page, action.locator, action.intentLocator);
      let text: string;
      try {
        text = await loc.inputValue({ timeout: 5000 });
      } catch {
        text = await loc.innerText({ timeout: 5000 });
      }
      vars[action.varName] = text.trim();
      return;
    }
    case 'aiStep': {
      if (!action.compiled) throw new Error('AI 步骤未编译');
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

/**
 * 三层定位候选顺序尝试；任一成功即返回。所有候选失败抛错。
 * 使用 buildCandidates 构造候选；优先用 intent.testid / contextText，再稳定 #id CSS，最后是 XPath / 其它 CSS。
 * 候选探测通过 count()，避免后续动作（如 click）抛错；text/role 路径可能没有 count()，接受即成功。
 */
async function tryFirstMatch(
  page: Page,
  locator: Locator[],
  intentLocator?: IntentLocator,
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
        if (n > 0) return c.loc;
        lastErr = new Error(`count=0 (${c.kind})`);
      } catch (e) {
        lastErr = e;
      }
      continue;
    }
    // 没有 count()（如 getByText 路径）直接接受
    return c.loc;
  }
  throw lastErr instanceof Error ? lastErr : new Error('all locator candidates failed');
}

/** resolveAssertTextActual: 根据 action.target 决定 actual 字符串的来源。 */
async function resolveAssertTextActual(
  page: Page,
  action: StepAction & { kind: 'assertText' },
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
  const loc = await tryFirstMatch(page, action.locator, action.intentLocator);
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

/** 真实浏览器执行用例（playwright-core 驱动 chromium）。返回 step 粒度的执行结果。 */
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
): Promise<ExecStepResult[]> {
  let browser: Browser | undefined;
  const results: ExecStepResult[] = [];
  const vars: Record<string, string> = {};
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    const context = await browser.newContext(
      storageState ? { storageState: storageState as never } : undefined,
    );
    const page = await context.newPage();
    // 导航到第一个 navigate 动作或外部传入的 targetUrl，否则就让用户先 navigate。
    if (targetUrl) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    const opts: DispatchOpts = { page, vars, ctx };
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const started = Date.now();
      opts.stepId = step.id;
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
        });
      } catch (e) {
        const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, opts.page);
        results.push({
          order: step.order,
          status: 'failed',
          durationMs: Date.now() - started,
          error: e instanceof Error ? e.message : String(e),
          screenshot,
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

/** 占位截图：CDP 未启用或浏览器启动失败时回退到 mock 路径。 */
export async function writePlaceholderScreenshot(reportId: string, stepIndex: number): Promise<string> {
  const TRANSPARENT_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
    'base64',
  );
  const dir = join(SCREENSHOTS_DIR, reportId);
  await mkdir(dir, { recursive: true });
  const filename = `step-${stepIndex}.png`;
  await writeFile(join(dir, filename), TRANSPARENT_PNG);
  return `/screenshots/${reportId}/${filename}`;
}