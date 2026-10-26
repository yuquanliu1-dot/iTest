import type { Page } from 'playwright-core';
import type { LLMClient, LLMMessage } from '../agent/llm-client.js';
import { tryParseJson } from '../agent/llm-client.js';
import { aiLangFrom, type AiLang } from '../agent/langDirective.js';
import { VAR_NAME_RE, type StepAction } from '@itest/shared';
import type { AiUsageAddend } from './aiUsage.js';
import { logger } from '../logger.js';
import { annotateAction, clearAnnotation } from './liveView.js';
import { waitForPageSettled } from './pageSettle.js';

/** 单条指令的最大对话轮数（每轮一次 LLM 调用）。 */
const MAX_TURNS = 8;
/** 每轮喂给 LLM 的可交互元素上限，防止提示词膨胀。 */
const MAX_ELEMENTS = 60;

/** 系统提示词主体（不含凭据段）。凭据段按需拼接——见 assembleSystemPrompt。 */
const SYSTEM_PROMPT_BASE = `你是 Web 测试执行智能体，在真实浏览器里执行一条自然语言测试指令。
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
- 优先用元素列表里给的 selector；列表没有时可自拟（优先 #id、[name=]、[placeholder=]、[role=]，避免脆弱的长 class 链）。selector 只能是普通 CSS 或 text=文本；禁止 :has-text()、:has()、:near()、>> 链、nth= 等 Playwright 专有语法（平台固化映射不认，会拖垮固化率）——按文本找元素用 text=文本。
- 验证码/图形文字：先 screenshot 放大验证码图片，下轮逐字符仔细辨认。字符集为字母+数字（绝不出现 0 O o 1 l I），不区分大小写，通常 4 位，有随机旋转和干扰线。识别结果 fill 进对应输入框。
- 每轮动作要保守，最多 6 个；每个动作的执行结果（ok / 错误信息）下轮反馈给你，出错就换 selector 重试。
- 页面状态自检：每轮先看「当前 URL + 截图/元素清单」确认自己是否在指令期望的界面上。若目标元素连续 2 个动作都找不到，优先怀疑「页面不在期望界面」（入口/步骤错位、被弹窗或中间态挡住、导航没生效），不要再换 selector 空转——在 summary 里如实写明「当前 URL/可见界面与指令场景的差异」，需要时用 navigate / 点击返回 / 处理弹窗先回到正确界面。只有确认页面就在期望界面、纯粹是元素描述不准时，才换 selector 重试。
- 数据忠实：不得改写或覆盖指令、数据集或前置步骤已填入的表单值（含账号/密码等输入内容）。输入看起来异常（超长、特殊字符、疑似无效）也原样照填——异常输入往往正是测试目的本身。页面状态自检只用于回到正确界面/找对元素，不用于"修正"表单内容。`;

/** 凭据规则：仅在本次步骤确实需要凭据能力时才拼进系统提示词。 */
const CREDENTIAL_RULE = `- 凭据（用户名/密码）：fill 的 value 用字面量 __ITEST_USERNAME@服务名__ / __ITEST_PASSWORD@服务名__（服务名取自下方资源清单里的 name；平台在填入的瞬间替换为真实值）；不要输出 {{}} 变量模板，平台不替换模板。`;

/**
 * 拼装系统提示词。
 *  credEnabled=false → 完全不含凭据段：AI 看不到占位符形态，就不会拿凭据去重填账号/密码框
 *  （2026-10-26 prod228 实测：含凭据段时 AI 会主动 fill __ITEST_USERNAME@web__；不含则只填字面量）。
 *  mobile 版不拼凭据段（移动端无 web 凭据语义）。
 */
