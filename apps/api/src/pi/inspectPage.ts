/**
 * 抓取被测页面并提取可交互元素清单，供 inspect_page 工具把"页面实际代码"
 * 注入 LLM 上下文。launch 模式与 execute/cdp.ts 一致（CHROMIUM_PATH 覆盖），
 * DOM 提取沿用 domFallback.ts 的 page.evaluate 注入惯例。
 * 防护：仅 http/https + goto 超时 + 元素数/输出长度上限（内网被测地址是核心场景，不做私网拦截）。
 * extractPageElements 供 verify_case 失败页快照复用。
 */
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';

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
  const bodyLen = document.body ? document.body.innerText.length : 0;
  return { title, bodyLen, elements, truncated: nodes.length > maxElements };
})()`;

export interface PageElementSnapshot {
  url: string;
  title: string;
  bodyLen: number;
  elements: string[];
  truncated: boolean;
}

export type PageQuality = 'ok' | 'low';

/** 页面抓取质量自评:判断"抓到的是真实功能页还是空壳/错误页",供 inspect_page 告知模型 URL 是否可信。
 *  判据是页面自身特征(可交互元素数 / body 文本长度),不绑定任何具体目标系统——
 *  空壳页(登录外壳、404、未挂载的微前端容器)在任意系统都表现为这两项极低。
 *  阈值:可交互元素 < 5 或 body 文本 < 100 字符判为低质量。 */
export function assessPageQuality(snap: Pick<PageElementSnapshot, 'title' | 'bodyLen' | 'elements'>): PageQuality {
  if (snap.elements.length < 5 || snap.bodyLen < 100) return 'low';
  return 'ok';
}

/** 在已打开的页面上提取可交互元素清单（inspect_page 与 verify_case 失败页快照共用）。 */
export async function extractPageElements(page: Page, url?: string): Promise<PageElementSnapshot> {
  const extracted = (await page.evaluate(EXTRACT_JS)) as { title: string; bodyLen: number; elements: string[]; truncated: boolean };
  return { url: url ?? page.url(), title: extracted.title, bodyLen: extracted.bodyLen, elements: extracted.elements, truncated: extracted.truncated };
}

/** 失败页结构证据：阻断性浮层清单。
 *
 *  2026-10-17 归因重构后，missingIds（期望容器缺失判定）退役：它靠解析 css strategy 的
 *  #id/[id=] 形态提取期望容器，换 text=/role/xpath/testId 就失效（打地鼠路线）。容器是否缺席
 *  改为由 failureDiagnosis.probeLocatorHits 对每条 locator 候选做实时命中探测（形态无关）+ 元素清单
 *  联合交给 LLM 归因。此处只保留浮层清单：只凭角色/类名特征（role=dialog、class 含
 *  dialog/drawer/message-box/modal/popup/mask/overlay），不绑定任何具体系统的文案——
 *  「可能弹、可能不弹」的条件性浮层（草稿恢复、权限确认）在任何系统都表现为这类 DOM 特征。
 */
export interface PageEvidence {
  /** 覆盖页面上、可能遮挡交互的浮层（弹窗/抽屉/遮罩）。每条：标签 + 可定位选择器 + 文本片段 */
  overlays: Array<{ tag: string; selector: string; text: string }>;
}

/** 浮层候选选择器：覆盖常见的模态/抽屉/消息框/遮罩实现。只用 DOM 特征，不写具体文案。 */
const EVIDENCE_OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [class*="dialog"], [class*="drawer"], [class*="message-box"], ' +
  '[class*="modal"], [class*="popup"], [class*="mask"], [class*="overlay"]';

/** keepNames 约束（同 EXTRACT_JS）：返回字符串表达式原样送浏览器求值，避免 __name 辅助函数注入。 */
const EVIDENCE_JS = `(() => {
  const nodes = document.querySelectorAll('${EVIDENCE_OVERLAY_SELECTOR}');
  const seen = new Set();
  const overlays = [];
  for (const el of Array.from(nodes)) {
    if (overlays.length >= 5) break;
    const rects = el.getClientRects();
    if (rects.length === 0) continue;
    const r = rects[0];
    if (r.width < 20 || r.height < 20) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className : '')
      .split(/\\s+/).filter(Boolean).slice(0, 3).map((c) => '.' + CSS.escape(c)).join('');
    const sel = tag + (el.id ? '#' + CSS.escape(el.id) : cls);
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const key = sel + '|' + text.slice(0, 20);
    if (seen.has(key)) continue;
    seen.add(key);
    overlays.push({ tag, selector: sel, text });
  }
  return { overlays };
})()`;

/** 在已打开的页面上采集结构证据（verify_case / solidify_case 失败页复用）。异常一律静默降级为空证据。 */
export async function extractPageEvidence(page: Page): Promise<PageEvidence> {
  try {
    return (await page.evaluate(EVIDENCE_JS)) as PageEvidence;
  } catch {
    return { overlays: [] };
  }
}

export async function inspectPage(rawUrl: string, opts?: { storageState?: unknown }): Promise<string> {
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
    // 内网被测环境普遍用自签名证书,必须忽略校验,否则 inspect_page 在核心场景下不可用
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      ...(opts?.storageState ? { storageState: opts.storageState as never } : {}),
    });
    const page = await context.newPage();
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    const snap = await extractPageElements(page, url.toString());
    const quality = assessPageQuality(snap);
    const qualityLine = quality === 'low'
      ? `抓取质量: 低(可交互元素 ${snap.elements.length} 个,正文 ${snap.bodyLen} 字符)——该 URL 可能无效、是空壳页(未渲染的微前端容器)、登录页或 404。请勿基于此清单编造用例,先核对 URL 是否正确;若不确定,跟用户确认目标页面的真实路径。`
      : `抓取质量: 正常(可交互元素 ${snap.elements.length} 个,正文 ${snap.bodyLen} 字符)`;
    const lines = [
      `页面: ${url.toString()}`,
      `标题: ${snap.title || '(无)'}`,
      qualityLine,
      '注意: 此快照仅为页面初始状态。点击/提交后才出现的元素（结果区、错误提示等）不在清单中——断言这类元素必须先触发相应操作，或断言清单中其稳定的父容器；清单里不存在的 testid/id 绝对禁止编造。',
      `可交互元素 (${snap.elements.length}${snap.truncated ? `，已截断至 ${MAX_ELEMENTS}` : ''}):`,
      ...snap.elements,
    ];
    let out = lines.join('\n');
    if (out.length > MAX_OUTPUT_CHARS) out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n…(输出超长已截断)`;
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}
