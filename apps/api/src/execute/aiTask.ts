import type { Page } from 'playwright-core';
import type { LLMClient, LLMMessage } from '../agent/llm-client.js';
import { tryParseJson } from '../agent/llm-client.js';
import { aiLangFrom, type AiLang } from '../agent/langDirective.js';
import { VAR_NAME_RE, type StepAction } from '@itest/shared';
import type { AiUsageAddend } from './aiUsage.js';
import { logger } from '../logger.js';
import { annotateAction, clearAnnotation } from './liveView.js';
import { waitForPageSettled, pageFingerprint } from './pageSettle.js';
import { captureLiveRegionMessages, diffNewMessages, hasObservableChange, type ChangeSnapshot } from './liveRegion.js';
import { isOpenDropdownFilter } from './dropdownFilter.js';
import { assertReadOnlySql } from './sqlGuard.js';
import { dumpElements, SYNTH_SELECTOR_SRC, type ElementInfo } from './elementDump.js';
import {
  brittleSelectorReason,
  destructiveActionReason,
  destructiveTextOf,
  noteStreakFailure,
  originOf,
  renderSqlProbeRows,
  scopeViolationReason,
} from './gates.js';

// Gates and element extraction have been extracted into shared modules (exploration needs the same semantics after moving to the pi tool chain).
// Re-exported as-is here; aiTask's existing external surface (test and exploration.ts import paths) stays unchanged.
export { brittleSelectorReason, destructiveActionReason, originOf, renderSqlProbeRows, scopeViolationReason };

/** Maximum conversation turns per instruction (one LLM call per turn). */
const MAX_TURNS = 8;
/** Per-turn cap of interactive elements fed to the LLM, preventing prompt bloat. */
const MAX_ELEMENTS = 60;

/** Main body of the system prompt (credential section excluded). The credential section is appended on demand — see assembleSystemPrompt.
 *  Coordinate protocol (modeled on midscene): the model points at targets with normalized coordinates on the screenshot, and the platform converts them to viewport pixels
 *  — vision and action share one channel, eliminating the translation loss of "saw which element → write its selector"; coordinate clicks
 *  naturally pierce iframe/shadow DOM (qiankun micro-frontend friendly). selector is demoted to a fallback channel. */
const SYSTEM_PROMPT_BASE = `你是 Web 测试执行智能体，在真实浏览器里执行一条自然语言测试指令。
每轮你会收到：当前页面 URL、视口尺寸、一张视口截图、可交互元素清单（含与截图对齐的归一化坐标框）。
只输出 JSON，不要输出其他内容。格式：
{"actions": [...], "done": false, "summary": "一句话进展"}
actions 元素类型：
- {"type":"click","x":<0-1000>,"y":<0-1000>}　点击截图上的目标元素。坐标按视口归一化 0-1000；指在目标本体（按钮文字/图标/链接文本）的中心，不要指整行、单元格或外层容器
- {"type":"fill","x":..,"y":..,"value":"<最终文本>"}　聚焦该输入框后整段输入（React 受控表单已特殊处理，直接给最终值）
- 兼容形态 {"type":"click","selector":"<css>"} / {"type":"fill","selector":"<css>","value":...}：仅当元素清单里确有该 selector 且与你要操作的目标唯一对应时使用；清单里没有时禁止自拟 selector，改用坐标。selector 只能是普通 CSS 或 text=文本，禁止 :has-text()、:has()、:near()、>> 链、nth= 等 Playwright 专有语法
- {"type":"press","key":"Enter|Tab|Escape|ArrowDown|..."}
- {"type":"wait","ms":<毫秒>}
- {"type":"navigate","url":"<绝对地址>"}（仅 http/https 绝对地址）
- {"type":"screenshot","selector":"<css>"}　请求该元素的 4 倍放大白底截图，下轮会作为附图发给你
- {"type":"screenshot","x":..,"y":..}　请求 (x,y) 附近视口区域的局部放大截图（密集/相似元素区域校准定位用，deepLocate 两段式）——坐标系与截图一致（视口归一化 0-1000），下轮附图后仍按全页坐标输出动作
结束方式（二选一）：
- 指令已完成：{"done": true, "summary": "做了什么"}
- 无法完成：{"fail": "原因"}（会立即终止并记为该步骤失败）
子目标清单（可选，指令可分解为 2 条以上子操作时使用；简单指令不需要）：
- 第 1 轮随 actions 一起输出 "plan": [{"text":"打开新增对话框"},{"text":"填写名称"},{"text":"保存并确认"}]
- 之后每轮输出更新后的完整清单：截图确认已生效的条目加 "done":true（预期下一步才会完成的不算提前标），可按页面实际增删改条目
- 每轮的当前进度会回显给你——用它保持方向感，不要重复已完成的目标
规则：
- 指令忠实：指令给出明确操作时就只做这些操作，不加戏——「填写表单」只填不提交、「点击按钮」点击即止、「输入文本」不追加回车；只有指令是目标性描述（如「创建一个分类」）时才自行补全操作路径。
- 持久变更走到底：创建/编辑/保存/提交/删除类指令必须走到保存/确认/提交生效才算完成，不能停在草稿或未保存的编辑态；反之，只要求中间态（填内容、选选项）的指令到态即停。
- 目标已达成即完成：指令是确认式/条件式（如「确认 XX 正常展示」「若页面出现 XX 则继续」）且截图与元素清单已证实目标状态存在时，零动作直接输出 {"done": true, "summary": "目标已达成，无需操作：<引用截图/清单里的证据>"}——不要为「留下操作痕迹」画蛇添足地点击或重填。
- 完成判据要执行证据：输出 done 前逐条核对（有子目标清单时逐条核对清单）——每个操作都要有「动作结果 ok + 截图确认生效」的证据，不能只看终态截图像完成了就判定全部完成。豁免：零动作完成（上一条）只要求目标状态的截图/清单证据，不要求动作证据。
- 断言/校验类指令：条件确实不满足且无法满足时输出 fail 如实说明差异，不要绕过断言、放宽判据或改判通过。
- 每轮最多 2 个动作，宁可多轮推进也不要连发——页面在动作间会变化，连发会让后续动作建立在过期认知上。每个动作的执行结果（ok / 错误信息）下轮反馈给你。
- 同一目标连续 3 次失败就停止对它重试：先用截图核对当前页面是否还在指令期望的界面（弹窗/跳转/加载中都会让目标消失），页面不对先处理页面；确认页面正确而目标确实不存在 → 输出 fail 如实说明，不要换坐标/selector 空转。
- fill 后动作结果没报 error，就不要因为「页面上看得见的文本与目标不一致」（窄输入框截断、掩码显示、格式化渲染）清空重输——以执行结果为准，重输会破坏已生效的输入。
- 下拉/级联/单选行语义：很多组件「点行文字只展开下一级，选中必须点行首的圆形单选点」；操作是否生效以元素清单里 input 的 value 为准（级联选中后 value=完整路径；截图窄框只截断显示前缀，别据前缀判「选错」反复重选）。
- 页面处于加载中/骨架屏时不做判断，先 wait 或留到下一轮观察。
- 在长列表/下拉框里找目标时小步滚动（每次位移 50~150px 后再观察），不要大幅跳跃以免错过。
- 元素清单只覆盖视口内元素：目标既不在清单也不在截图里时，先滚动找到它再操作。
- 验证码/图形文字：先 screenshot 放大验证码图片，下轮逐字符仔细辨认。字符集为字母+数字（绝不出现 0 O o 1 l I），不区分大小写，通常 4 位，有随机旋转和干扰线。识别结果 fill 进对应输入框。
- 页面状态自检：每轮先看「当前 URL + 截图」确认自己是否在指令期望的界面上。目标连续找不到时优先怀疑「页面不在期望界面」（入口/步骤错位、被弹窗或中间态挡住、导航没生效），需要时用 navigate / 点击返回 / 处理弹窗先回到正确界面。
- 数据忠实：不得改写或覆盖指令、数据集或前置步骤已填入的表单值（含账号/密码等输入内容）。输入看起来异常（超长、特殊字符、疑似无效）也原样照填——异常输入往往正是测试目的本身。页面状态自检只用于回到正确界面/找对元素，不用于"修正"表单内容。`;

/** Credential rule: only appended into the system prompt when this step actually needs credential capability. */
const CREDENTIAL_RULE = `- 凭据（用户名/密码）：fill 的 value 用字面量 __ITEST_USERNAME@服务名__ / __ITEST_PASSWORD@服务名__（服务名取自下方资源清单里的 name；平台在填入的瞬间替换为真实值）；不要输出 {{}} 变量模板，平台不替换模板。`;

/**
 * Assembles the system prompt.
 *  credEnabled=false → no credential section at all: the AI can't see the placeholder form, so it won't grab credentials to refill the account/password boxes
 *  (measured on 2026-10-26 prod228: with the credential section the AI actively fills __ITEST_USERNAME@web__; without it, only literals).
 *  The mobile version never appends the credential section (mobile has no web-credential semantics).
 */