export function assembleSystemPrompt(opts: { mobile?: boolean; credEnabled: boolean; manifest: string }): string {
  if (opts.mobile) return MOBILE_SYSTEM_PROMPT;
  const base = SYSTEM_PROMPT_BASE;
  if (!opts.credEnabled) return base;
  const manifest = opts.manifest.trim();
  const credentialHint = manifest
    ? `${manifest}\n不写 @服务名 时用标注「默认」的那个。清单里「未配置凭据」的服务不要尝试登录（必然失败）。`
    : '用户名输入框 fill 的 value 用字面量 __ITEST_USERNAME__，密码用 __ITEST_PASSWORD__（平台在填入的瞬间替换为真实值）。';
  return `${base}\n${CREDENTIAL_RULE}\n${credentialHint}`;
}

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

// ── 凭据占位符识别与替换（AI 相 fill 值统一协议）──────────────────────────────
export type CredentialKind = 'user' | 'password' | 'secret';

/** 解析结果：kind + 归属 web 服务 name（null = 未指定，走三级默认链）。 */
export interface ParsedCredential { kind: CredentialKind; ref: string | null }

/** @ref 段合法性：与 shared 的 VAR_NAME_RE 同口径（字母/数字/下划线，字母或下划线开头，≤64）。 */
export function isValidCredentialRef(ref: string): boolean {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 64 && VAR_NAME_RE.test(ref);
}

const KIND_BY_NAME: Record<string, CredentialKind> = {
  ITEST_USERNAME: 'user',
  ITEST_PASSWORD: 'password',
  ITEST_STEP_SECRET: 'secret',
};

/**
 * 解析凭据占位符：__ITEST_USERNAME@backend__ / {{ITEST_USERNAME@backend}} /
 * {{__ITEST_USERNAME@backend__}} / 无 ref 的既有形态。
 * 裸名（无哨兵/花括号包裹）不认，避免把普通文本误判成凭据；
 * ref 段非法则整个占位符判否，绝不退化成"无 ref"（那会静默取到默认 web 的账号）。
 * secret 与 web 无关（步骤级密文），其 @ 段被忽略。
 */
export function parseCredentialPlaceholder(raw: string): ParsedCredential | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  let inner: string;
  if (t.startsWith('{{') && t.endsWith('}}')) inner = t.slice(2, -2).trim();
  else if (t.startsWith('__') && t.endsWith('__')) inner = t.slice(2, -2);
  else return null;
  const at = inner.indexOf('@');
  const head = (at >= 0 ? inner.slice(0, at) : inner).replace(/^_+|_+$/g, '');
  const ref = at >= 0 ? inner.slice(at + 1).replace(/^_+|_+$/g, '') : null;
  const kind = KIND_BY_NAME[head.toUpperCase()];
  if (!kind) return null;
  if (ref === null || kind === 'secret') return { kind, ref: null };
  return isValidCredentialRef(ref) ? { kind, ref } : null;
}

/** 只要 kind 的便捷包装（固化判定等只需知道"是不是凭据"）。 */
export function credentialPlaceholderKind(raw: string): CredentialKind | null {
  return parseCredentialPlaceholder(raw)?.kind ?? null;
}

/** 渲染占位符，供提示词拼装（避免各处硬编码字面量拼错）。 */
export function credentialPlaceholder(kind: CredentialKind, ref?: string | null): string {
  const base = kind === 'user' ? USER_PH : kind === 'password' ? PASSWORD_PH : SECRET_PH;
  if (!ref || kind === 'secret') return base;
  return `${base.slice(0, -2)}@${ref}__`;
}

const CREDENTIAL_REF_RE = /(?:\{\{\s*)?_{0,2}ITEST_(?:USERNAME|PASSWORD|STEP_SECRET)_{0,2}(?:@[A-Za-z_][A-Za-z0-9_]*)?(?:\s*\}\})?/;

/** 自由文本是否引用了凭据占位符（任意形态：哨兵 / 花括号 / 裸名 / 带 @ref）。
 *  用途：substituteVars 的 missing 过滤（凭据不来自数据集 vars）+ 环境凭据前置检查。 */
export function referencesCredential(text: string): boolean {
  return CREDENTIAL_REF_RE.test(text);
}

