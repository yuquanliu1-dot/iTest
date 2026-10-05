import type { Page } from 'playwright-core';
import type { LLMClient } from '../agent/llm-client.js';
import { tryParseJson } from '../agent/llm-client.js';
import { logger } from '../logger.js';

/** 单条指令的最大对话轮数（每轮一次 LLM 调用）。 */
const MAX_TURNS = 8;
/** 每轮喂给 LLM 的可交互元素上限，防止提示词膨胀。 */
const MAX_ELEMENTS = 60;

const SYSTEM_PROMPT = `你是 Web 测试执行智能体，在真实浏览器里执行一条自然语言测试指令。
每轮你会收到：当前页面 URL、可交互元素列表、一张截图（整页，或你上轮请求的元素放大图）。
只输出 JSON，不要输出其他内容。格式：
{"actions": [...], "done": false, "summary": "一句话进展"}
actions 元素类型：
- {"type":"click","selector":"<css>"}
- {"type":"fill","selector":"<css>","value":"<最终文本>"}（React 受控表单已特殊处理，直接给最终值即可）
- {"type":"press","key":"Enter|Tab|Escape|ArrowDown|..."}
- {"type":"wait","ms":<毫秒>}
- {"type":"screenshot","selector":"<css>"}　请求该元素的 4 倍放大白底截图，下轮会作为附图发给你
结束方式（二选一）：
- 指令已完成：{"done": true, "summary": "做了什么"}
- 无法完成：{"fail": "原因"}（会立即终止并记为该步骤失败）
规则：
- 优先用元素列表里给的 selector；列表没有时可自拟（优先 #id、[name=]、[placeholder=]、[role=]，避免脆弱的长 class 链）。
- 验证码/图形文字：先 screenshot 放大验证码图片，下轮逐字符仔细辨认。字符集为字母+数字（绝不出现 0 O o 1 l I），不区分大小写，通常 4 位，有随机旋转和干扰线。识别结果 fill 进对应输入框。
- 每轮动作要保守，最多 6 个；每个动作的执行结果（ok / 错误信息）下轮反馈给你，出错就换 selector 重试。
- 需要引用平台变量时用 {{varName}}（平台会替换为实际值）。`;

interface ElementInfo {
  selector: string;
  tag: string;
  text?: string;
  placeholder?: string;
  inputType?: string;
  disabled?: boolean;
}

/** 提取页面可交互元素的精简清单（供 LLM 选 selector）。 */
async function dumpElements(page: Page): Promise<ElementInfo[]> {
  const raw = (await page.evaluate(() => {
    const out: Array<Record<string, unknown>> = [];
    const els = document.querySelectorAll(
      'button, input, textarea, select, a[href], [role="button"], [role="link"], [role="textbox"], [role="combobox"], [tabindex]:not([tabindex="-1"])',
    );
    for (const el of Array.from(els).slice(0, 200)) {
      const he = el as HTMLElement;
      const r = he.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const style = window.getComputedStyle(he);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const id = he.id ? `#${CSS.escape(he.id)}` : '';
      const name = he.getAttribute('name');
      const ph = he.getAttribute('placeholder');
      const role = he.getAttribute('role');
      let selector = id;
      if (!selector && name) selector = `${he.tagName.toLowerCase()}[name="${name}"]`;
      if (!selector && ph) selector = `${he.tagName.toLowerCase()}[placeholder="${ph}"]`;
      if (!selector && role) selector = `[role="${role}"]`;
      if (!selector) {
        const cls = (he.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        selector = cls ? `${he.tagName.toLowerCase()}.${cls}` : he.tagName.toLowerCase();
      }
      const text = (he.textContent ?? '').trim().slice(0, 40);
      const item: Record<string, unknown> = { selector, tag: he.tagName.toLowerCase() };
      if (text) item.text = text;
      if (ph) item.placeholder = ph;
      const it = (he as HTMLInputElement).type;
      if (he.tagName === 'INPUT' && it) item.inputType = it;
      if ((he as HTMLButtonElement).disabled) item.disabled = true;
      out.push(item);
      if (out.length >= 60) break;
    }
    return out;
  })) as Array<Record<string, unknown>>;
  return raw as unknown as ElementInfo[];
}

type AiAction =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'press'; key: string }
  | { type: 'wait'; ms: number }
  | { type: 'screenshot'; selector: string };

function parseAction(a: unknown): AiAction | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const type = String(o.type ?? '');
  if (type === 'click' && typeof o.selector === 'string') return { type, selector: o.selector };
  if (type === 'fill' && typeof o.selector === 'string' && typeof o.value === 'string') return { type, selector: o.selector, value: o.value };
  if (type === 'press' && typeof o.key === 'string') return { type, key: o.key };
  if (type === 'wait' && typeof o.ms === 'number') return { type, ms: Math.min(Math.max(o.ms, 0), 10000) };
  if (type === 'screenshot' && typeof o.selector === 'string') return { type, selector: o.selector };
  return null;
}

