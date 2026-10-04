/**
 * 抓取被测页面并提取可交互元素清单，供 inspect_page 工具把"页面实际代码"
 * 注入 LLM 上下文。launch 模式与 execute/cdp.ts 一致（CHROMIUM_PATH 覆盖），
 * DOM 提取沿用 domFallback.ts 的 page.evaluate 注入惯例。
 * 防护：仅 http/https + goto 超时 + 元素数/输出长度上限（内网被测地址是核心场景，不做私网拦截）。
 */
import { chromium } from 'playwright-core';

const GOTO_TIMEOUT_MS = 20_000;
const SETTLE_MS = 800;
const MAX_ELEMENTS = 300;
const MAX_OUTPUT_CHARS = 30_000;

/**
 * DOM 提取必须以字符串表达式传给 page.evaluate：tsx/esbuild(keepNames) 会往编译后的
 * 函数体注入 __name(...) 辅助调用，Playwright 按 fn.toString() 序列化回调送到浏览器
 * 执行时浏览器里没有 __name，直接 ReferenceError。字符串形式原样求值，不受影响。
 */
const EXTRACT_JS = `(() => {
  const maxElements = ${MAX_ELEMENTS};
  const title = document.title || '';
  const nodes = document.querySelectorAll(
    'a, button, input, select, textarea, summary, [contenteditable="true"], [role], [data-testid]',
  );
  const visible = (el) => {
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const pick = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const tid = el.getAttribute('data-testid');
    if (tid) return '[data-testid="' + tid + '"]';
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    const aria = el.getAttribute('aria-label');
    if (aria) return el.tagName.toLowerCase() + '[aria-label="' + aria + '"]';
    const text = (el.innerText || el.getAttribute('placeholder') || '').trim().slice(0, 30);
    if (text) return 'text=' + text;
    return el.tagName.toLowerCase();
  };
  const elements = [];
  for (const el of Array.from(nodes)) {
    if (elements.length >= maxElements) break;
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const id = el.id ? '#' + el.id : '';
    const name = el.getAttribute('name');
    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    const placeholder = el.getAttribute('placeholder');
    const aria = el.getAttribute('aria-label');
    const role = el.getAttribute('role');
    const parts = [
      '- ' + tag + id + (type ? '[type=' + type + ']' : ''),
      name ? 'name=' + name : '',
      role ? 'role=' + role : '',
      text ? '"' + text + '"' : '',
      placeholder ? 'placeholder="' + placeholder + '"' : '',
      aria ? 'aria-label="' + aria + '"' : '',
      '选择器: ' + pick(el),
    ].filter(Boolean);
    elements.push(parts.join(' '));
  }
  return { title, elements, truncated: nodes.length > maxElements };
})()`;

export async function inspectPage(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL 无法解析: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅支持 http/https，收到 ${url.protocol}`);
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    const extracted = (await page.evaluate(EXTRACT_JS)) as {
      title: string;
      elements: string[];
      truncated: boolean;
    };

    const lines = [
      `页面: ${url.toString()}`,
      `标题: ${extracted.title || '(无)'}`,
      '注意: 此快照仅为页面初始状态。点击/提交后才出现的元素（结果区、错误提示等）不在清单中——断言这类元素必须先触发相应操作，或断言清单中其稳定的父容器；清单里不存在的 testid/id 绝对禁止编造。',
      `可交互元素 (${extracted.elements.length}${extracted.truncated ? `，已截断至 ${MAX_ELEMENTS}` : ''}):`,
      ...extracted.elements,
    ];
    let out = lines.join('\n');
    if (out.length > MAX_OUTPUT_CHARS) out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n…(输出超长已截断)`;
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}