export function assembleSystemPrompt(opts: { mobile?: boolean; credEnabled: boolean; manifest: string; base?: string }): string {
  if (opts.mobile) return MOBILE_SYSTEM_PROMPT;
  // base override point: exploratory sessions pass the exploration prompt (the execution faithfulness rules are the wrong mode for exploration); the credential-section assembly logic is unchanged.
  const base = opts.base ?? SYSTEM_PROMPT_BASE;
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
- 目标已达成即完成：确认式/条件式指令且 accessibility tree 已证实目标状态存在时，零动作直接输出 {"done": true, "summary": "目标已达成，无需操作"}。
- 每轮动作要保守，最多 6 个；每个动作结果下轮反馈给你，出错就换 accessibilityId / label 重试。
- 屏幕中可能同时存在多个相同 label 的节点，命中歧义时优先选 accessibilityId。`;

/** click/fill dual forms: coordinates (the model's primary channel, viewport-normalized 0-1000) or selector (fallback / resolution backfill).
 *  onAction reports the selector form externally whenever possible (backfilled after the coordinates resolve to an element), so the solidify/cache pipeline shape is unchanged. */
export type AiAction =
  | { type: 'click'; selector?: string; x?: number; y?: number }
  | { type: 'fill'; selector?: string; x?: number; y?: number; value: string }
  | { type: 'press'; key: string }
  | { type: 'wait'; ms: number }
  | { type: 'navigate'; url: string }
  | { type: 'screenshot'; selector?: string; x?: number; y?: number }
  /** Database evidence (exploration-session-only channel): runs a read-only query against the SUT's own database.
   *  db = the label of an environment db object (default = the environment's default db); limit = row-fetch cap. */
  | { type: 'sql'; query: string; limit?: number; db?: string }
  /** Repo code reading (exploration-session-only channel, enabled when a code commit scope exists): read-only viewing of changed code.
   *  read=read a file (offset start line + maxLines line cap, for reading change hunks of large files);
   *  grep=search code by regex/literal; ls=list a directory;
   *  diff=view scope changes (whole scope without path, single file with path). */
  | { type: 'repo'; op: 'read' | 'grep' | 'ls' | 'diff'; path?: string; pattern?: string; offset?: number; maxLines?: number };

/** Single refill cap of a sql evidence probe: four-level caps on rows / cells / per-row / whole block (fed back into the next userMessage; cannot grow without bound). */
export const SQL_PROBE_MAX_ROWS = 20;
export const SQL_PROBE_DEFAULT_ROWS = 20;

/** Refill cap of repo code reading: whole-block character count (defensive truncation; the row/match-count semantic caps live in the channel implementations). */
export const REPO_OUTPUT_MAX_CHARS = 6000;
/** repo read per-call max lines (clamped by parseAction and shared with the channel implementation as one semantic). */
export const REPO_READ_MAX_LINES = 200;
/** repo path/pattern field length cap (truncated by parseAction — the model may emit overly long strings). */
const REPO_FIELD_MAX = 200;

// AI-phase credential placeholder protocol: the verify_case / solidify_case prompts require the LLM to fill the username/password/
// sensitive fields with these three literals, and valueSub replaces them with real values at execution time. The protocol constants are defined
// in the execute layer (where the valueSub semantics live); the pi tool layer takes them from here.
export const USER_PH = '__ITEST_USERNAME__';
export const PASSWORD_PH = '__ITEST_PASSWORD__';
export const SECRET_PH = '__ITEST_STEP_SECRET__';

// ── Credential placeholder recognition and replacement (the unified protocol for AI-phase fill values) ───────────────────────────────
export type CredentialKind = 'user' | 'password' | 'secret';

/** Parsed result: kind + owning web service name (null = unspecified, walks the three-level default chain). */
export interface ParsedCredential { kind: CredentialKind; ref: string | null }

/** @ref segment validity: same semantics as shared's VAR_NAME_RE (letters/digits/underscores, starting with a letter or underscore, ≤64). */
export function isValidCredentialRef(ref: string): boolean {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 64 && VAR_NAME_RE.test(ref);
}

const KIND_BY_NAME: Record<string, CredentialKind> = {
  ITEST_USERNAME: 'user',
  ITEST_PASSWORD: 'password',
  ITEST_STEP_SECRET: 'secret',
};

/**
 * Parses a credential placeholder: __ITEST_USERNAME@backend__ / {{ITEST_USERNAME@backend}} /
 * {{__ITEST_USERNAME@backend__}} / the legacy form without a ref.
 * Bare names (not wrapped in sentinels/braces) are not recognized, avoiding misjudging ordinary text as credentials;
 * an invalid ref segment rejects the whole placeholder, never degrading to "no ref" (that would silently take the default web's account).
 * secret is unrelated to web (step-level ciphertext); its @ segment is ignored.
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

/** Convenience wrapper for kind only (solidify decisions etc. only need "is it a credential"). */
export function credentialPlaceholderKind(raw: string): CredentialKind | null {
  return parseCredentialPlaceholder(raw)?.kind ?? null;
}

/** Renders a placeholder for prompt assembly (avoids hand-copying literals wrong in various places). */
export function credentialPlaceholder(kind: CredentialKind, ref?: string | null): string {
  const base = kind === 'user' ? USER_PH : kind === 'password' ? PASSWORD_PH : SECRET_PH;
  if (!ref || kind === 'secret') return base;
  return `${base.slice(0, -2)}@${ref}__`;
}

const CREDENTIAL_REF_RE = /(?:\{\{\s*)?_{0,2}ITEST_(?:USERNAME|PASSWORD|STEP_SECRET)_{0,2}(?:@[A-Za-z_][A-Za-z0-9_]*)?(?:\s*\}\})?/;

/** Whether free text references a credential placeholder (any form: sentinel / braces / bare name / with @ref).
 *  Used by: substituteVars's missing filter (credentials don't come from dataset vars) + the pre-execution environment-credential check. */
export function referencesCredential(text: string): boolean {
  return CREDENTIAL_REF_RE.test(text);
}

/** Credential source: the no-ref defaults + a per-web-service-name lookup callback (both empty = missing). */
export interface CredentialSource {
  /** Default source for no-ref placeholders (zero changes for existing callers). */
  user?: string | null;
  password?: string | null;
  secret?: string | null;
  /**
   * Credentials of a web service by its name; returning null = that ref has no credentials → falls back to the defaults above.
   * Note: the environment-derived implementation (buildCredentialSource) **throws a named error** on a miss rather than returning null —
   * silently using the default service's credentials when an explicit @ref misspells the service name would log the test into another system.
   */
  byRef?: (ref: string) => { user?: string | null; password?: string | null } | null;
  /**
   * Whether an unresolvable explicit @ref is judged dead (no fallback to the default chain).
   * Generic implementations default to false (fall back to defaults); the environment-derived implementation sets true — misspelling the service name yet silently using
   * the default service's credentials = logging the test into another system.
   */
  strictRef?: boolean;
  /** For error messages: the environment display name (missing resources must be named; users troubleshoot by it). */
  envName?: string | null;
  /** For error messages: the default owning web service name of a no-ref placeholder. */
  defaultRef?: string | null;
}

/**
 * fill-value replacer shared by the AI phase / mechanical phase: swaps credential placeholders (sentinel / braces / @ref, any form)
 * for real values; non-placeholders are returned as-is. Missing credentials → throws the EnvMissing/SecretMissing named errors;
 * the error message names the missing web service; the placeholder is never typed verbatim into the form (measured on 2026-10-21 prod228:
 * a placeholder verbatim into the login form always fails, and the AI spins switching selectors, burning 12+ LLM calls).
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
        // The explicitly named web service doesn't exist or has no credentials → judged dead, never falling back to the default chain (it would log into another system).
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

/** Named error constructor: EnvMissing (environment credentials) / SecretMissing (step ciphertext). */
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

/** Environment identifier for error messages. */
function envLabel(src: CredentialSource): string {
  return src.envName ? `环境「${src.envName}」` : '当前环境';
}

/** Owning-service identifier for error messages: explicit @ref first, then the default owner. */
function refLabel(src: CredentialSource, ref: string | null): string {
  const name = ref ?? src.defaultRef ?? null;
  return name ? `web 服务 ${name}` : '默认 web 服务';
}

/** Scans all credential placeholder occurrences in text (for the pre-check to parse one by one). The @ref form matches as a whole. */
export const CREDENTIAL_PLACEHOLDER_SCAN = /__?ITEST_(?:USERNAME|PASSWORD|STEP_SECRET)@?[A-Za-z0-9_]*__?|\{\{\s*_*ITEST_(?:USERNAME|PASSWORD|STEP_SECRET)@?[A-Za-z0-9_ ]*_*\s*\}\}/g;

/** Clamping and numeric validation of 0-1000 normalized coordinates (non-finite → null). */
function clampCoord(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(1000, Math.max(0, Math.round(v)));
}

function parseAction(a: unknown): AiAction | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const type = String(o.type ?? '');
  const hasCoord = clampCoord(o.x) !== null && clampCoord(o.y) !== null;
  if (type === 'click') {
    // Coordinates take priority; selector is the fallback (when both exist, executes by coordinates, the selector is backfilled by the platform's resolution)
    if (hasCoord) return { type, x: clampCoord(o.x)!, y: clampCoord(o.y)! };
    if (typeof o.selector === 'string' && o.selector) return { type, selector: o.selector };
    return null;
  }
  if (type === 'fill' && typeof o.value === 'string') {
    if (hasCoord) return { type, x: clampCoord(o.x)!, y: clampCoord(o.y)!, value: o.value };
    if (typeof o.selector === 'string' && o.selector) return { type, selector: o.selector, value: o.value };
    return null;
  }
  if (type === 'press' && typeof o.key === 'string') return { type, key: o.key };
  if (type === 'wait' && typeof o.ms === 'number') return { type, ms: Math.min(Math.max(o.ms, 0), 10000) };
  if (type === 'navigate' && typeof o.url === 'string' && /^https?:\/\//.test(o.url)) return { type, url: o.url };
  if (type === 'screenshot') {
    // selector form (4x element zoom) vs coordinate form (local region crop zoom): exactly one.
    if (typeof o.selector === 'string' && o.selector) return { type, selector: o.selector };
    if (clampCoord(o.x) !== null && clampCoord(o.y) !== null) return { type, x: clampCoord(o.x)!, y: clampCoord(o.y)! };
    return null;
  }
  if (type === 'sql') {
    // Shape validation only: length and read-only judgment are left to the guards in the action loop — there an actionable error line is possible,
    // judging dead here would silently drop the action and the model would never learn why.
    // Key-name tolerance: the model may write query/sql, db/dbRef.
    const raw = typeof o.query === 'string' ? o.query : typeof o.sql === 'string' ? o.sql : null;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const dbRaw = typeof o.db === 'string' ? o.db : typeof o.dbRef === 'string' ? o.dbRef : null;
    const db = dbRaw?.trim() ? dbRaw.trim().slice(0, 64) : undefined;
    const limit =
      typeof o.limit === 'number' && Number.isFinite(o.limit)
        ? Math.min(Math.max(Math.round(o.limit), 1), SQL_PROBE_MAX_ROWS)
        : SQL_PROBE_DEFAULT_ROWS;
    return { type: 'sql', query: raw.trim(), limit, ...(db ? { db } : {}) };
  }
  if (type === 'repo') {
    // Shape validation and truncation only: path existence/sandbox/quota are left to the channel guards in the action loop —
    // judging dead here would silently drop the action and the model would never learn why.
    // Key-name tolerance: the model may write op/action, pattern/q, path/file.
    const op = String(o.op ?? o.action ?? '');
    const pathRaw = typeof o.path === 'string' ? o.path : typeof o.file === 'string' ? o.file : null;
    const patternRaw = typeof o.pattern === 'string' ? o.pattern : typeof o.q === 'string' ? o.q : null;
    const cleanPath = pathRaw?.trim() ? pathRaw.trim().slice(0, REPO_FIELD_MAX) : undefined;
    const cleanPattern = patternRaw?.trim() ? patternRaw.trim().slice(0, REPO_FIELD_MAX) : undefined;
    const maxLines =
      typeof o.maxLines === 'number' && Number.isFinite(o.maxLines)
        ? Math.min(Math.max(Math.round(o.maxLines), 1), REPO_READ_MAX_LINES)
        : REPO_READ_MAX_LINES;
    const offset =
      typeof o.offset === 'number' && Number.isFinite(o.offset)
        ? Math.max(Math.round(o.offset), 0)
        : 0;
    if (op === 'read') {
      if (!cleanPath) return null;
      return { type: 'repo', op: 'read', path: cleanPath, offset, maxLines };
    }
    if (op === 'grep') {
      if (!cleanPattern) return null;
      return { type: 'repo', op: 'grep', pattern: cleanPattern, ...(cleanPath ? { path: cleanPath } : {}), maxLines };
    }
    if (op === 'ls') return { type: 'repo', op: 'ls', ...(cleanPath ? { path: cleanPath } : {}) };
    if (op === 'diff') return { type: 'repo', op: 'diff', ...(cleanPath ? { path: cleanPath } : {}) };
    return null;
  }
  return null;
}

/** Click target → visible text in the element list (coordinates judged by normalized-box containment; selector by equality).
 *  Not found in the list → returns the empty string = pass through: the list only collects interactive elements capped at 60, and the model may click outside it —
 *  better a missed judgment than falsely killing normal exploration (the real line of defense is still disposable data configured for the SUT environment). */
function clickTargetText(a: AiAction, elements: ElementInfo[]): string {
  if (a.type !== 'click') return '';
  const hit =
    typeof a.x === 'number' && typeof a.y === 'number'
      ? elements.find((e) => a.x! >= e.box[0] && a.x! <= e.box[2] && a.y! >= e.box[1] && a.y! <= e.box[3])
      : elements.find((e) => e.selector === a.selector);
  return destructiveTextOf(hit, typeof a.selector === 'string' ? a.selector : '');
}

/** Resolution result of a coordinate action: the element hit at that point (selector synthesis shares SYNTH_SELECTOR_SRC with dumpElements). */
interface PointTarget {
  selector: string;
  /** Whether the synthesized selector hits uniquely in the page; when false, the reporting chain keeps the coordinate form (the solidify pipeline rejects conservatively). */
  unique?: boolean;
  tag: string;
  text?: string;
  /** The current value of input/textarea (for fill read-back). */
  value?: string;
  /** The element is an "expanded dropdown" filter input (Element UI / Ant Design) — fill must not blur at the end. */
  dropdownFilter?: boolean;
  box: { x: number; y: number; width: number; height: number };
}

/** Viewport-normalized 0-1000 → CSS pixels. Falls back to the executor's standard viewport 1280x800 when viewportSize is unavailable. */
function toViewportPt(a: { x?: number; y?: number }, page: Page): { px: number; py: number } {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  return {
    px: Math.round(((a.x ?? 0) / 1000) * vp.width),
    py: Math.round(((a.y ?? 0) / 1000) * vp.height),
  };
}

/** Resolves the target element at a viewport point: the key of P1 — before a coordinate action executes, the target is resolved back to a stable selector,
 *  onAction reports the selector form based on it (the solidify/cache pipeline unchanged), the box serves action highlight, the value serves fill read-back.
 *  intent='fill': when a wrapping container is hit (a label/div laid over the input), sinks to the first visible input control inside — read-back semantics follow the control.
 *  intent='click': when an inner non-interactive node is hit (e.g. a span inside a button), floats up at most 5 levels to the nearest interactive ancestor —
 *  the synthesized target and highlight box follow the ancestor (the whole button box), no more bare spans.
 *  Selector synthesis shares SYNTH_SELECTOR_SRC with dumpElements, with the uniqueness verdict (unique) attached.
 *  Coordinate clicks themselves pierce iframe/shadow DOM; failing to resolve here (returns null) only affects the reported form, not execution. */
async function resolveAtPoint(
  page: Page,
  px: number,
  py: number,
  intent: 'click' | 'fill',
): Promise<PointTarget | null> {
  try {
    const raw = await page.evaluate(
      (arg: { pt: [number, number]; src: string; it: 'click' | 'fill' }) => {
        const synth = eval('(' + arg.src + ')') as (el: HTMLElement) => { selector: string; unique: boolean };
        const hit = document.elementFromPoint(arg.pt[0]!, arg.pt[1]!);
        if (!hit) return null;
        let target = hit as HTMLElement;
        const INTERACTIVE =
          'input, textarea, select, button, a, summary, label, [role="button"], [role="link"], [role="tab"], [role="switch"], [role="option"], [role="menuitem"]';
        if (arg.it === 'fill') {
          const t = target.tagName;
          if (t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') {
            const inner = target.querySelectorAll('input, textarea');
            for (const c of Array.from(inner)) {
              const ir = (c as HTMLElement).getBoundingClientRect();
              if (ir.width > 2 && ir.height > 2) {
                target = c as HTMLElement;
                break;
              }
            }
          }
        } else if (!target.matches(INTERACTIVE)) {
          let anc = target.parentElement;
          for (let i = 0; i < 5 && anc; i++, anc = anc.parentElement) {
            if ((anc as HTMLElement).matches(INTERACTIVE)) {
              target = anc as HTMLElement;
              break;
            }
          }
        }
        const s = synth(target);
        const r = target.getBoundingClientRect();
        const out: Record<string, unknown> = {
          selector: s.selector,
          unique: s.unique,
          tag: target.tagName.toLowerCase(),
          box: { x: r.left, y: r.top, width: r.width, height: r.height },
        };
        const text = (target.textContent ?? '').trim().slice(0, 40);
        if (text) out.text = text;
        const v = (target as HTMLInputElement).value;
        if (typeof v === 'string') out.value = v;
        // "Expanded dropdown's filter input" detection (Element UI / Ant Design): such controls clear the query text and close
        // the candidate panel on blur — fill must skip the trailing Tab, otherwise a remote-search dropdown can never get a candidate selected.
        // Same criteria as dropdownFilter.ts (host + expanded or not); inlined here because page.evaluate
        // cannot reference module-scope identifiers.
        let dropdownFilter = false;
        {
          // Don't throw when closest is unavailable (the probe is an optional enhancement; throwing would also lose the selector enrichment)
          const host = typeof target.closest === 'function'
            ? (target.closest('.el-select, .el-autocomplete, .ant-select') as HTMLElement | null)
            : null;
          if (host) {
            const vm = (host as unknown as { __vue__?: { visible?: unknown; suggestionsVisible?: unknown } }).__vue__;
            if (vm) dropdownFilter = vm.visible === true || vm.suggestionsVisible === true;
            else dropdownFilter = /(^|\s)\S*-open(\s|$)/.test(host.className);
          }
        }
        if (dropdownFilter) out.dropdownFilter = true;
        return out;
      },
      { pt: [px, py] as [number, number], src: SYNTH_SELECTOR_SRC, it: intent },
    );
    return (raw ?? null) as PointTarget | null;
  } catch {
    return null;
  }
}

/** onAction reporting form: a coordinate action is backfilled to the selector form once a stable and page-unique selector resolves —
 *  the mapAiActionsToCompiled / aiTaskCache / solidify trail pipelines only see the selector form; the shape is unchanged.
 *  On resolution failure or non-uniqueness (unique=false, e.g. a bare span without enrichment signals), the coordinate action is reported as-is
 *  (the mapping layer refuses to solidify the step and conservatively falls back to aiTask — a non-unique selector silently clicks wrong on mechanical replay). */
function toReportAction(a: AiAction, resolvedSelector: string | null | undefined): AiAction {
  if ((a.type === 'click' || a.type === 'fill') && typeof a.x === 'number' && resolvedSelector) {
    return a.type === 'fill'
      ? { type: 'fill', selector: resolvedSelector, value: a.value }
      : { type: 'click', selector: resolvedSelector };
  }
  return a;
}

/** In-step sub-goals (modeled on midscene deepThink sub-goals, rolling-maintained to give the model direction):
 *  the model outputs the full list with its JSON each turn; the platform replaces it wholesale and echoes it into the next userMessage. */
export interface SubGoal {
  text: string;
  done: boolean;
}

/** Tolerant parsing: accepts [{text,done}] / ["text"] mixed; returns null when all invalid (best-effort, no correction no feedback). */
function parseSubGoals(v: unknown): SubGoal[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: SubGoal[] = [];
  for (const item of v.slice(0, 8)) {
    if (typeof item === 'string') {
      const t = item.trim().slice(0, 60);
      if (t) out.push({ text: t, done: false });
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const t = typeof o.text === 'string' ? o.text.trim().slice(0, 60) : '';
      if (t) out.push({ text: t, done: o.done === true });
    }
  }
  return out.length > 0 ? out : null;
}

/** The progress block echoed into the userMessage (absent on the first turn when no list exists). */
function renderSubGoals(goals: SubGoal[]): string {
  const lines = goals.map((g, i) => `${i + 1}. [${g.done ? '完成' : '进行中'}] ${g.text}`);
  return `子目标进度（你维护的清单，截图确认生效后标 done:true）：\n${lines.join('\n')}`;
}

// —— Negative-result ledger (the smallest slice of externalized memory) ——
// Stores only "excluded hypotheses", never beliefs: a blackboard storing beliefs freezes observations into conclusions and self-confirms,
// whereas the output of exploratory testing is information (which paths are excluded), not conclusions.
// The platform doesn't guess negative results (failed actions and no observed change are process noise); the model declares, the platform persists and refills.

/** Per-turn declared item cap / per-item text cap / session cumulative cap (the refill block cannot grow without bound). */
const EXCLUDED_PER_TURN_MAX = 5;
const EXCLUDED_ITEM_MAX = 120;
const EXCLUDED_TOTAL_MAX = 20;

/** Model-declared exclusion item. */
export interface ExcludedItem {
  claim: string;
  evidence: string;
}

/** Tolerant parsing: accepts [{claim,evidence}] / [strings]; invalid items dropped (best-effort, no correction no feedback). */
export function parseExcluded(v: unknown): ExcludedItem[] {
  if (!Array.isArray(v)) return [];
  const out: ExcludedItem[] = [];
  for (const item of v.slice(0, EXCLUDED_PER_TURN_MAX)) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) out.push({ claim: t.slice(0, EXCLUDED_ITEM_MAX), evidence: '' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const claim = typeof o.claim === 'string' ? o.claim.trim() : '';
    if (!claim) continue;
    const evidence = typeof o.evidence === 'string' ? o.evidence.trim().slice(0, EXCLUDED_ITEM_MAX) : '';
    out.push({ claim: claim.slice(0, EXCLUDED_ITEM_MAX), evidence });
  }
  return out;
}

/** The exclusion block refilled into the userMessage (an empty ledger never appears in the userMessage). */
export function renderExcluded(items: ExcludedItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map((e) => `- ${e.claim}${e.evidence ? `（依据：${e.evidence}）` : ''}`);
  return `已排除（你申报并已验证过的路径，不要重复探索）：\n${lines.join('\n')}`;
}

/** Brief settle after an action (modeled on midscene's 300ms + networkIdle): navigation/re-render lands before the next action starts. */
async function settleAfterAction(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => undefined);
  await page.waitForTimeout(150);
}

/** Executes a single action; returns the result description for the LLM + the stable selector resolved from coordinate actions.
 *  resolvedSelector is given only when resolution succeeds and the hit is page-unique (unique !== false) — null when non-unique,
 *  the reporting chain keeps the coordinate form and the solidify pipeline rejects the step conservatively.
 *  valueSub: replaces the fill value before execution (placeholder → real credential); once substitution happened, feedback never echoes the real value. */
interface ExecOutcome {
  report: string;
  resolvedSelector?: string | null;
}

async function execAction(page: Page, action: AiAction, valueSub?: (v: string) => string): Promise<ExecOutcome> {
  switch (action.type) {
    case 'click': {
      if (typeof action.x === 'number' && typeof action.y === 'number') {
        const { px, py } = toViewportPt(action, page);
        const t = await resolveAtPoint(page, px, py, 'click');
        await page.mouse.click(px, py);
        const label = t?.selector ? `@${action.x},${action.y}（${t.selector}）` : `@${action.x},${action.y}`;
        return { report: `click ${label}: ok`, resolvedSelector: t && t.unique !== false ? t.selector : null };
      }
      const selector = action.selector!;
      await page.locator(selector).first().click({ timeout: 5000, force: true });
      return { report: `click ${selector}: ok`, resolvedSelector: selector };
    }
    case 'fill': {
      const realValue = valueSub ? valueSub(action.value) : action.value;
      const substituted = realValue !== action.value;
      if (typeof action.x === 'number' && typeof action.y === 'number') {
        const { px, py } = toViewportPt(action, page);
        const before = await resolveAtPoint(page, px, py, 'fill');
        await page.mouse.click(px, py);
        await page.keyboard.press('ControlOrMeta+A').catch(() => undefined);
        await page.keyboard.type(realValue, { delay: 20 });
        // Probe after typing, before blur: a remote-search dropdown (Element UI remote+filterable) clears the query
        // text and closes the candidate panel on blur, wiping the input value to "" — such controls must skip Tab, and the read-back must take the pre-blur value
        // (post-blur reads are necessarily empty; the AI would misjudge "can't fill" and retry endlessly).
        const typed = await resolveAtPoint(page, px, py, 'fill');
        const keepOpen = typed?.dropdownFilter === true;
        if (!keepOpen) {
          // React controlled forms often only commit state / trigger validation on blur; kept consistent with the selector path.
          await page.keyboard.press('Tab').catch(() => undefined);
          await page.waitForTimeout(80);
        }
        const after = keepOpen ? typed : await resolveAtPoint(page, px, py, 'fill');
        const actual = typeof after?.value === 'string' ? after.value : null;
        const label = before?.selector ? `@${action.x},${action.y}（${before.selector}）` : `@${action.x},${action.y}`;
        const resolvedSel = before && before.unique !== false ? before.selector : null;
        if (actual !== null && actual !== realValue) {
          // When substitution happened (credential fills), don't echo actual/target values — prevents password fragments leaking back to the LLM.
          if (substituted) {
            return { report: `fill ${label}: 实际值与目标不一致（实际值长度 ${actual.length}）`, resolvedSelector: resolvedSel };
          }
          return { report: `fill ${label}: 实际值 "${actual}" 与目标 "${action.value}" 不一致`, resolvedSelector: resolvedSel };
        }
        return { report: `fill ${label}: ok`, resolvedSelector: resolvedSel };
      }
      const selector = action.selector!;
      const loc = page.locator(selector).first();
      await loc.fill('', { timeout: 5000 });
      await loc.pressSequentially(realValue, { delay: 20 });
      // An expanded dropdown's filter input must not blur: blur clears the query text and closes the candidate panel (fatal for remote-search
      // dropdowns; later steps could never click a candidate). The detection runs after typing — only then can the panel be open.
      const keepOpen = await isOpenDropdownFilter(loc);
      if (!keepOpen) {
        // React controlled forms often only commit state / trigger validation on blur; kept consistent with cdp.ts's dispatch fill.
        await page.keyboard.press('Tab').catch(() => undefined);
        // Brief pause letting onChange/blur events land (Antd and friends validate asynchronously after blur).
        await page.waitForTimeout(80);
      }
      // Read-back confirmation: if the DOM value differs from the target, feed the actual value back to the LLM for next-turn correction.
      const actual = await loc.inputValue({ timeout: 3000 }).catch(() => '');
      if (actual !== realValue) {
        if (substituted) return { report: `fill ${selector}: 实际值与目标不一致（实际值长度 ${actual.length}）` };
        return { report: `fill ${selector}: 实际值 "${actual}" 与目标 "${action.value}" 不一致` };
      }
      return { report: `fill ${selector}: ok` };
    }
    case 'press': {
      await page.keyboard.press(action.key as never);
      return { report: `press ${action.key}: ok` };
    }
    case 'wait': {
      await page.waitForTimeout(action.ms);
      return { report: `wait ${action.ms}: ok` };
    }
    case 'navigate': {
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      // Aligned with init-goto: wait for SPA hydration; a 5s fallback so long-connection pages don't block.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      return { report: `navigate ${action.url}: ok` };
    }
    case 'screenshot': {
      // Not screenshotted here: once flagged, the main loop takes the 4x white-background image (selector) / coordinate-crop zoom (x,y) at the start of the next turn
      const label = action.selector ?? `@${action.x},${action.y}`;
      return { report: `screenshot ${label}: 已接受，下轮附图` };
    }
    case 'sql': {
      // sql actions are handled by the main loop separately (they don't enter the browser executor); reaching here means a leaked path — judge dead rather than silently returning.
      throw new Error('sql 动作不应进入浏览器动作执行器');
    }
    case 'repo': {
      // repo actions like sql: handled by the main loop separately; leaked paths are judged dead.
      throw new Error('repo 动作不应进入浏览器动作执行器');
    }
  }
}

/** Element 4x white-background screenshot (for small captcha image recognition); returns null on failure (falls back to the full-page screenshot). */
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

/** Local cropped screenshot of the area around a coordinate point (deepLocate two-stage adaptation: calibrating targeting in dense/similar-element regions).
 *  The point is the center of a square with side min(480, the viewport's short edge) (≥ midscene's 400×400 floor), clamped to the viewport bounds.
 *  No digital zooming: VL models gain no new information, and the coordinate system doesn't change (the attached image only calibrates; actions still output full-page coordinates). */
async function shotCrop(page: Page, x: number, y: number): Promise<Buffer | null> {
  try {
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const px = Math.round((x / 1000) * vp.width);
    const py = Math.round((y / 1000) * vp.height);
    const size = Math.min(480, Math.min(vp.width, vp.height));
    const left = Math.max(0, Math.min(vp.width - size, px - Math.floor(size / 2)));
    const top = Math.max(0, Math.min(vp.height - size, py - Math.floor(size / 2)));
    return await page.screenshot({
      timeout: 5000,
      type: 'jpeg',
      quality: 85,
      clip: { x: left, y: top, width: size, height: size },
    });
  } catch {
    return null;
  }
}

/** Captcha-task instruction detection (recorder output fixes the instruction as 「识别验证码图片中的字符并填入验证码输入框」). */
export const CAPTCHA_TASK_RE = /验证码|captcha/i;

/** Uses the LLM to judge whether the page shows a captcha failure notice (any wording: invalid / not passed / unrecognized / expired etc.).
 *  Replaces the old regex detectCaptchaFailure — a regex cannot cover the SUT's varying error wording.
 *  best-effort: returns false when the LLM call fails (no worse than the old behavior). */
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
 * Single-turn captcha recognition: heuristically locates "captcha image + companion input box" in the page → 4x screenshot → one vision call → fill in.
 * For "multi-round verification" retries — the retry must finish within the captcha TTL, so it must be fast (one LLM round-trip ~10s),
 * not the generic runAiTask multi-turn Agent loop (measured at 31s). Any step failure throws; the caller decides the fallback.
 * hint: the semantic locator from recording time (data-testid / name); when present, the input box is matched precisely first.
 * Note: no nested function declarations inside evaluate callbacks (the tsx esbuild keepNames gotcha).
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
    // Full-page fallback screenshot: waits for render stability before shooting, avoiding a transitional frame shot while the captcha image is in place but the page is still in skeleton/API backfill.
    // A shorter budget is used (captcha-TTL sensitive); on timeout, continue with the current frame.
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

/** Mechanical step action → human-readable semantics (for AI fallback to explain "what this step originally meant"). */
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
    case 'scroll': return `滚动 ${loc(a)} 至 (${(a as { scrollTop?: number }).scrollTop ?? 0}, ${(a as { scrollLeft?: number }).scrollLeft ?? 0})`;
    case 'fill': return `填写 ${loc(a)}`;
    case 'press': return `在 ${loc(a)} 上按键 ${(a as { key?: string }).key ?? ''}`;
    case 'hover': return `悬停 ${loc(a)}`;
    case 'check': return `勾选 ${loc(a)}`;
    case 'select': return `选择 ${loc(a)}`;
    case 'upload': return `上传 ${loc(a)}`;
    case 'navigate': return `访问 ${(a as { url?: string }).url ?? ''}`;
    case 'screenshot': return `截图 ${loc(a)}`;
    default: return a.kind;
  }
}

/** Mechanical-semantics classification of a step: decides which guideline the AI gets on fallback. */
export type DegradeStepType = 'observe' | 'interact' | 'unknown';

/** Observe actions: look without touching. */
const OBSERVE_KINDS = new Set(['waitFor', 'assertVisible', 'assertText', 'assertJson', 'screenshot', 'extract']);
/** Interact actions: change page state. */
const INTERACT_KINDS = new Set(['click', 'fill', 'check', 'select', 'upload', 'navigate', 'press', 'hover']);

/**
 * Classifies a step by mechanical semantics.
 *
 * observe (waitFor / assertVisible / assertText / assertJson / screenshot / extract) — the step only requires
 *   "seeing some phenomenon": on fallback the AI must not fill values, must not resubmit, must not alter the page to induce the phenomenon (measured on prod228:
 *   the AI fabricated a wrong captcha + resubmitted, producing the expected error notice itself; the negative case false-passed).
 * interact (click/fill etc.) — the step is meant to change the page: on fallback the AI may act, but must not rewrite values
 *   already filled by preceding steps (data faithfulness), must not re-run the interaction that just failed (resubmission fabricates the phenomenon and masks the real failure).
 * unknown — no mechanical actions (pure natural-language step): treated as observe; the instruction text is the intent.
 */
export function classifyDegradeStep(input: { compiled: unknown; failedAction?: unknown }): DegradeStepType {
  const actions: StepAction[] = [];
  if (Array.isArray(input.compiled)) actions.push(...(input.compiled as StepAction[]));
  const failed = input.failedAction as StepAction | undefined;
  if (failed) actions.push(failed);
  if (actions.length === 0) return 'unknown';
  // Has interact actions → interact; observe actions only → observe.
  if (actions.some((a) => INTERACT_KINDS.has(a.kind))) return 'interact';
  if (actions.some((a) => OBSERVE_KINDS.has(a.kind))) return 'observe';
  return 'unknown';
}

/** The fallback guideline per classification (a prompt-level constraint, not mechanical blocking). */
function degradeGuard(stepType: DegradeStepType): string[] {
  // unknown (pure natural-language step) is treated as observe: these steps have no mechanical-semantics fallback and the AI has maximum freedom,
  // and the "observe only" constraint is exactly the key to preventing it from fabricating data to induce the expected phenomenon.
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
 * AI-fallback context after a mechanical failure: tells the AI both "the step's intended mechanical actions" and "what the mechanical run actually did".
 *
 * Background (measured on 2026-10-26 prod228): the fallback path used to pass only the natural-language instruction — the AI got the goal
 * "make the error notice appear" plus a whole set of page-altering actions, without knowing the mechanical semantics were "wait 10s for some text"
 * or that the mechanical run had already waited the full window and confirmed it never appeared. The AI then filled a fabricated wrong captcha + resubmitted,
 * **producing the expected phenomenon itself**; the negative case false-passed as a result.
 *
 * With the mechanical semantics + mechanical result + per-step-type guideline, the AI can judge "this is an observe step; it waited 10s and the text never came",
 * and, following the guideline, honestly report not-achieved.
 */
export function buildDegradeContext(input: {
  compiled: unknown;
  /** The action that actually failed (may be a step-level assertion, absent from compiled). When absent, only compiled is described. */
  failedAction?: unknown;
  /** The mechanical failure reason; absent means "this step has no mechanical action that can fail" (an uncompiled pure natural-language step). */
  mechanicalError?: string;
}): string {
  const compiled = Array.isArray(input.compiled) ? (input.compiled as StepAction[]) : [];
  const semantics = compiled.map(describeAction);
  // Assertions aren't in compiled (compiled holds only actions; assertions are a step-level field) — when the failure was on an assertion, append one line,
  // otherwise the semantics the AI sees won't line up with the real failure point.
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

/** Probe result of database evidence (the caller provides the implementation; the platform only feeds read-only queries). */
export type SqlProbeResult =
  | { ok: true; rowCount: number; truncated: boolean; rows: Array<Record<string, unknown>> }
  | { ok: false; error: string };

/** Repo code-reading request (the platform-side shape of the repo action; the caller's implementation does read-only access + sandbox confined to the repo root). */
export type RepoReadRequest =
  | { op: 'read'; path: string; offset: number; maxLines: number }
  | { op: 'grep'; pattern: string; path?: string; maxLines: number }
  | { op: 'ls'; path?: string }
  | { op: 'diff'; path?: string };

/** Repo code-reading result: content is semantically capped by the caller (lines/matches); the aiTask side additionally truncates the whole block defensively. */
export type RepoReadResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/** runAiTask optional items. */
export interface RunAiTaskOpts {
  /** Conversation turn cap (default MAX_TURNS=8). */
  maxTurns?: number;
  /** Replaces the fill value before execution (placeholder → real credential); after substitution, error feedback never echoes the real value. */
  valueSub?: (v: string) => string;
  /** Callback after each action executes (ok = didn't throw). solidify_case uses it to collect the elements the AI actually touched. */
  onAction?: (action: AiAction, ok: boolean) => void;
  /** Callback after each turn's LLM complete (usage/durationMs/model passed through, for aiUsage accumulation). */
  onUsage?: (r: AiUsageAddend) => void;
  /** UI language: default zh-CN (deterministic fallback when the execution path has no user context). */
  lang?: AiLang;
  /** web resource manifest (name / origin / whether credentials exist) text, rendered by the caller via renderWebResourceManifest. */
  resourceManifest?: string;
  /** Fallback context: this step's mechanical semantics + mechanical failure reason (rendered by buildDegradeContext). Absent by default. */
  degradeContext?: string;
  /** Abort checkpoint (plan-run cancel): polled before each turn's conversation starts; on hit, throws to interrupt the AI step. */
  shouldAbort?: () => boolean | Promise<boolean>;
  /** System-prompt base override: exploratory sessions pass the exploration prompt (the execution prompt's "faithful / no embellishment" rules are the wrong mode for exploration).
   *  Only the base is swapped; the credential-section/manifest assembly logic is unchanged. */
  systemPromptBase?: string;
  /** Callback when the model outputs a findings array this turn (exploratory sessions collect defect candidates).
   *  Timing = after the fail check, before this turn's actions are parsed and executed; await semantics — the callback may screenshot the current page,
   *  capturing the page state at the moment the model testified (actions haven't changed the page yet). */
  onFindings?: (raw: unknown[]) => Promise<void>;
  /** Exploration-scope whitelist (origin list): navigates are only allowed to land within these origins; out-of-scope is rejected upfront.
   *  Absent = unrestricted (verify/login path behavior unchanged); empty array = reject all (the conservative stance when the starting origin is unresolvable).
   *  Exploratory sessions pass the starting origin —
   *  evidenced on 2026-11-10 prod: after the SUT endpoint died, the model, following "page self-check", navigated on its own to the project default
   *  environment's real system, logged in with real credentials and wrote data; the charter's "no leaving" was a pure prompt constraint nobody enforced. */
  scopeOrigins?: string[];
  /** Database evidence channel: sql actions are allowed only when mounted (unmounted = the channel doesn't exist; sql actions are mechanically rejected).
   *  Exploration sessions pass it (when the environment has db objects configured); verify/login/solidify paths don't → zero behavior change.
   *  The platform side only feeds read-only queries: write statements are stopped by sqlGuard's read-only guard before the probe is invoked. */
  runSqlProbe?: (query: string, opts: { limit: number; db?: string }) => Promise<SqlProbeResult>;
  /** Repo code-reading channel: repo actions are allowed only when mounted (exploration sessions with a code commit scope).
   *  Read-only + sandboxed inside the repo worktree (assertInCwd); path escapes/exhausted quota become ok:false inside the channel implementation. */
  runRepoRead?: (req: RepoReadRequest) => Promise<RepoReadResult>;
  /** Destructive-action gate policy: enabled only when passed (verify/login/solidify paths don't → zero behavior change).
   *  allow=false = clicks whose visible text hits destructive keywords are always rejected; allow=true = the user explicitly
   *  authorized at session creation (the exploration session's allow_destructive column), so they pass but still log and leave an action trail. */
  destructivePolicy?: { allow: boolean };
  /** The model's declared "excluded hypotheses" this turn (the negative-result ledger) — the platform persists them based on this. */
  onExcluded?: (items: Array<{ claim: string; evidence: string }>) => void;
}

/**
 * Runtime LLM smart step: a multi-turn "screenshot + element list → LLM decision → execute → feedback" loop,
 * until the LLM declares done/gives up or the turn cap is exceeded. Returns the done summary (used for the step warning).
 * When mobile=true, the mobile system prompt is used instead (accessibility tree / tap / swipe / app control).
 * opts.maxTurns: turn-cap override (verify_case step-by-step uses 5); opts.valueSub: credential placeholder replacement.
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
  // The resource manifest enters the system prompt: the model learns from it which web services exist, which have credentials, and which @name to use.
  // Without a manifest, the old fixed wording is kept (the caller has no environment context; behavior unchanged).
  const manifest = opts?.resourceManifest?.trim() ?? '';
  // Credential capability = valueSub mounted (the real-value substitution channel). Not mounted → the prompt never mentions credentials,
  // the AI can't see the placeholder form, so it won't grab credentials to refill the account/password boxes (measured on 2026-10-26 prod228:
  // with the credential section the AI actively fills __ITEST_USERNAME@web__; without it, only literals).
  const credEnabled = !!opts?.valueSub;
  const systemPrompt = assembleSystemPrompt({ mobile, credEnabled, manifest, base: opts?.systemPromptBase });
  // Credential substitution trail: only the count is recorded, never the real values (real values are never echoed to the LLM/logs).
  let credSubCount = 0;
  const valueSub = opts?.valueSub
    ? (v: string): string => {
        const real = opts.valueSub!(v);
        if (real !== v) credSubCount++;
        return real;
      }
    : undefined;
  let lastResults: string[] = [];
  let pendingShot: { kind: 'element'; selector: string } | { kind: 'crop'; x: number; y: number } | null = null;
  /** Same-target consecutive-failure counter (key = selector or coarse coordinate bucket): 3 misses inject a forced page-self-check instruction, preventing selector spinning. */
  const errStreak = new Map<string, number>();
  // Multi-turn accumulation: each turn appends "this turn's user (+screenshot)" and "the previous turn's raw LLM output" to history,
  // and the request sends the whole thing back. Cache matching is prefix-based; sending only the current turn would make turns 1..N-1 vanish entirely and
  // rebuild the cache from scratch every turn (measured at 2% hit rate on the gateway, 2026-10-14); after accumulation, from turn 2 onward the
  // full history prefix can be hit (measured 86~94%). The assistant side replays the raw JSON output rather than a lastResults summary,
  // so it matches "the context actually received that turn" verbatim and the cache prefix doesn't drift.
  const history: LLMMessage[] = [];
  // In-step rolling sub-goal list (model-maintained, wholesale-replaced + echoed by the platform; always null for simple instructions without a list)
  let subGoals: SubGoal[] | null = null;
  // Negative-result ledger (model-declared "excluded hypotheses"): accumulated across turns, refilled each turn.
  // Enters only the current turn's user message — history is resent byte-for-byte (prefix-based cache matching); touching history would collapse the hit rate.
  const excluded: ExcludedItem[] = [];
  // Cumulative network-request counter (one of the observable-change gate signals, liveRegion.hasObservableChange): each click action
  // window takes a delta. No removeListener — verify runs runAiTask multiple times on the same page, each run's closure counts
  // independently (old listeners only bump the old closure), so the delta semantics stay correct; the leak = one closure per run, negligible.
  // Optional call: prod Pages always have on; test-stub pages without it don't block the main flow (lesson of the console-capture batch:
  // not guarding against missing mock methods = a new batch of permanently red baseline tests).
  let requestCount = 0;
  page.on?.('request', () => {
    requestCount += 1;
  });
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts?.shouldAbort && (await opts.shouldAbort())) {
      throw new Error('计划运行已终止，AI 步骤中断');
    }
    // Each turn waits for render settle before screenshotting (modeled on midscene's WYSIWYG-clicking: the page is identical at screenshot and decision time).
    // Fingerprint convergence is best-effort; on timeout, continue with the current frame, never blocking.
    await waitForPageSettled(page, { timeoutMs: 2500, settleMs: 200 }).catch(() => undefined);
    let buffer: Buffer | null = null;
    let shotMime: 'image/png' | 'image/jpeg' = 'image/png';
    let imageNote = '';
    if (pendingShot) {
      if (pendingShot.kind === 'element') {
        buffer = await shotElement(page, pendingShot.selector);
        if (buffer) imageNote = `附图：你上轮请求的元素 ${pendingShot.selector} 的 4 倍放大白底截图（请仔细逐字符辨认）。\n`;
      } else {
        buffer = await shotCrop(page, pendingShot.x, pendingShot.y);
        if (buffer) {
          shotMime = 'image/jpeg';
          imageNote = `附图：你上轮请求的 (${pendingShot.x},${pendingShot.y}) 附近局部放大截图。全页坐标系不变（视口归一化 0-1000），请以此图校准目标后输出全页坐标。\n`;
        }
      }
      pendingShot = null;
    }
    if (!buffer) {
      // Full-page screenshot timeout fallback: during micro-frontend sub-app switches the page repaints continuously / fonts load slowly, and page.screenshot
      // waiting for stable times out at 5s and throws. It must not blow up the whole AI step here — retry once; if it still fails,
      // continue this turn imageless (the LLM can operate from the element list), and note the reason in the next turn's results.
      // The main screenshot is JPEG (q85): coordinate pointing needs no lossless precision, and it saves substantial tokens vs PNG.
      buffer = await page.screenshot({ timeout: 5000, type: 'jpeg', quality: 85 }).catch(() => null);
      if (buffer) shotMime = 'image/jpeg';
      if (!buffer) {
        buffer = await page.screenshot({ timeout: 5000, type: 'jpeg', quality: 85 }).catch(() => null);
        if (buffer) shotMime = 'image/jpeg';
        if (!buffer) imageNote = '（本轮页面截图超时，无附图；请依赖下方元素清单操作）\n';
      }
    }
    let elements: ElementInfo[] = [];
    try {
      elements = await dumpElements(page);
    } catch (e) {
      logger.warn({ err: e }, 'aiTask dumpElements failed; continuing without element list');
    }
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    const userMessage = [
      `指令：${instruction}`,
      `当前 URL：${page.url()}`,
      `视口：${vp.width}x${vp.height}`,
      imageNote,
      `可交互元素（JSON，box=[x1,y1,x2,y2] 为视口归一化 0-1000 坐标框，与截图对齐；动作坐标按同一坐标系输出）：${JSON.stringify(elements.slice(0, MAX_ELEMENTS))}`,
      subGoals ? renderSubGoals(subGoals) : '',
      opts?.degradeContext ? opts.degradeContext : '',
      lastResults.length > 0 ? `上轮动作结果：\n${lastResults.join('\n')}` : '（首轮，无历史动作）',
      renderExcluded(excluded),
      `第 ${turn}/${maxTurns} 轮。`,
    ].filter(Boolean).join('\n');
    // Screenshot placed before the text: keeps the history order identical to the single-turn form and stabilizes the first-turn prefix.
    history.push({
      role: 'user',
      content: [
        ...(buffer ? [{ type: 'image' as const, base64: buffer.toString('base64'), mime: shotMime }] : []),
        { type: 'text' as const, text: userMessage },
      ],
    });
    const r = await client.complete({
      systemPrompt,
      messages: history,
      lang,
      // Single-turn fields are still provided: implementations without messages support fall back to them; the fallback path is shared.
      userMessage,
      ...(buffer ? { image: { base64: buffer.toString('base64'), mime: shotMime } } : {}),
    });
    opts?.onUsage?.(r);
    const raw = r.kind === 'json' ? JSON.stringify(r.value) : r.value;
    // Replay the LLM's raw output into history (not an action summary): keeps it verbatim-identical to "what the model actually said",
    // otherwise the next turn's prefix mismatches what was actually sent this turn — the cache breakpoint drifts and the hit rate drops.
    history.push({ role: 'assistant', content: [{ type: 'text', text: raw }] });
    const parsed = tryParseJson(raw);
    if (!parsed) {
      lastResults = ['[system] 你的输出不是合法 JSON，请只输出 JSON 对象。'];
      continue;
    }
    if (typeof parsed.fail === 'string' && parsed.fail.trim()) {
      throw new Error(`aiTask 放弃：${parsed.fail.trim()}`);
    }
    // Exploratory sessions: the model's defect candidates reported this turn. Callback before actions execute — a screenshot inside the callback captures the state at testimony time.
    if (opts?.onFindings && Array.isArray(parsed.findings) && parsed.findings.length > 0) {
      await opts.onFindings(parsed.findings);
    }
    // Sub-goal list replaced wholesale (the final state in a done response also lands in subGoals before progress settles)
    const planNow = parseSubGoals(parsed.plan);
    if (planNow) subGoals = planNow;
    // Negative-result ledger: the model declares this turn's verified "exclusions" — accumulated across turns + deduped + the platform notified to persist.
    const excludedNow = parseExcluded(parsed.excluded);
    if (excludedNow.length > 0) {
      for (const e of excludedNow) {
        if (excluded.length >= EXCLUDED_TOTAL_MAX) break;
        if (excluded.some((x) => x.claim === e.claim)) continue;
        excluded.push(e);
      }
      opts?.onExcluded?.(excludedNow);
    }
    const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
      .map(parseAction)
      .filter((a): a is AiAction => a !== null)
      .slice(0, 2);
    lastResults = [];
    for (const a of actions) {
      if (a.type === 'screenshot') {
        // screenshot's selector goes through the same locator query — must pass the same hard gate; when rejected, the screenshot request isn't accepted.
        if (a.selector) {
          const reason = brittleSelectorReason(a.selector);
          if (reason) {
            lastResults.push(`screenshot ${a.selector}: error 脆弱 selector 被拒（${reason}）。改用坐标形态 screenshot @x,y。`);
            opts?.onAction?.(a, false);
            continue;
          }
        }
        if (a.selector) pendingShot = { kind: 'element', selector: a.selector };
        else if (typeof a.x === 'number' && typeof a.y === 'number') pendingShot = { kind: 'crop', x: a.x, y: a.y };
        lastResults.push(`screenshot ${a.selector ?? `@${a.x},${a.y}`}: 已接受，下轮附图`);
        opts?.onAction?.(a, true);
        continue;
      }
      // Database evidence (sql): only sessions with runSqlProbe mounted have this channel (exploration).
      // The read-only guard runs first — write statements are rejected before touching the DB; the probe is never invoked when the guard fails.
      if (a.type === 'sql') {
        const probe = opts?.runSqlProbe;
        const sqlKey = `sql:${a.query.replace(/\s+/g, ' ').slice(0, 40)}`;
        const sqlSelfCheck = `[system] 数据库查询 ${sqlKey} 已连续 3 次失败：不要再用同一条查询重试。换一条更简单的查询（先确认表名/字段名），确实查不到就如实说明，不要反复试。`;
        if (!probe) {
          lastResults.push('sql: error 本会话未开通数据库取证通道（环境未配置可用数据库），不要输出 sql 动作。');
          opts?.onAction?.(a, false);
          const selfCheck = noteStreakFailure(errStreak, sqlKey, sqlSelfCheck);
          if (selfCheck) lastResults.push(selfCheck);
          continue;
        }
        try {
          assertReadOnlySql(a.query);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lastResults.push(`sql: error 只读守卫拒绝（${msg.slice(0, 200)}）。只能跑 SELECT / WITH 开头的只读查询。`);
          opts?.onAction?.(a, false);
          const selfCheck = noteStreakFailure(errStreak, sqlKey, sqlSelfCheck);
          if (selfCheck) lastResults.push(selfCheck);
          logger.info({ query: a.query.slice(0, 120), error: msg.slice(0, 200) }, 'aiTask sql rejected by read-only guard');
          continue;
        }
        try {
          const res = await probe(a.query, { limit: a.limit ?? SQL_PROBE_DEFAULT_ROWS, ...(a.db ? { db: a.db } : {}) });
          if (!res.ok) throw new Error(res.error);
          lastResults.push(
            `sql ok（${res.rowCount} 行${res.truncated ? '，已按 limit 截断' : ''}）：\n${renderSqlProbeRows(res.rows, res.rowCount, res.truncated)}`,
          );
          opts?.onAction?.(a, true);
          errStreak.delete(sqlKey);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lastResults.push(`sql: error ${msg.slice(0, 200)}`);
          opts?.onAction?.(a, false);
          const selfCheck = noteStreakFailure(errStreak, sqlKey, sqlSelfCheck);
          if (selfCheck) lastResults.push(selfCheck);
          logger.info({ query: a.query.slice(0, 120), error: msg.slice(0, 200) }, 'aiTask sql probe failed');
        }
        continue;
      }
      // Repo code reading (repo): only sessions with runRepoRead mounted have this channel (exploration sessions with a code commit scope).
      // Sandbox/quota live in the channel implementation — escapes and over-quota both become ok:false error feedback; no duplicated guarding here.
      if (a.type === 'repo') {
        const read = opts?.runRepoRead;
        const repoKey = `repo:${a.op}:${(a.path ?? a.pattern ?? '').slice(0, 40)}`;
        const repoSelfCheck = `[system] 仓库读取 ${repoKey} 已连续 3 次失败：不要原样重试。不确定路径时先 ls 上级目录，或用 grep 搜代码里的关键词定位文件；确实读不到就如实说明，不要反复猜。`;
        if (!read) {
          lastResults.push('repo: error 本会话未开通仓库读码通道（章程未指定代码提交范围），不要输出 repo 动作。');
          opts?.onAction?.(a, false);
          const selfCheck = noteStreakFailure(errStreak, repoKey, repoSelfCheck);
          if (selfCheck) lastResults.push(selfCheck);
          continue;
        }
        try {
          const req: RepoReadRequest =
            a.op === 'read'
              ? { op: 'read', path: a.path!, offset: a.offset ?? 0, maxLines: a.maxLines ?? REPO_READ_MAX_LINES }
              : a.op === 'grep'
                ? { op: 'grep', pattern: a.pattern!, path: a.path, maxLines: a.maxLines ?? REPO_READ_MAX_LINES }
                : a.op === 'ls'
                  ? { op: 'ls', path: a.path }
                  : { op: 'diff', path: a.path };
          const res = await read(req);
          if (!res.ok) throw new Error(res.error);
          const head = a.op === 'read' ? (a.path ?? '') : a.op === 'grep' ? (a.pattern ?? '') : (a.path ?? '(仓库根)');
          lastResults.push(`repo ${a.op} ${head} ok：\n${res.content.slice(0, REPO_OUTPUT_MAX_CHARS)}`);
          opts?.onAction?.(a, true);
          errStreak.delete(repoKey);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lastResults.push(`repo ${a.op} ${a.path ?? a.pattern ?? ''}: error ${msg.slice(0, 200)}`);
          opts?.onAction?.(a, false);
          const selfCheck = noteStreakFailure(errStreak, repoKey, repoSelfCheck);
          if (selfCheck) lastResults.push(selfCheck);
          logger.info({ op: a.op, path: a.path?.slice(0, 120), error: msg.slice(0, 200) }, 'aiTask repo read failed');
        }
        continue;
      }
      // Same-target consecutive-failure counter (coordinates aggregated into ~25‰ coarse buckets): 3 misses inject a forced self-check instruction, cutting selector/coordinate spinning.
      const streakKey = a.type === 'click' || a.type === 'fill'
        ? (a.selector ?? (typeof a.x === 'number' && typeof a.y === 'number' ? `@${Math.round(a.x / 25)},${Math.round(a.y / 25)}` : null))
        : null;
      const sel = 'selector' in a ? a.selector : null;
      // Brittle-selector hard gate: XPath/positional chains rejected upfront (srbarrios semantics), the error line counts into errStreak —
      // the same dead target rewritten as different brittle selectors is still caught; 3 in a row triggers the self-check injection.
      if (sel) {
        const reason = brittleSelectorReason(sel);
        if (reason) {
          lastResults.push(`${a.type} ${sel}: error 脆弱 selector 被拒（${reason}在微小布局变化下即漂移）。改用坐标主通道（元素清单含与截图对齐的归一化坐标框）或 text=文本 selector。`);
          opts?.onAction?.(toReportAction(a, null), false);
          const selfCheck = noteStreakFailure(errStreak, streakKey);
          if (selfCheck) lastResults.push(selfCheck);
          logger.info({ type: a.type, selector: sel.slice(0, 80), reason }, 'aiTask brittle selector rejected');
          continue;
        }
      }
      // Exploration-scope gate: out-of-scope navigates rejected upfront (no goto). Same method as the brittle-selector hard gate — a rejection is also
      // a failure counted into errStreak; 3 attempts at the same out-of-scope target trigger the self-check injection.
      if (a.type === 'navigate' && opts?.scopeOrigins) {
        const reason = scopeViolationReason(a.url, opts.scopeOrigins);
        if (reason) {
          lastResults.push(`navigate ${a.url}: error 探索范围被拒（${reason}）。只能在起点站点的域名内探索；若起点页面打不开，直接输出 fail 如实说明，不要改去其它站点。`);
          opts?.onAction?.(a, false);
          const selfCheck = noteStreakFailure(errStreak, `navigate:${originOf(a.url) ?? a.url}`);
          if (selfCheck) lastResults.push(selfCheck);
          logger.info({ url: a.url.slice(0, 120), scope: opts.scopeOrigins, reason }, 'aiTask navigate out of scope rejected');
          continue;
        }
      }
      // Destructive-action gate: clicks whose visible text hits destructive keywords (delete/pay/send/approve/sign-off…) are always rejected.
      // Rejected by default; passed only with explicit session authorization (allow_destructive). Charter wording is not authorization —
      // the 2026-11-10 prod record was exactly "the charter asked to verify deletion" → the model clicked delete → the asset was really deleted.
      if (a.type === 'click' && opts?.destructivePolicy) {
        const targetText = clickTargetText(a, elements);
        const reason = destructiveActionReason(targetText);
        if (reason) {
          if (opts.destructivePolicy.allow) {
            logger.info({ type: a.type, target: targetText.slice(0, 80), why: reason }, 'aiTask destructive action allowed by session grant');
          } else {
            lastResults.push(`click ${targetText.slice(0, 60)}: error 该目标被平台判为破坏性/不可逆操作（${reason}），已机械拒收。不要重试或改写措辞绕过；改为输出 finding 描述该入口的风险与缺失的确认机制。`);
            opts?.onAction?.(toReportAction(a, null), false);
            const selfCheck = noteStreakFailure(errStreak, streakKey);
            if (selfCheck) lastResults.push(selfCheck);
            logger.info({ type: a.type, target: targetText.slice(0, 80), why: reason }, 'aiTask destructive action rejected');
            continue;
          }
        }
      }
      const coordPt = typeof (a as { x?: number }).x === 'number' && typeof (a as { y?: number }).y === 'number'
        ? toViewportPt(a as { x?: number; y?: number }, page)
        : null;
      // Action highlight (blackboard): coordinate actions take the box from the resolved element (a small point box when unavailable); selector actions
      // take the box via locator — injected only when someone is watching (the playground live stream); zero DOM/CDP interference otherwise (lazy evaluation).
      // Clearing guarantees the next turn's screenshot / step screenshot isn't polluted.
      if (coordPt) {
        const pt = coordPt;
        const intent = a.type === 'fill' ? 'fill' : 'click';
        await annotateAction(page, async () =>
          (await resolveAtPoint(page, pt.px, pt.py, intent))?.box ?? { x: pt.px - 10, y: pt.py - 10, width: 20, height: 20 });
      } else if (sel) {
        await annotateAction(page, () => page.locator(sel).first().boundingBox().catch(() => null));
      }
      // Observable-change sampling: capture a live-region baseline before click/fill/press (first-hand toast/notice evidence);
      // click additionally saves a change-gate snapshot (URL/visual fingerprint/request count).
      const observe = a.type === 'click' || a.type === 'fill' || a.type === 'press';
      const beforeMsgs = observe ? await captureLiveRegionMessages(page) : [];
      const clickBefore: ChangeSnapshot | null = a.type === 'click'
        ? { url: page.url(), fingerprint: await pageFingerprint(page), requests: requestCount, messages: beforeMsgs }
        : null;
      try {
        const outcome = await execAction(page, a, valueSub);
        lastResults.push(outcome.report);
        // onAction reports the selector form (coordinates already resolved and backfilled); the solidify/cache pipeline shape is unchanged.
        opts?.onAction?.(toReportAction(a, outcome.resolvedSelector), true);
        if (streakKey != null) errStreak.delete(streakKey);
        // Brief settle after page-altering actions so the next action isn't built on stale knowledge (modeled on midscene).
        // press included: Enter/Escape often trigger submit/dialog-close; message extraction needs a stable window.
        if (a.type === 'click' || a.type === 'fill' || a.type === 'press' || a.type === 'navigate') await settleAfterAction(page);
        if (observe) {
          const afterMsgs = await captureLiveRegionMessages(page);
          const newMsgs = diffNewMessages(beforeMsgs, afterMsgs);
          if (newMsgs.length > 0) {
            // The app's own toast/notice text (aria-live region) fed back as first-hand evidence — an unreadable screenshot is no excuse for a missed report.
            lastResults.push(`页面消息: ${newMsgs.slice(0, 3).map((m) => `"${m.slice(0, 160)}"`).join('、')}`);
          }
          // Observable-change gate (explorbot hasObservablePageChange semantics): all four signals unchanged = an invalid
          // click (target occluded/disabled/hit a non-interactive element). Counted into errStreak — 3 in a row on the same dead target triggers the self-check, cutting spinning.
          if (clickBefore) {
            const clickAfter: ChangeSnapshot = {
              url: page.url(),
              fingerprint: await pageFingerprint(page),
              requests: requestCount,
              messages: afterMsgs,
            };
            if (!hasObservableChange(clickBefore, clickAfter, newMsgs)) {
              lastResults.push('[system] 页面无观测变化：点击已执行但 URL/画面/网络请求/消息区域均未变——目标可能被遮挡、禁用或命中了非交互元素。不要原样重试同一目标；换用元素清单坐标或换目标。');
              const selfCheck = noteStreakFailure(errStreak, streakKey);
              if (selfCheck) lastResults.push(selfCheck);
              logger.info({ target: sel ?? `@${(a as { x?: number }).x},${(a as { y?: number }).y}`, instruction: instruction.slice(0, 80) }, 'aiTask click no observable change');
            }
          }
        }
      } catch (e) {
        // Missing credentials are an environment-level hard error: feeding it back to the LLM would only make it spin on selectors burning calls; terminate the step directly
        // (EnvMissing/SecretMissing are thrown by valueSub, carrying actionable configuration guidance).
        if (e instanceof Error && (e.name === 'EnvMissing' || e.name === 'SecretMissing')) throw e;
        opts?.onAction?.(toReportAction(a, null), false);
        const target = sel ?? (coordPt ? `@${(a as { x?: number }).x},${(a as { y?: number }).y}` : ('url' in a ? a.url : a.type));
        lastResults.push(`${a.type} ${target}: error ${e instanceof Error ? e.message.slice(0, 150) : String(e)}`);
        const selfCheck = noteStreakFailure(errStreak, streakKey);
        if (selfCheck) lastResults.push(selfCheck);
      } finally {
        await clearAnnotation(page);
      }
    }
    if (actions.length === 0) {
      lastResults.push('[system] 没有可执行的动作（actions 为空）。如需结束请输出 done 或 fail。');
    }
    // Actions execute before ending: the LLM may carry final actions in a done response (e.g. filling the captcha).
    if (parsed.done === true) {
      const s = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      // Sub-goal progress trail: reports/DB can see the settled state of the in-step plan (guards against "final state looks done" style overclaiming).
      const goalNote = subGoals
        ? `（子目标 ${subGoals.filter((g) => g.done).length}/${subGoals.length} 完成）`
        : '';
      const credNote = credSubCount > 0 ? `（凭据占位符已替换 ${credSubCount} 处为环境凭据）` : '';
      // Credential substitution trail: reports show "this step really used environment credentials", aiding after-the-fact interpretation.
      return `${s}${goalNote}${credNote}`;
    }
  }
  // Turn-exhaustion fallback: steps completable with zero actions (confirmatory/conditional instructions whose target state is already on the page) were out-of-distribution
  // samples under the done-criteria rules — the model dared not done with zero actions and spun "looking for things to do" until exhaustion (2026-11-08 prod228
  // record: the login case's "check input box display" step died 5 turns ×41s; the post-hoc attribution showed the LLM had already judged "goal achieved",
  // but attribution only writes a note and doesn't change the verdict). Here the current page screenshot is used to ask once "is the goal achieved"; if so, the verdict flips to passed.
  // Strict judgment prevents false positives: anything short of an explicit achieved:true keeps throwing as before; judgment failure also keeps throwing (best-effort).
  try {
    const shot = await page.screenshot({ timeout: 5000, type: 'jpeg', quality: 85 });
    const r = await client.complete({
      systemPrompt: `你是测试步骤完成判定器。给你一条测试指令和当前页面截图，判断该指令期望的目标状态是否已在当前页面达成。
确认式/条件式指令（「确认…已…」「若…则…」「等待…出现」）在目标状态已存在、无需任何操作时也算达成。
只输出 JSON：{"achieved":true,"reason":"<一句话证据>"} 或 {"achieved":false,"reason":"<缺什么>"}。页面处于加载中/骨架屏/目标状态不明确时输出 {"achieved":false}。`,
      userMessage: `指令：${instruction}`,
      image: { base64: shot.toString('base64'), mime: 'image/jpeg' },
      lang,
    });
    opts?.onUsage?.(r);
    const fp = tryParseJson(r.kind === 'json' ? JSON.stringify(r.value) : r.value);
    if (fp?.achieved === true) {
      const reason = typeof fp.reason === 'string' ? fp.reason.trim().slice(0, 120) : '';
      logger.info({ instruction: instruction.slice(0, 80), reason }, 'aiTask zero-action fallback: goal achieved');
      return `目标已达成，零动作完成（轮数耗尽兜底判定）：${reason}`;
    }
  } catch {
    // Fallback judgment failure keeps throwing as a timeout
  }
  throw new Error(`aiTask 超过 ${maxTurns} 轮未完成：${instruction.slice(0, 80)}`);
}