/** 执行单个动作，返回给人/LLM 的结果描述。 */
async function execAction(page: Page, action: AiAction): Promise<string> {
  switch (action.type) {
    case 'click': {
      await page.locator(action.selector).first().click({ timeout: 5000, force: true });
      return `click ${action.selector}: ok`;
    }
    case 'fill': {
      const loc = page.locator(action.selector).first();
      await loc.fill('', { timeout: 5000 });
      await loc.pressSequentially(action.value, { delay: 20 });
      return `fill ${action.selector}: ok`;
    }
    case 'press': {
      await page.keyboard.press(action.key as never);
      return `press ${action.key}: ok`;
    }
    case 'wait': {
      await page.waitForTimeout(action.ms);
      return `wait ${action.ms}: ok`;
    }
    case 'screenshot': {
      // 不在这里截图：标记后由主循环在下一轮开头截 4x 白底图
      return `screenshot ${action.selector}: 已接受，下轮附图`;
    }
  }
}

/** 元素 4x 白底截图（验证码小图识别用），失败返回 null（回退整页截图）。 */
async function shotElement(page: Page, selector: string): Promise<Buffer | null> {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: 3000 });
    await el.evaluate((e) => {
      (e as HTMLElement).style.zoom = '4';
      (e as HTMLElement).style.background = '#fff';
    }).catch(() => undefined);
    try {
      return await el.screenshot({ timeout: 3000 });
    } finally {
      await el.evaluate((e) => {
        (e as HTMLElement).style.zoom = '';
        (e as HTMLElement).style.background = '';
      }).catch(() => undefined);
    }
  } catch {
    return null;
  }
}

/**
 * 运行时 LLM 智能步骤：多轮「截图+元素清单 → LLM 决策 → 执行 → 反馈」循环，
 * 直到 LLM 声明完成/放弃或超过轮数上限。返回 done summary（用于步骤 warning）。
 */
export async function runAiTask(page: Page, instruction: string, client: LLMClient): Promise<string> {
  let lastResults: string[] = [];
  let pendingShot: string | null = null;
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    let buffer: Buffer | null = null;
    let imageNote = '';
    if (pendingShot) {
      buffer = await shotElement(page, pendingShot);
      if (buffer) imageNote = `附图：你上轮请求的元素 ${pendingShot} 的 4 倍放大白底截图（请仔细逐字符辨认）。\n`;
      pendingShot = null;
    }
    if (!buffer) {
      buffer = await page.screenshot({ timeout: 5000 });
    }
    let elements: ElementInfo[] = [];
    try {
      elements = await dumpElements(page);
    } catch (e) {
      logger.warn({ err: e }, 'aiTask dumpElements failed; continuing without element list');
    }
    const userMessage = [
      `指令：${instruction}`,
      `当前 URL：${page.url()}`,
      imageNote,
      `可交互元素（JSON，selector 可直接用于动作）：${JSON.stringify(elements.slice(0, MAX_ELEMENTS))}`,
      lastResults.length > 0 ? `上轮动作结果：\n${lastResults.join('\n')}` : '（首轮，无历史动作）',
      `第 ${turn}/${MAX_TURNS} 轮。`,
    ].join('\n');
    const r = await client.complete({
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      image: { base64: buffer.toString('base64'), mime: 'image/png' },
    });
    const raw = r.kind === 'json' ? JSON.stringify(r.value) : r.value;
    const parsed = tryParseJson(raw);
    if (!parsed) {
      lastResults = ['[system] 你的输出不是合法 JSON，请只输出 JSON 对象。'];
      continue;
    }
    if (typeof parsed.fail === 'string' && parsed.fail.trim()) {
      throw new Error(`aiTask 放弃：${parsed.fail.trim()}`);
    }
    if (parsed.done === true) {
      return typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    }
    const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
      .map(parseAction)
      .filter((a): a is AiAction => a !== null)
      .slice(0, 6);
    lastResults = [];
    for (const a of actions) {
      if (a.type === 'screenshot') {
        pendingShot = a.selector;
        lastResults.push(`screenshot ${a.selector}: 已接受，下轮附图`);
        continue;
      }
      try {
        lastResults.push(await execAction(page, a));
      } catch (e) {
        lastResults.push(`${a.type} ${'selector' in a ? a.selector : ''}: error ${e instanceof Error ? e.message.slice(0, 150) : String(e)}`);
      }
    }
    if (actions.length === 0) {
      lastResults.push('[system] 没有可执行的动作（actions 为空）。如需结束请输出 done 或 fail。');
    }
  }
  throw new Error(`aiTask 超过 ${MAX_TURNS} 轮未完成：${instruction.slice(0, 80)}`);
}
