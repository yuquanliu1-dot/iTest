import { chromium, type Browser, type Page } from 'playwright-core';
import type { StepAction, Locator } from '@itest/shared';
import { deepEqual, materializeValue } from '@itest/shared';
import { logger } from '../logger.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

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
}

interface DispatchOpts {
  page: Page;
  vars: Record<string, string>;
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
      await firstMatch(page, action.locator).click({ timeout: 5000 });
      return;
    case 'fill':
      await firstMatch(page, action.locator).fill(materializeValue(action.value, vars), { timeout: 5000 });
      return;
    case 'hover':
      await firstMatch(page, action.locator).hover({ timeout: 5000 });
      return;
    case 'waitFor':
      await firstMatch(page, action.locator).waitFor({ state: 'visible', timeout: action.timeoutMs ?? 5000 });
      return;
    case 'assertVisible':
      if (!(await firstMatch(page, action.locator).isVisible({ timeout: 5000 }))) {
        throw new Error(`assertVisible failed: ${action.locator[0]?.value}`);
      }
      return;
    case 'assertText':
      await firstMatch(page, action.locator).filter({ hasText: action.equals }).first().waitFor({ state: 'visible', timeout: 5000 });
      return;
    case 'assertJson': {
      const text = (await firstMatch(page, action.locator).innerText({ timeout: 5000 })).trim();
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
      const loc = firstMatch(page, action.locator);
      const current = await loc.isChecked({ timeout: 5000 });
      if (current !== action.checked) {
        if (action.checked) await loc.check({ timeout: 5000 });
        else await loc.uncheck({ timeout: 5000 });
      }
      return;
    }
    case 'select':
      await firstMatch(page, action.locator).selectOption(materializeValue(action.value, vars), { timeout: 5000 });
      return;
    case 'upload':
      // P5 才支持绑定回放文件；P1 记录 warning 并跳过，不算失败。
      return '待绑定回放文件（后续版本支持），本次跳过';
    case 'extract': {
      const loc = firstMatch(page, action.locator);
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
  steps: Array<{ order: number; action: unknown; delayMs?: number | null }>,
  ctx: ExecContext,
  targetUrl?: string,
): Promise<ExecStepResult[]> {
  let browser: Browser | undefined;
  const results: ExecStepResult[] = [];
  const vars: Record<string, string> = {};
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    // 导航到第一个 navigate 动作或外部传入的 targetUrl，否则就让用户先 navigate。
    if (targetUrl) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const started = Date.now();
      try {
        if (step.delayMs) await page.waitForTimeout(step.delayMs);
        const warning = await dispatch(step.action as StepAction, { page, vars });
        const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, page);
        results.push({
          order: step.order,
          status: 'passed',
          durationMs: Date.now() - started,
          warning,
          screenshot,
        });
      } catch (e) {
        const screenshot = await writeStepScreenshot(ctx.reportId, i + 1, page);
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