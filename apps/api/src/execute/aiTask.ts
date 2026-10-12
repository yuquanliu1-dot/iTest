import type { Page } from 'playwright-core';
import type { LLMClient } from '../agent/llm-client.js';
import { tryParseJson } from '../agent/llm-client.js';
import type { AiUsageAddend } from './aiUsage.js';
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
- {"type":"navigate","url":"<绝对地址>"}（仅 http/https 绝对地址）
- {"type":"screenshot","selector":"<css>"}　请求该元素的 4 倍放大白底截图，下轮会作为附图发给你
结束方式（二选一）：
- 指令已完成：{"done": true, "summary": "做了什么"}
- 无法完成：{"fail": "原因"}（会立即终止并记为该步骤失败）
规则：
- 优先用元素列表里给的 selector；列表没有时可自拟（优先 #id、[name=]、[placeholder=]、[role=]，避免脆弱的长 class 链）。
- 验证码/图形文字：先 screenshot 放大验证码图片，下轮逐字符仔细辨认。字符集为字母+数字（绝不出现 0 O o 1 l I），不区分大小写，通常 4 位，有随机旋转和干扰线。识别结果 fill 进对应输入框。
- 每轮动作要保守，最多 6 个；每个动作的执行结果（ok / 错误信息）下轮反馈给你，出错就换 selector 重试。
- 需要引用平台变量时用 {{varName}}（平台会替换为实际值）。`;

const MOBILE_SYSTEM_PROMPT = `你是移动端测试执行智能体，在 iOS Simulator / Android Emulator 上执行自然语言测试指令。
可观测：当前 accessibility tree（节点含 accessibilityId / label / role / bounds）、当前屏幕截图。
只输出 JSON，格式：
{"actions": [...], "done": false, "summary": "一句话进展"}
actions 元素类型：
- {"type":"tap","accessibilityId":"..."} 或 {"label":"..."}（优先 accessibilityId）
- {"type":"fill","accessibilityId":"...","value":"..."}
- {"type":"swipe","from":{"accessibilityId":"..."},"to":{"accessibilityId":"..."},"durationMs":500}
- {"type":"setAppearance","mode":"light"|"dark"}
- {"type":"setNetwork","state":"online"|"offline"|"airplane"}
- {"type":"setLocation","latitude":<float>,"longitude":<float>}
- {"type":"home"} / {"type":"appBack"} / {"type":"appRestart"} / {"type":"appOpen","bundleId":"..."}
- {"type":"wait","ms":<毫秒>}
- {"type":"screenshot","accessibilityId":"..."}　请求该节点 4 倍放大截图，下轮附图发给你
结束方式（二选一）：
- 指令已完成：{"done": true, "summary": "做了什么"}
- 无法完成：{"fail": "原因"}
规则：
- 节点中心坐标取 bounds 中心；不要做坐标绝对计算。
- 每轮动作要保守，最多 6 个；每个动作结果下轮反馈给你，出错就换 accessibilityId / label 重试。
- 屏幕中可能同时存在多个相同 label 的节点，命中歧义时优先选 accessibilityId。`;

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

export type AiAction =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'press'; key: string }
  | { type: 'wait'; ms: number }
  | { type: 'navigate'; url: string }
  | { type: 'screenshot'; selector: string };

// AI 相凭据占位符协议：verify_case / solidify_case 的提示词要求 LLM 把用户名/密码/
// 敏感字段 fill 成这三个字面量，执行时刻由 valueSub 替换为真实值。协议常量定义在
// execute 层（valueSub 语义所在地），pi 工具层从这里取用。
export const USER_PH = '__ITEST_USERNAME__';
export const PASSWORD_PH = '__ITEST_PASSWORD__';
export const SECRET_PH = '__ITEST_STEP_SECRET__';

function parseAction(a: unknown): AiAction | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const type = String(o.type ?? '');
  if (type === 'click' && typeof o.selector === 'string') return { type, selector: o.selector };
  if (type === 'fill' && typeof o.selector === 'string' && typeof o.value === 'string') return { type, selector: o.selector, value: o.value };
  if (type === 'press' && typeof o.key === 'string') return { type, key: o.key };
  if (type === 'wait' && typeof o.ms === 'number') return { type, ms: Math.min(Math.max(o.ms, 0), 10000) };
  if (type === 'navigate' && typeof o.url === 'string' && /^https?:\/\//.test(o.url)) return { type, url: o.url };
  if (type === 'screenshot' && typeof o.selector === 'string') return { type, selector: o.selector };
  return null;
}

/** 执行单个动作，返回给人/LLM 的结果描述。
 *  valueSub：fill value 执行前替换（占位符 → 真实凭据）；发生替换后反馈不回显真实值。 */
async function execAction(page: Page, action: AiAction, valueSub?: (v: string) => string): Promise<string> {
  switch (action.type) {
    case 'click': {
      await page.locator(action.selector).first().click({ timeout: 5000, force: true });
      return `click ${action.selector}: ok`;
    }
    case 'fill': {
      const loc = page.locator(action.selector).first();
      const realValue = valueSub ? valueSub(action.value) : action.value;
      const substituted = realValue !== action.value;
      await loc.fill('', { timeout: 5000 });
      await loc.pressSequentially(realValue, { delay: 20 });
      // React 受控表单常在 blur 时才提交 state / 触发校验；与 cdp.ts dispatch fill 保持一致。
      await page.keyboard.press('Tab').catch(() => undefined);
      // 简短停顿让 onChange/blur 事件落地（Antd 等库在 blur 后异步校验）。
      await page.waitForTimeout(80);
      // 回读确认：若 DOM value 与目标不一致，把实际值反馈给 LLM 以便下轮修正。
      const actual = await loc.inputValue({ timeout: 3000 }).catch(() => '');
      if (actual !== realValue) {
        // 发生替换（凭据类 fill）时不回显 actual/目标值——防密码片段泄漏回 LLM。
        if (substituted) return `fill ${action.selector}: 实际值与目标不一致（实际值长度 ${actual.length}）`;
        return `fill ${action.selector}: 实际值 "${actual}" 与目标 "${action.value}" 不一致`;
      }
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
    case 'navigate': {
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      // 与 init-goto 对齐：等 SPA hydrate，长连接页面 5s 兜底不阻塞。
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      return `navigate ${action.url}: ok`;
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

/** 验证码类指令判定（录制器产物 instruction 固定为「识别验证码图片中的字符并填入验证码输入框」）。 */
export const CAPTCHA_TASK_RE = /验证码|captcha/i;

/** 提交后页面出现验证码校验失败提示的可观测信号（识别错误 / 过期都由被测系统提示，笼统匹配）。 */
const CAPTCHA_FAIL_RE = /验证码.{0,12}(错误|过期|不正确|失效)|captcha[\s\S]{0,16}(invalid|expired|incorrect)/i;

export async function detectCaptchaFailure(page: Page): Promise<boolean> {
  try {
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    return CAPTCHA_FAIL_RE.test(text);
  } catch {
    return false;
  }
}

const CAPTCHA_OCR_PROMPT = `你是验证码识别器。仔细辨认图片中的每个字符（注意随机旋转、干扰线、删除线），只输出 JSON：{"text":"<字符>"}。
规则：字符集为字母+数字；绝不出现 0 O o 1 l I；不区分大小写；通常是 4 位。没有把握时输出 {"fail":"原因"}。`;

/**
 * 验证码单轮识别：页内启发式定位「验证码图 + 配套输入框」→ 4x 截图 → 一次 vision 调用 → 填入。
 * 供「多轮验证」重试使用——重试要抢在验证码 TTL 内完成，必须快（一次 LLM 往返 ~10s），
 * 不走通用 runAiTask 的多轮 Agent 回路（实测 31s）。任何一步失败抛错，由调用方决定回落。
 * hint：录制时的语义定位（data-testid / name），有则优先精确命中输入框。
 * 注意：evaluate 回调内不能有嵌套函数声明（tsx esbuild keepNames 陷阱）。
 */
export async function solveCaptchaOnce(
  page: Page,
  client: LLMClient,
  hint?: string | null,
  onUsage?: (r: AiUsageAddend) => void,
): Promise<string> {
  const pair = await page.evaluateHandle((h) => {
    if (h) {
      const els = Array.from(document.querySelectorAll('input, textarea'));
      for (const el of els) {
        if (el.getAttribute('data-testid') === h || el.getAttribute('name') === h || el.id === h) {
          let scope: Element | null = el;
          for (let i = 0; i < 4 && scope; i++) {
            const imgs = scope.querySelectorAll ? Array.from(scope.querySelectorAll('img')) : [];
            for (const img of imgs) {
              const r = (img as HTMLElement).getBoundingClientRect();
              if (r.width >= 40 && r.height >= 16 && r.width <= 400 && r.height <= 200) return { img, input: el };
            }
            scope = scope.parentElement;
          }
          return { img: null, input: el };
        }
      }
    }
    const imgs = Array.from(document.querySelectorAll('img'));
    for (const img of imgs) {
      const r = (img as HTMLElement).getBoundingClientRect();
      if (!(r.width >= 40 && r.height >= 16 && r.width <= 400 && r.height <= 200)) continue;
      let scope: Element | null = img.parentElement;
      for (let i = 0; i < 4 && scope; i++) {
        const inputs = scope.querySelectorAll ? Array.from(scope.querySelectorAll('input, textarea')) : [];
        for (const el of inputs) {
          const t = (el.getAttribute('type') || '').toLowerCase();
          if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'file') continue;
          return { img, input: el };
        }
        scope = scope.parentElement;
      }
    }
    return null;
  }, hint ?? null);
  const inputHandle = await pair.evaluateHandle((p) => p?.input ?? null);
  const inputEl = inputHandle.asElement();
  if (!inputEl) throw new Error('未找到验证码输入框');
  const imgHandle = await pair.evaluateHandle((p) => p?.img ?? null);
  const imgEl = imgHandle.asElement();

  let buffer: Buffer | null = null;
  if (imgEl) {
    await imgEl.evaluate((e) => {
      (e as HTMLElement).style.zoom = '4';
      (e as HTMLElement).style.background = '#fff';
    }).catch(() => undefined);
    try {
      buffer = await imgEl.screenshot({ timeout: 3000 });
    } catch {
      buffer = null;
    } finally {
      await imgEl.evaluate((e) => {
        (e as HTMLElement).style.zoom = '';
        (e as HTMLElement).style.background = '';
      }).catch(() => undefined);
    }
  }
  if (!buffer) buffer = await page.screenshot({ timeout: 5000 });

  const r = await client.complete({
    systemPrompt: CAPTCHA_OCR_PROMPT,
    userMessage: '识别这张验证码图片中的字符。',
    image: { base64: buffer.toString('base64'), mime: 'image/png' },
  });
  onUsage?.(r);
  const raw = r.kind === 'json' ? JSON.stringify(r.value) : r.value;
  const parsed = tryParseJson(raw);
  const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
  if (!/^[a-z0-9]{3,6}$/i.test(text)) throw new Error(`验证码识别结果非法: ${raw.slice(0, 80)}`);

  await inputEl.fill('', { timeout: 5000 });
  await inputEl.type(text, { delay: 20 });
  return `已识别验证码为 ${text} 并填入`;
}

/** runAiTask 可选项。 */
export interface RunAiTaskOpts {
  /** 对话轮数上限（缺省 MAX_TURNS=8）。 */
  maxTurns?: number;
  /** fill value 执行前替换（占位符 → 真实凭据）；替换后错误反馈不回显真实值。 */
  valueSub?: (v: string) => string;
  /** 每个动作执行后回调（ok = 未抛错）。solidify_case 用它收集 AI 实际操作过的元素。 */
  onAction?: (action: AiAction, ok: boolean) => void;
  /** 每轮 LLM complete 后回调（usage/durationMs/model 透传，供 aiUsage 累加）。 */
  onUsage?: (r: AiUsageAddend) => void;
}

/**
 * 运行时 LLM 智能步骤：多轮「截图+元素清单 → LLM 决策 → 执行 → 反馈」循环，
 * 直到 LLM 声明完成/放弃或超过轮数上限。返回 done summary（用于步骤 warning）。
 * mobile=true 时改用移动端系统提示词（accessibility tree / tap / swipe / app 控制）。
 * opts.maxTurns：轮数上限覆盖（verify_case 逐步执行用 5）；opts.valueSub：凭据占位符替换。
 */
export async function runAiTask(
  page: Page,
  instruction: string,
  client: LLMClient,
  mobile?: boolean,
  opts?: RunAiTaskOpts,
): Promise<string> {
  const maxTurns = opts?.maxTurns ?? MAX_TURNS;
  const systemPrompt = mobile ? MOBILE_SYSTEM_PROMPT : SYSTEM_PROMPT;
  let lastResults: string[] = [];
  let pendingShot: string | null = null;
  for (let turn = 1; turn <= maxTurns; turn++) {
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
      `第 ${turn}/${maxTurns} 轮。`,
    ].join('\n');
    const r = await client.complete({
      systemPrompt,
      userMessage,
      image: { base64: buffer.toString('base64'), mime: 'image/png' },
    });
    opts?.onUsage?.(r);
    const raw = r.kind === 'json' ? JSON.stringify(r.value) : r.value;
    const parsed = tryParseJson(raw);
    if (!parsed) {
      lastResults = ['[system] 你的输出不是合法 JSON，请只输出 JSON 对象。'];
      continue;
    }
    if (typeof parsed.fail === 'string' && parsed.fail.trim()) {
      throw new Error(`aiTask 放弃：${parsed.fail.trim()}`);
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
        opts?.onAction?.(a, true);
        continue;
      }
      try {
        lastResults.push(await execAction(page, a, opts?.valueSub));
        opts?.onAction?.(a, true);
      } catch (e) {
        opts?.onAction?.(a, false);
        const target = 'selector' in a ? a.selector : 'url' in a ? a.url : '';
        lastResults.push(`${a.type} ${target}: error ${e instanceof Error ? e.message.slice(0, 150) : String(e)}`);
      }
    }
    if (actions.length === 0) {
      lastResults.push('[system] 没有可执行的动作（actions 为空）。如需结束请输出 done 或 fail。');
    }
    // 先执行动作再结束：LLM 可能在 done 响应里携带最终动作（如 fill 验证码）。
    if (parsed.done === true) {
      return typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    }
  }
  throw new Error(`aiTask 超过 ${maxTurns} 轮未完成：${instruction.slice(0, 80)}`);
}