/** 凭据来源：无 ref 的默认值 + 按 web 服务 name 取值的回调（两者皆空即缺失）。 */
export interface CredentialSource {
  /** 无 ref 占位符的默认来源（既有调用方零改动）。 */
  user?: string | null;
  password?: string | null;
  secret?: string | null;
  /**
   * 按 web 服务 name 取该服务的凭据；返回 null = 该 ref 无凭据 → 回落到上面的默认值。
   * 注意：由环境派生的实现（buildCredentialSource）在落空时**抛命名错误**而非返回 null——
   * 显式 @ref 写错服务名时静默用默认服务的凭据，会把测试登到另一个系统上。
   */
  byRef?: (ref: string) => { user?: string | null; password?: string | null } | null;
  /**
   * 显式 @ref 解析不到时是否判死（不回落默认链）。
   * 通用实现缺省 false（回落默认）；环境派生的实现置 true——写错服务名却静默用
   * 默认服务的凭据 = 把测试登到另一个系统上。
   */
  strictRef?: boolean;
  /** 错误消息用：环境显示名（缺失资源要点名，用户靠它排查）。 */
  envName?: string | null;
  /** 错误消息用：无 ref 占位符的默认归属 web 服务名。 */
  defaultRef?: string | null;
}

/**
 * AI 相 / 机械相共用的 fill 值替换器：把凭据占位符（哨兵 / 花括号 / @ref 任意形态）
 * 换成真实值；非占位符原样返回。缺凭据 → 抛 EnvMissing/SecretMissing 命名错误，
 * 错误消息点名缺失的 web 服务，绝不把占位符原样敲进表单（2026-10-21 prod228 实测：
 * 占位符原样进登录表单必败，AI 换 selector 空转烧掉 12+ 次 LLM 调用）。
 */
export function makeCredentialValueSub(src: CredentialSource): (v: string) => string {
  return (v: string): string => {
    const parsed = parseCredentialPlaceholder(v);
    if (!parsed) return v;
    const { kind, ref } = parsed;
    let real: string | null | undefined;
    if (ref && src.byRef) {
      const hit = src.byRef(ref);
      if (hit === null && src.strictRef) {
        // 显式点名的 web 服务不存在或未配凭据 → 判死，绝不回落默认链（会登到别的系统）。
        throw missingCredential(src, kind, ref);
      }
      real = kind === 'user' ? hit?.user : hit?.password;
      if (src.strictRef && (real === undefined || real === null)) {
        throw missingCredential(src, kind, ref);
      }
    }
    if (real === undefined || real === null) real = kind === 'user' ? src.user : kind === 'password' ? src.password : src.secret;
    if (!real) throw missingCredential(src, kind, ref);
    return real;
  };
}

/** 命名错误构造：EnvMissing（环境凭据）/ SecretMissing（步骤密文）。 */
function missingCredential(src: CredentialSource, kind: CredentialKind, ref: string | null): Error {
  const ph = credentialPlaceholder(kind, ref);
  const e = new Error(
    kind === 'secret'
      ? `secret-missing: 步骤引用了 ${ph}，但本步没有可用的敏感值（需 sensitive 步骤密文）`
      : `env-missing: 用例步骤引用了 ${ph}，但${envLabel(src)}的${refLabel(src, ref)}未配置用户名/密码（请到项目设置→测试环境配置）`,
  );
  e.name = kind === 'secret' ? 'SecretMissing' : 'EnvMissing';
  return e;
}

/** 错误消息里的环境标识。 */
function envLabel(src: CredentialSource): string {
  return src.envName ? `环境「${src.envName}」` : '当前环境';
}

/** 错误消息里的归属服务标识：显式 @ref 优先，其次默认归属。 */
function refLabel(src: CredentialSource, ref: string | null): string {
  const name = ref ?? src.defaultRef ?? null;
  return name ? `web 服务 ${name}` : '默认 web 服务';
}

/** 扫描文本里所有凭据占位符出现（供前置检查逐个解析）。带 @ref 的形态整体匹配。 */
export const CREDENTIAL_PLACEHOLDER_SCAN = /__?ITEST_(?:USERNAME|PASSWORD|STEP_SECRET)@?[A-Za-z0-9_]*__?|\{\{\s*_*ITEST_(?:USERNAME|PASSWORD|STEP_SECRET)@?[A-Za-z0-9_ ]*_*\s*\}\}/g;

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

/** 用 LLM 判断页面是否展示了验证码失败提示（任何措辞：不合法/未通过/无效/识别失败/已过期等）。
 *  替代旧的正则 detectCaptchaFailure——正则无法覆盖被测系统各异的错误文案。
 *  best-effort：LLM 调用失败时返回 false（不比旧行为差）。 */
export async function isCaptchaFailed(
  page: Page,
  client: LLMClient,
  onUsage?: (r: AiUsageAddend) => void,
): Promise<boolean> {
  try {
    await waitForPageSettled(page, { timeoutMs: 3000, settleMs: 300 });
    const buffer = await page.screenshot({ timeout: 5000 });
    const r = await client.complete({
      systemPrompt: `你是验证码状态检测器。判断这张截图中是否展示了验证码校验失败的提示（任何措辞：不合法/未通过/无效/识别失败/已过期/错误等）。只输出 JSON：{"failed":true} 或 {"failed":false}。没有失败提示或提示与验证码无关时输出 {"failed":false}。`,
      userMessage: '判断这张截图是否有验证码失败提示。',
      image: { base64: buffer.toString('base64'), mime: 'image/png' },
    });
    onUsage?.(r);
    const parsed = tryParseJson(r.kind === 'json' ? JSON.stringify(r.value) : r.value);
    return parsed?.failed === true;
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
  if (!buffer) {
    // 整页兜底截图：等渲染稳定再拍，避免验证码图已就位但整页仍在骨架/接口回填时拍到过渡帧。
    // 用较短预算（验证码 TTL 敏感），超时按当前帧继续。
    await waitForPageSettled(page, { timeoutMs: 4000, settleMs: 300 });
    buffer = await page.screenshot({ timeout: 5000 });
  }

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

/** 机械步骤动作 → 人类可读语义（供 AI 降级时说明「这一步本意是什么」）。 */
function describeAction(a: StepAction): string {
  const loc = (x: StepAction): string => {
    const l = (x as { locator?: Array<{ strategy: string; value: string }> }).locator ?? [];
    return l.map((c) => `${c.strategy}=${c.value}`).join(' | ') || '(无定位)';
  };
  switch (a.kind) {
    case 'waitFor': {
      const t = (a as { timeoutMs?: number }).timeoutMs;
      return `等待 ${loc(a)} 出现${t ? `（最多 ${t}ms）` : ''}`;
    }
    case 'assertVisible': return `断言 ${loc(a)} 可见`;
    case 'assertText': return `断言 ${loc(a)} 文本匹配`;
    case 'assertJson': return `断言 ${loc(a)} JSON 匹配`;
    case 'click': return `点击 ${loc(a)}`;
    case 'fill': return `填写 ${loc(a)}`;
    case 'hover': return `悬停 ${loc(a)}`;
    case 'check': return `勾选 ${loc(a)}`;
    case 'select': return `选择 ${loc(a)}`;
    case 'upload': return `上传 ${loc(a)}`;
    case 'navigate': return `访问 ${(a as { url?: string }).url ?? ''}`;
    case 'screenshot': return `截图 ${loc(a)}`;
    default: return a.kind;
  }
}

/** 步骤的机械语义分类：决定降级时给 AI 哪条守则。 */
export type DegradeStepType = 'observe' | 'interact' | 'unknown';

/** 观察类动作：只看不碰。 */
const OBSERVE_KINDS = new Set(['waitFor', 'assertVisible', 'assertText', 'assertJson', 'screenshot', 'extract']);
/** 交互类动作：会改页面状态。 */
const INTERACT_KINDS = new Set(['click', 'fill', 'check', 'select', 'upload', 'navigate', 'press', 'hover']);

/**
 * 按机械语义给步骤分类。
 *
 * observe（waitFor / assertVisible / assertText / assertJson / screenshot / extract）——本步只要求
 *   「看到某现象」：降级时 AI 不得填值、不得重复提交、不得为诱发现象而改页面（prod228 实测：
 *   AI 造了个错验证码 + 重复提交，把预期的错误提示造了出来，负向用例假通过）。
 * interact（click/fill 等）——本步本来就要改页面：降级时 AI 可以动手，但不得改写前置步骤
 *   已填入的值（数据忠实）、不得重复执行刚失败的那次交互（重复提交会造出现象、掩盖真实失败）。
 * unknown——无机械动作（纯自然语言步）：按 observe 处理，指令文字就是意图。
 */
export function classifyDegradeStep(input: { compiled: unknown; failedAction?: unknown }): DegradeStepType {
  const actions: StepAction[] = [];
  if (Array.isArray(input.compiled)) actions.push(...(input.compiled as StepAction[]));
  const failed = input.failedAction as StepAction | undefined;
  if (failed) actions.push(failed);
  if (actions.length === 0) return 'unknown';
  // 有交互类动作 → interact；只有观察类 → observe。
  if (actions.some((a) => INTERACT_KINDS.has(a.kind))) return 'interact';
  if (actions.some((a) => OBSERVE_KINDS.has(a.kind))) return 'observe';
  return 'unknown';
}

/** 各分类对应的降级守则（提示词层约束，非机械拦截）。 */
function degradeGuard(stepType: DegradeStepType): string[] {
  // unknown（纯自然语言步）按 observe 处理：这类步没有机械语义兜底，AI 的自由度最大，
  // 而「只观察」的约束正是防止它为诱发预期现象而造数据的关键。
  if (stepType === 'observe' || stepType === 'unknown') {
    return [
      '  【本步是观察步——严格限制】上面的机械动作只要求「看到某现象」。你只能观察并如实报告'
      + '此刻看到什么：不得填入任何值、不得点击任何会触发业务动作的按钮、不得重复提交、'
      + '不得为诱发该现象而改动页面。看到就报达成；没看到就如实报失败（fail + 说明实际看到'
      + '了什么）——这是正确结果，不是失败。造出来的现象不构成证据。',
    ];
  }
  return [
    '  【本步是交互步——有限授权】本步本意就是要操作页面，你可以动手，但必须守住两条：'
    + '① 不得改写指令、数据集或前置步骤已填入的表单值（那会改变测试前提，异常输入本身往往'
    + '就是测试目的）；② 不得重复执行刚刚失败的那次交互（重复提交会造出现象、把真实失败掩盖'
    + '成通过）。若重复执行仍无法让本步意图达成，如实报失败并说明实际观察到的状态。',
  ];
}

/**
 * 机械失败后的 AI 降级上下文：把「这一步本意的机械动作」和「机械实际结果」一起告诉 AI。
 *
 * 背景（2026-10-26 prod228 实测）：降级路径原本只传自然语言指令，AI 拿到的是「让错误提示出现」
 * 这个目标 + 一整套改页面的动作，却不知道机械语义是「等某文本出现 10s」、也不知道机械已经
 * 等满并确认没出现。AI 于是填了个编造的错验证码 + 重复提交，**把预期现象造了出来**，
 * 负向用例因此假通过。
 *
 * 有了机械语义 + 机械结果 + 按步类型的守则，AI 能判断「本步是观察步、等了 10s 没等到」，
 * 配合守则如实报告未达成。
 */
export function buildDegradeContext(input: {
  compiled: unknown;
  /** 实际失败的那条动作（可能是步骤级断言，不在 compiled 里）。缺省时只描述 compiled。 */
  failedAction?: unknown;
  /** 机械失败原因；缺省表示「本步无机械动作可失败」（未编译的纯自然语言步）。 */
  mechanicalError?: string;
}): string {
  const compiled = Array.isArray(input.compiled) ? (input.compiled as StepAction[]) : [];
  const semantics = compiled.map(describeAction);
  // 断言不在 compiled 里（compiled 只有动作，断言是步骤级字段）——失败在断言上时补一条，
  // 否则 AI 看到的语义与真实失败点对不上。
  const failed = input.failedAction as StepAction | undefined;
  if (failed && !semantics.includes(describeAction(failed))) {
    semantics.push(`${describeAction(failed)}（实际失败于这条）`);
  }
  const stepType = classifyDegradeStep({ compiled: input.compiled, failedAction: input.failedAction });
  return [
    '【本步机械语义】',
    semantics.length > 0 ? semantics.map((s, i) => `  ${i + 1}. ${s}`).join('\n') : '  (本步无机械动作——这是一条纯自然语言步骤，语义完全来自下面的指令文字)',
    '【机械执行结果】',
    ...(input.mechanicalError ? [`  失败：${input.mechanicalError}`] : ['  (本步无机械动作，未编译)']),
    '【判定要求】',
    ...(semantics.length > 0
      ? ['  上面的机械动作就是本步的测试意图。机械已经执行过并失败——你的任务是判断失败原因、'
          + '在不违背本步意图的前提下继续，而不是让机械失败的现象「出现」。']
      : ['  指令文字就是本步的测试意图。按它要观察的现象去观察，不要为了让现象出现而动手改页面。']),
    ...degradeGuard(stepType),
  ].join('\n');
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
  /** 界面语言：缺省 zh-CN（执行路径无用户上下文时确定性回落）。 */
  lang?: AiLang;
  /** web 资源清单（name / origin / 有无凭据）文本，由调用方用 renderWebResourceManifest 渲染。 */
  resourceManifest?: string;
  /** 降级上下文：本步的机械语义 + 机械失败原因（buildDegradeContext 渲染）。缺省不传。 */
  degradeContext?: string;
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
  const lang = aiLangFrom(opts?.lang);
  // 资源清单进系统提示词：模型据此知道有哪些 web 服务、哪些配了凭据、该用哪个 @name。
  // 无清单时保留旧的固定文案（调用方无环境上下文，行为不变）。
  const manifest = opts?.resourceManifest?.trim() ?? '';
  // 凭据能力 = 挂了 valueSub（真值替换通道）。没挂 → 提示词里完全不提凭据，
  // AI 看不到占位符形态，就不会拿凭据去重填账号/密码框（2026-10-26 prod228 实测：
  // 含凭据段时 AI 会主动 fill __ITEST_USERNAME@web__，不含则只填字面量）。
  const credEnabled = !!opts?.valueSub;
  const systemPrompt = assembleSystemPrompt({ mobile, credEnabled, manifest });
  // 凭据替换留痕：只记次数、不记真值（真值绝不回显给 LLM/日志）。
  let credSubCount = 0;
  const valueSub = opts?.valueSub
    ? (v: string): string => {
        const real = opts.valueSub!(v);
        if (real !== v) credSubCount++;
        return real;
      }
    : undefined;
  let lastResults: string[] = [];
  let pendingShot: string | null = null;
  // 多轮累积：每轮把「本轮 user（+截图）」与「上轮 LLM 原始输出」追加到 history，
  // 请求时整段回传。缓存按前缀匹配，只发当轮会让第 1..N-1 轮内容彻底消失、
  // 每轮都从零建缓存（2026-10-14 网关实测命中率 2%）；累积后第 2 轮起可命中
  // 全部历史前缀（实测 86~94%）。assistant 侧回放原始 JSON 输出而非 lastResults 摘要，
  // 以保证与"当轮实际收到的上下文"逐字一致、缓存前缀不漂移。
  const history: LLMMessage[] = [];
  for (let turn = 1; turn <= maxTurns; turn++) {
    let buffer: Buffer | null = null;
    let imageNote = '';
    if (pendingShot) {
      buffer = await shotElement(page, pendingShot);
      if (buffer) imageNote = `附图：你上轮请求的元素 ${pendingShot} 的 4 倍放大白底截图（请仔细逐字符辨认）。\n`;
      pendingShot = null;
    }
    if (!buffer) {
      // 全页截图超时降级：微前端子应用切换时页面持续重绘/字体慢加载，page.screenshot
      // 等 stable 会 5s 超时抛错。这里不能让它炸掉整个 AI 步骤——重试一次，仍失败则
      // 无图继续本轮（LLM 靠元素清单也能操作），并在下轮结果里标注无图原因。
      buffer = await page.screenshot({ timeout: 5000 }).catch(() => null);
      if (!buffer) {
        buffer = await page.screenshot({ timeout: 5000 }).catch(() => null);
        if (!buffer) imageNote = '（本轮页面截图超时，无附图；请依赖下方元素清单操作）\n';
      }
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
      opts?.degradeContext ? opts.degradeContext : '',
      lastResults.length > 0 ? `上轮动作结果：\n${lastResults.join('\n')}` : '（首轮，无历史动作）',
      `第 ${turn}/${maxTurns} 轮。`,
    ].filter(Boolean).join('\n');
    // 截图放在文本之前：与单轮形态的历史顺序保持一致，且首轮前缀稳定。
    history.push({
      role: 'user',
      content: [
        ...(buffer ? [{ type: 'image' as const, base64: buffer.toString('base64'), mime: 'image/png' as const }] : []),
        { type: 'text' as const, text: userMessage },
      ],
    });
    const r = await client.complete({
      systemPrompt,
      messages: history,
      lang,
      // 单轮字段仍给：无 messages 支持的实现按它们走；回退路径共用。
      userMessage,
      ...(buffer ? { image: { base64: buffer.toString('base64'), mime: 'image/png' as const } } : {}),
    });
    opts?.onUsage?.(r);
    const raw = r.kind === 'json' ? JSON.stringify(r.value) : r.value;
    // 回放 LLM 原始输出进历史（而非动作摘要）：保持与"模型实际说过的话"逐字一致，
    // 否则下一轮前缀与本轮实际发送的不匹配，缓存断点漂移、命中率反降。
    history.push({ role: 'assistant', content: [{ type: 'text', text: raw }] });
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
      const sel = 'selector' in a ? a.selector : null;
      // 动作高亮（blackboard）：selector 动作执行前在目标位置描红框，finally 清除——
      // 有人观看（playground 画面流）时注入，无人观看零 DOM/CDP 干扰（boundingBox 懒求值）。
      // 清除保证下轮截图/步截图不被污染。
      if (sel) await annotateAction(page, () => page.locator(sel).first().boundingBox().catch(() => null));
      try {
        lastResults.push(await execAction(page, a, valueSub));
        opts?.onAction?.(a, true);
      } catch (e) {
        // 凭据缺失是环境级硬错误：反馈给 LLM 只会让它换 selector 空转烧调用，直接终止本步
        // （EnvMissing/SecretMissing 由 valueSub 抛出，携带可行动的配置指引）。
        if (e instanceof Error && (e.name === 'EnvMissing' || e.name === 'SecretMissing')) throw e;
        opts?.onAction?.(a, false);
        const target = sel ?? ('url' in a ? a.url : '');
        lastResults.push(`${a.type} ${target}: error ${e instanceof Error ? e.message.slice(0, 150) : String(e)}`);
      } finally {
        await clearAnnotation(page);
      }
    }
    if (actions.length === 0) {
      lastResults.push('[system] 没有可执行的动作（actions 为空）。如需结束请输出 done 或 fail。');
    }
    // 先执行动作再结束：LLM 可能在 done 响应里携带最终动作（如 fill 验证码）。
    if (parsed.done === true) {
      const s = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      // 凭据替换留痕：报告里能看到「本步真的用了环境凭据」，便于事后判读。
      return credSubCount > 0 ? `${s}（凭据占位符已替换 ${credSubCount} 处为环境凭据）` : s;
    }
  }
  throw new Error(`aiTask 超过 ${maxTurns} 轮未完成：${instruction.slice(0, 80)}`);
}
