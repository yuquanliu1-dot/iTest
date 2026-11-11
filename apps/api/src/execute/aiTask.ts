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

// 闸门与元素抽取已抽到共享模块（探索走 pi 工具链后要复用同一份口径）。
// 这里原样再导出，aiTask 的既有对外表面（测试与 exploration.ts 的 import 路径）不变。
export { brittleSelectorReason, destructiveActionReason, originOf, renderSqlProbeRows, scopeViolationReason };

/** 单条指令的最大对话轮数（每轮一次 LLM 调用）。 */
const MAX_TURNS = 8;
/** 每轮喂给 LLM 的可交互元素上限，防止提示词膨胀。 */
const MAX_ELEMENTS = 60;

/** 系统提示词主体（不含凭据段）。凭据段按需拼接——见 assembleSystemPrompt。
 *  坐标协议（对标 midscene）：模型用截图上的归一化坐标指认目标，平台换算成视口像素执行
 *  ——视觉与动作同通道，消灭「看到了哪个元素 → 写出它的 selector」的翻译损耗；坐标点击
 *  天然穿透 iframe/shadow DOM（qiankun 微前端友好）。selector 降级为兜底通道。 */
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

/** 凭据规则：仅在本次步骤确实需要凭据能力时才拼进系统提示词。 */
const CREDENTIAL_RULE = `- 凭据（用户名/密码）：fill 的 value 用字面量 __ITEST_USERNAME@服务名__ / __ITEST_PASSWORD@服务名__（服务名取自下方资源清单里的 name；平台在填入的瞬间替换为真实值）；不要输出 {{}} 变量模板，平台不替换模板。`;

/**
 * 拼装系统提示词。
 *  credEnabled=false → 完全不含凭据段：AI 看不到占位符形态，就不会拿凭据去重填账号/密码框
 *  （2026-10-26 prod228 实测：含凭据段时 AI 会主动 fill __ITEST_USERNAME@web__；不含则只填字面量）。
 *  mobile 版不拼凭据段（移动端无 web 凭据语义）。
 */
export function assembleSystemPrompt(opts: { mobile?: boolean; credEnabled: boolean; manifest: string; base?: string }): string {
  if (opts.mobile) return MOBILE_SYSTEM_PROMPT;
  // base 覆盖点：探索式会话传探索提示词（执行忠实规则对探索是错误模式）；凭据段拼装逻辑不变。
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

/** click/fill 双形态：坐标（模型主通道，视口归一化 0-1000）或 selector（兜底/解析回填）。
 *  onAction 对外尽量上报 selector 形态（坐标解析回元素后回填），固化/缓存管线形状不变。 */
export type AiAction =
  | { type: 'click'; selector?: string; x?: number; y?: number }
  | { type: 'fill'; selector?: string; x?: number; y?: number; value: string }
  | { type: 'press'; key: string }
  | { type: 'wait'; ms: number }
  | { type: 'navigate'; url: string }
  | { type: 'screenshot'; selector?: string; x?: number; y?: number }
  /** 数据库取证（探索会话专用通道）：对被测系统自己的库跑一条只读查询。
   *  db = 环境 db 对象的 label（缺省 = 环境默认库）；limit = 取回行数上限。 */
  | { type: 'sql'; query: string; limit?: number; db?: string }
  /** 仓库读码（探索会话专用通道，有代码提交范围时开通）：只读查看改动代码。
   *  read=读文件（offset 起始行 + maxLines 行数上限，大文件读改动段用）；
   *  grep=按正则/字面量搜码；ls=列目录；
   *  diff=看范围改动（无 path 时整范围，带 path 时限单文件）。 */
  | { type: 'repo'; op: 'read' | 'grep' | 'ls' | 'diff'; path?: string; pattern?: string; offset?: number; maxLines?: number };

/** sql 取证的单次回灌上限：行数 / 单元格 / 单行 / 整块四级封顶（反馈进下一轮 userMessage，不能无限膨胀）。 */
export const SQL_PROBE_MAX_ROWS = 20;
export const SQL_PROBE_DEFAULT_ROWS = 20;

/** repo 读码的回灌封顶：整块字符数（防御性截断；行数/匹配数的语义封顶在通道实现里做）。 */
export const REPO_OUTPUT_MAX_CHARS = 6000;
/** repo read 单次最大行数（parseAction 钳制 + 通道实现共用同一口径）。 */
export const REPO_READ_MAX_LINES = 200;
/** repo path/pattern 字段长度上限（parseAction 截断——模型可能吐超长串）。 */
const REPO_FIELD_MAX = 200;

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

/** 0-1000 归一化坐标的钳制与数值校验（非有限数 → null）。 */
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
    // 坐标优先；selector 兜底（两者都在时按坐标执行，selector 由平台解析回填）
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
    // selector 形态（元素 4x 放大）与坐标形态（局部区域裁剪放大）二选一。
    if (typeof o.selector === 'string' && o.selector) return { type, selector: o.selector };
    if (clampCoord(o.x) !== null && clampCoord(o.y) !== null) return { type, x: clampCoord(o.x)!, y: clampCoord(o.y)! };
    return null;
  }
  if (type === 'sql') {
    // 只做形状校验：长度与只读判定留给动作循环里的守卫——那里能给出可行动的错误行，
    // 在这里判死会让动作被静默丢弃、模型学不到原因。
    // 键名容忍：模型可能写 query/sql、db/dbRef。
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
    // 只做形状校验与截断：路径存在性/沙箱/配额留给动作循环里的通道守卫——
    // 在这里判死会让动作被静默丢弃、模型学不到原因。
    // 键名容忍：模型可能写 op/action、pattern/q、path/file。
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

/** 点击目标 → 元素清单里的可见文本（坐标按归一化框包含判定；selector 按等值匹配）。
 *  清单里找不到 → 返回空串 = 放行：清单只收可交互元素且上限 60，模型可能点在清单外，
 *  宁可漏判也不误杀正常探索（真正的防线仍是给被测环境配可丢弃的数据）。 */
function clickTargetText(a: AiAction, elements: ElementInfo[]): string {
  if (a.type !== 'click') return '';
  const hit =
    typeof a.x === 'number' && typeof a.y === 'number'
      ? elements.find((e) => a.x! >= e.box[0] && a.x! <= e.box[2] && a.y! >= e.box[1] && a.y! <= e.box[3])
      : elements.find((e) => e.selector === a.selector);
  return destructiveTextOf(hit, typeof a.selector === 'string' ? a.selector : '');
}

/** 坐标动作的解析结果：该点命中的元素（selector 合成与 dumpElements 共用 SYNTH_SELECTOR_SRC）。 */
interface PointTarget {
  selector: string;
  /** 合成选择器在页内是否唯一命中；false 时上报链保持坐标形态（固化管线保守拒绝）。 */
  unique?: boolean;
  tag: string;
  text?: string;
  /** input/textarea 的当前值（fill 回读用）。 */
  value?: string;
  /** 该元素是「已展开下拉」的过滤输入框（Element UI / Ant Design）——fill 收尾不得 blur。 */
  dropdownFilter?: boolean;
  box: { x: number; y: number; width: number; height: number };
}

/** 视口归一化 0-1000 → CSS 像素。viewportSize 不可得时按执行器标准视口 1280x800 回落。 */
function toViewportPt(a: { x?: number; y?: number }, page: Page): { px: number; py: number } {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  return {
    px: Math.round(((a.x ?? 0) / 1000) * vp.width),
    py: Math.round(((a.y ?? 0) / 1000) * vp.height),
  };
}

/** 解析视口坐标上的目标元素：P1 的关键——坐标动作执行前把目标解析回稳定 selector，
 *  onAction 据此上报 selector 形态（固化/缓存管线不变），box 供动作高亮，value 供 fill 回读。
 *  intent='fill'：命中包装容器（label/div 蒙在 input 上）时下沉到内部首个可见输入控件——回读语义以控件为准。
 *  intent='click'：命中内层非交互节点（如 button 内层 span）时上浮最多 5 层取最近交互祖先——
 *  合成目标与高亮 box 以祖先为准（整按钮框），不再产出裸 span。
 *  选择器合成与 dumpElements 共用 SYNTH_SELECTOR_SRC，附唯一性判定（unique）。
 *  坐标点击本身穿透 iframe/shadow DOM，这里解析不到（返回 null）只影响上报形态，不影响执行。 */
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
        // 「已展开下拉的过滤输入框」判定（Element UI / Ant Design）：这类控件在 blur 时会
        // 清空查询词、关掉候选面板——fill 收尾必须跳过 Tab，否则远程搜索下拉永远选不中。
        // 判据与 dropdownFilter.ts 同款（宿主 + 是否已展开），此处内联是因为 page.evaluate
        // 不能引用模块作用域标识符。
        let dropdownFilter = false;
        {
          // closest 不可用时不抛（探测是可选增强，抛了会连带丢掉 selector 富化）
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

/** onAction 上报形态：坐标动作在解析出稳定且页内唯一的 selector 时回填为 selector 形态——
 *  mapAiActionsToCompiled / aiTaskCache / solidify 轨迹管线只见 selector 形态，形状不变。
 *  解析失败或非唯一（unique=false，如裸 span 无富化信号）则原样上报坐标动作
 *  （映射层会拒绝固化该步，保守回落 aiTask——非唯一 selector 机械回放会静默点错）。 */
function toReportAction(a: AiAction, resolvedSelector: string | null | undefined): AiAction {
  if ((a.type === 'click' || a.type === 'fill') && typeof a.x === 'number' && resolvedSelector) {
    return a.type === 'fill'
      ? { type: 'fill', selector: resolvedSelector, value: a.value }
      : { type: 'click', selector: resolvedSelector };
  }
  return a;
}

/** 步内子目标（对标 midscene deepThink sub-goals，滚动维护给模型方向感）：
 *  模型每轮随 JSON 输出完整清单，平台整段替换并回显进下一轮 userMessage。 */
export interface SubGoal {
  text: string;
  done: boolean;
}

/** 宽容解析：接受 [{text,done}] / ["文本"] 混合；全无效返回 null（best-effort，不纠错不反馈）。 */
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

/** 回显进 userMessage 的进度块（首轮无清单时不出现）。 */
function renderSubGoals(goals: SubGoal[]): string {
  const lines = goals.map((g, i) => `${i + 1}. [${g.done ? '完成' : '进行中'}] ${g.text}`);
  return `子目标进度（你维护的清单，截图确认生效后标 done:true）：\n${lines.join('\n')}`;
}

// —— 负面结果账本（外化记忆的最小切片）——
// 只存「已排除的假设」，不存信念：黑板存信念会把观察冻成结论、自我印证，
// 而探索测试的产出是信息（哪些路径已排除），不是结论。
// 平台不猜负面结果（失败动作、无观测变化都是过程噪音），由模型申报、平台持久化并回灌。

/** 单轮申报条数上限 / 单条文本上限 / 会话累计上限（回灌块不能无限膨胀）。 */
const EXCLUDED_PER_TURN_MAX = 5;
const EXCLUDED_ITEM_MAX = 120;
const EXCLUDED_TOTAL_MAX = 20;

/** 模型申报的排除项。 */
export interface ExcludedItem {
  claim: string;
  evidence: string;
}

/** 宽容解析：接受 [{claim,evidence}] / [字符串]；无效条目丢弃（best-effort，不纠错不反馈）。 */
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

/** 回灌进 userMessage 的排除块（空账本不出现在 userMessage 里）。 */
export function renderExcluded(items: ExcludedItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map((e) => `- ${e.claim}${e.evidence ? `（依据：${e.evidence}）` : ''}`);
  return `已排除（你申报并已验证过的路径，不要重复探索）：\n${lines.join('\n')}`;
}

/** 动作后短暂稳定（对标 midscene 300ms + networkIdle）：导航/重渲染落地后再进下一个动作。 */
async function settleAfterAction(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => undefined);
  await page.waitForTimeout(150);
}

/** 执行单个动作，返回给 LLM 的结果描述 + 坐标动作解析出的稳定 selector。
 *  resolvedSelector 仅在解析成功且页内唯一（unique !== false）时给出——非唯一时为 null，
 *  上报链保持坐标形态、固化管线保守拒绝该步。
 *  valueSub：fill value 执行前替换（占位符 → 真实凭据）；发生替换后反馈不回显真实值。 */
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
        // 打字后、blur 前探测：远程搜索下拉（Element UI remote+filterable）在 blur 时会清空
        // 查询词、关掉候选面板，输入值被抹成 ""——这类控件必须跳过 Tab，且回读取 blur 前的值
        // （blur 之后读到的必然是空，AI 会误判"填不进去"并反复重试）。
        const typed = await resolveAtPoint(page, px, py, 'fill');
        const keepOpen = typed?.dropdownFilter === true;
        if (!keepOpen) {
          // React 受控表单常在 blur 时才提交 state / 触发校验；与 selector 路径保持一致。
          await page.keyboard.press('Tab').catch(() => undefined);
          await page.waitForTimeout(80);
        }
        const after = keepOpen ? typed : await resolveAtPoint(page, px, py, 'fill');
        const actual = typeof after?.value === 'string' ? after.value : null;
        const label = before?.selector ? `@${action.x},${action.y}（${before.selector}）` : `@${action.x},${action.y}`;
        const resolvedSel = before && before.unique !== false ? before.selector : null;
        if (actual !== null && actual !== realValue) {
          // 发生替换（凭据类 fill）时不回显 actual/目标值——防密码片段泄漏回 LLM。
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
      // 已展开下拉的过滤输入框不能 blur：blur 会清空查询词、关掉候选面板（远程搜索下拉致命，
      // 后续步骤就点不到候选了）。判定在打字之后——此时面板才可能处于展开态。
      const keepOpen = await isOpenDropdownFilter(loc);
      if (!keepOpen) {
        // React 受控表单常在 blur 时才提交 state / 触发校验；与 cdp.ts dispatch fill 保持一致。
        await page.keyboard.press('Tab').catch(() => undefined);
        // 简短停顿让 onChange/blur 事件落地（Antd 等库在 blur 后异步校验）。
        await page.waitForTimeout(80);
      }
      // 回读确认：若 DOM value 与目标不一致，把实际值反馈给 LLM 以便下轮修正。
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
      // 与 init-goto 对齐：等 SPA hydrate，长连接页面 5s 兜底不阻塞。
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      return { report: `navigate ${action.url}: ok` };
    }
    case 'screenshot': {
      // 不在这里截图：标记后由主循环在下一轮开头截 4x 白底图（selector）/ 坐标裁剪放大图（x,y）
      const label = action.selector ?? `@${action.x},${action.y}`;
      return { report: `screenshot ${label}: 已接受，下轮附图` };
    }
    case 'sql': {
      // sql 动作由主循环单独处理（不进浏览器执行器）；走到这里说明有漏网路径——判死而非静默无返回。
      throw new Error('sql 动作不应进入浏览器动作执行器');
    }
    case 'repo': {
      // repo 动作同 sql：由主循环单独处理，漏网路径判死。
      throw new Error('repo 动作不应进入浏览器动作执行器');
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

/** 坐标点附近区域的局部裁剪截图（deepLocate 两段式适配：密集/相似元素区域校准定位）。
 *  点位为中心裁边长 min(480, 视口短边) 的方块（≥ midscene 400×400 下限），clamp 视口边界。
 *  不做数字放大：VL 模型无新信息增益，且不换坐标系（附图仅校准，动作仍按全页坐标输出）。 */
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

/** 数据库取证的探针结果（调用方提供实现；平台只喂只读查询）。 */
export type SqlProbeResult =
  | { ok: true; rowCount: number; truncated: boolean; rows: Array<Record<string, unknown>> }
  | { ok: false; error: string };

/** 仓库读码请求（repo 动作的平台侧形状；调用方实现只读访问 + 沙箱限仓库根）。 */
export type RepoReadRequest =
  | { op: 'read'; path: string; offset: number; maxLines: number }
  | { op: 'grep'; pattern: string; path?: string; maxLines: number }
  | { op: 'ls'; path?: string }
  | { op: 'diff'; path?: string };

/** 仓库读码结果：content 由调用方按语义封顶（行数/匹配数），aiTask 侧再防御性截整块。 */
export type RepoReadResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

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
  /** 终止检查点（计划运行取消）：每轮对话开始前轮询，命中即抛错中断 AI 步骤。 */
  shouldAbort?: () => boolean | Promise<boolean>;
  /** 系统提示词基底覆盖：探索式会话传探索提示词（执行提示词的「忠实/不加戏」规则对探索是错误模式）。
   *  只换基底，凭据段/资源清单拼装逻辑不变。 */
  systemPromptBase?: string;
  /** 模型当轮输出 findings 数组时的回调（探索式会话收集缺陷候选）。
   *  调用时机 = fail 检查之后、本轮动作解析执行之前；await 语义——回调内可截当前页截图，
   *  取到的是模型作证时的页面状态（动作尚未改变页面）。 */
  onFindings?: (raw: unknown[]) => Promise<void>;
  /** 探索范围白名单（origin 列表）：navigate 只允许落在这些 origin 内，越界事前拒收。
   *  缺省不传 = 不设限（verify/登录路径行为不变）；传空数组 = 全拒（起点 origin 不可解析时的保守口径）。
   *  探索式会话传起点 origin——
   *  2026-11-10 prod 实证：SUT 端点挂掉后模型按「页面自检」自主导航到了项目默认环境
   *  的真实系统并用真凭据登录、写入了数据；charter 的「禁止离开」纯提示词约束无人执行。 */
  scopeOrigins?: string[];
  /** 数据库取证通道：挂上才允许 sql 动作（未挂 = 通道不存在，sql 动作被机械拒收）。
   *  探索会话传（环境配了 db 对象时）；verify/登录/solidify 路径不传 → 行为零变化。
   *  平台侧只喂只读查询：写语句在调用探针前就被 sqlGuard 的只读守卫拦下。 */
  runSqlProbe?: (query: string, opts: { limit: number; db?: string }) => Promise<SqlProbeResult>;
  /** 仓库读码通道：挂上才允许 repo 动作（有代码提交范围的探索会话）。
   *  只读 + 沙箱限仓库工作树内（assertInCwd）；路径越界/配额耗尽在通道实现里转成 ok:false。 */
  runRepoRead?: (req: RepoReadRequest) => Promise<RepoReadResult>;
  /** 破坏性动作闸策略：传了才启用（verify/登录/solidify 路径不传 → 行为零变化）。
   *  allow=false = 点击可见文本命中破坏性关键词一律拒收；allow=true = 用户在建会话时
   *  显式授权（探索会话的 allow_destructive 列），放行但仍写日志与留痕。 */
  destructivePolicy?: { allow: boolean };
  /** 模型本轮申报的「已排除的假设」（负面结果账本）——平台侧据此落库。 */
  onExcluded?: (items: Array<{ claim: string; evidence: string }>) => void;
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
  const systemPrompt = assembleSystemPrompt({ mobile, credEnabled, manifest, base: opts?.systemPromptBase });
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
  let pendingShot: { kind: 'element'; selector: string } | { kind: 'crop'; x: number; y: number } | null = null;
  /** 同目标连续失败计数（key=selector 或坐标粗桶）：3 连错注入强制页面自检指令，防换 selector 空转。 */
  const errStreak = new Map<string, number>();
  // 多轮累积：每轮把「本轮 user（+截图）」与「上轮 LLM 原始输出」追加到 history，
  // 请求时整段回传。缓存按前缀匹配，只发当轮会让第 1..N-1 轮内容彻底消失、
  // 每轮都从零建缓存（2026-10-14 网关实测命中率 2%）；累积后第 2 轮起可命中
  // 全部历史前缀（实测 86~94%）。assistant 侧回放原始 JSON 输出而非 lastResults 摘要，
  // 以保证与"当轮实际收到的上下文"逐字一致、缓存前缀不漂移。
  const history: LLMMessage[] = [];
  // 步内子目标滚动清单（模型自维护，平台整段替换+回显；无清单的简单指令恒为 null）
  let subGoals: SubGoal[] | null = null;
  // 负面结果账本（模型申报的「已排除的假设」）：跨轮累计、逐轮回灌。
  // 只进当轮 user message —— history 逐字节重发（缓存按前缀匹配），动历史会让命中率崩掉。
  const excluded: ExcludedItem[] = [];
  // 网络请求累计计数（可观测变化闸信号之一，liveRegion.hasObservableChange）：每个 click 动作
  // 窗口取 delta。不做 removeListener——verify 会在同一 page 上多次 runAiTask，各 run 闭包独立
  // 计数（旧监听器只 bump 旧闭包），delta 语义仍正确；泄漏量 = 每 run 一个闭包，可忽略。
  // 可选调用：prod Page 恒有 on；测试桩 page 没有也不拦主流程（console-capture 批次教训：
  // 对 mock 缺的方法不设防 = 新增一批永久基线红）。
  let requestCount = 0;
  page.on?.('request', () => {
    requestCount += 1;
  });
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts?.shouldAbort && (await opts.shouldAbort())) {
      throw new Error('计划运行已终止，AI 步骤中断');
    }
    // 每轮先等渲染静默再截图（对标 midscene 所见即所点：截图时刻与决策时刻页面一致）。
    // 指纹收敛 best-effort，超时按当前帧继续，绝不阻塞。
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
      // 全页截图超时降级：微前端子应用切换时页面持续重绘/字体慢加载，page.screenshot
      // 等 stable 会 5s 超时抛错。这里不能让它炸掉整个 AI 步骤——重试一次，仍失败则
      // 无图继续本轮（LLM 靠元素清单也能操作），并在下轮结果里标注无图原因。
      // 主截图走 JPEG（q85）：坐标指认不需要无损精度，token 显著省于 PNG。
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
    // 截图放在文本之前：与单轮形态的历史顺序保持一致，且首轮前缀稳定。
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
      // 单轮字段仍给：无 messages 支持的实现按它们走；回退路径共用。
      userMessage,
      ...(buffer ? { image: { base64: buffer.toString('base64'), mime: shotMime } } : {}),
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
    // 探索式会话：模型本轮报告的缺陷候选。在动作执行前回调——回调内截图取的是作证时的页面状态。
    if (opts?.onFindings && Array.isArray(parsed.findings) && parsed.findings.length > 0) {
      await opts.onFindings(parsed.findings);
    }
    // 子目标清单整段替换（done 响应里的最终状态也先落到 subGoals 再结算进度）
    const planNow = parseSubGoals(parsed.plan);
    if (planNow) subGoals = planNow;
    // 负面结果账本：模型申报本轮已验证过的「排除项」——跨轮累计 + 去重 + 通知平台落库。
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
        // screenshot 的 selector 同样拿 locator 查询——同过硬闸，拒绝时不接受截图请求。
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
      // 数据库取证（sql）：只挂 runSqlProbe 的会话才有这个通道（探索）。
      // 只读守卫先行——写语句在触库前被拒，守卫不通过时绝不调用探针。
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
      // 仓库读码（repo）：只挂 runRepoRead 的会话才有这个通道（有代码提交范围的探索会话）。
      // 沙箱/配额在通道实现里——越界与超额都转成 ok:false 的错误反馈，这里不再重复守卫。
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
      // 同目标连续失败计数（坐标按 ~25‰ 粗桶聚合）：3 连错注入强制自检指令，砍 selector/坐标空转。
      const streakKey = a.type === 'click' || a.type === 'fill'
        ? (a.selector ?? (typeof a.x === 'number' && typeof a.y === 'number' ? `@${Math.round(a.x / 25)},${Math.round(a.y / 25)}` : null))
        : null;
      const sel = 'selector' in a ? a.selector : null;
      // 脆弱 selector 硬闸：XPath/位置链事前拒收（srbarrios 口径），错误行计入 errStreak——
      // 同一死目标换着花样写脆弱 selector 也拦得住，3 连触发自检注入。
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
      // 探索范围闸：navigate 越界事前拒收（不 goto）。与脆弱 selector 硬闸同法——拒收也是一次
      // 失败，计入 errStreak，同一越界目标反复尝试 3 次触发自检注入。
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
      // 破坏性动作闸：点击可见文本命中破坏性关键词（删除/支付/发送/审批/注销…）一律拒收。
      // 默认拒；会话显式授权（allow_destructive）才放行。charter 说辞不算授权——
      // 2026-11-10 prod 实录正是"章程要求核查删除"→ 模型点了删除 → 资产真被删。
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
      // 动作高亮（blackboard）：坐标动作按解析元素取盒（拿不到给点位小盒），selector 动作按
      // locator 取盒——有人观看（playground 画面流）时注入，无人观看零 DOM/CDP 干扰（懒求值）。
      // 清除保证下轮截图/步截图不被污染。
      if (coordPt) {
        const pt = coordPt;
        const intent = a.type === 'fill' ? 'fill' : 'click';
        await annotateAction(page, async () =>
          (await resolveAtPoint(page, pt.px, pt.py, intent))?.box ?? { x: pt.px - 10, y: pt.py - 10, width: 20, height: 20 });
      } else if (sel) {
        await annotateAction(page, () => page.locator(sel).first().boundingBox().catch(() => null));
      }
      // 可观测变化采样：click/fill/press 动作前抓 live-region 基线（toast/提示一手证据），
      // click 另存变化闸快照（URL/视觉指纹/请求数）。
      const observe = a.type === 'click' || a.type === 'fill' || a.type === 'press';
      const beforeMsgs = observe ? await captureLiveRegionMessages(page) : [];
      const clickBefore: ChangeSnapshot | null = a.type === 'click'
        ? { url: page.url(), fingerprint: await pageFingerprint(page), requests: requestCount, messages: beforeMsgs }
        : null;
      try {
        const outcome = await execAction(page, a, valueSub);
        lastResults.push(outcome.report);
        // onAction 上报 selector 形态（坐标已解析回填），固化/缓存管线形状不变。
        opts?.onAction?.(toReportAction(a, outcome.resolvedSelector), true);
        if (streakKey != null) errStreak.delete(streakKey);
        // 会改页面的动作后短暂稳定，下一个动作不建立在过期认知上（对标 midscene）。
        // press 纳入：Enter/Escape 常触发提交/关弹窗，消息提取需要稳定窗口。
        if (a.type === 'click' || a.type === 'fill' || a.type === 'press' || a.type === 'navigate') await settleAfterAction(page);
        if (observe) {
          const afterMsgs = await captureLiveRegionMessages(page);
          const newMsgs = diffNewMessages(beforeMsgs, afterMsgs);
          if (newMsgs.length > 0) {
            // 应用自己吐的 toast/提示文本（aria-live 区域），一手证据回喂——截图读不清不成为漏报理由。
            lastResults.push(`页面消息: ${newMsgs.slice(0, 3).map((m) => `"${m.slice(0, 160)}"`).join('、')}`);
          }
          // 可观测变化闸（explorbot hasObservablePageChange 口径）：点击四路信号全无变化 = 无效
          // 点击（目标被遮挡/禁用/命中非交互元素）。计入 errStreak——同一死目标 3 连触发自检，砍空转。
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
        // 凭据缺失是环境级硬错误：反馈给 LLM 只会让它换 selector 空转烧调用，直接终止本步
        // （EnvMissing/SecretMissing 由 valueSub 抛出，携带可行动的配置指引）。
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
    // 先执行动作再结束：LLM 可能在 done 响应里携带最终动作（如 fill 验证码）。
    if (parsed.done === true) {
      const s = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      // 子目标进度留痕：报告/DB 能看到步内计划的结算状态（防"终态像完成"式的虚报）。
      const goalNote = subGoals
        ? `（子目标 ${subGoals.filter((g) => g.done).length}/${subGoals.length} 完成）`
        : '';
      const credNote = credSubCount > 0 ? `（凭据占位符已替换 ${credSubCount} 处为环境凭据）` : '';
      // 凭据替换留痕：报告里能看到「本步真的用了环境凭据」，便于事后判读。
      return `${s}${goalNote}${credNote}`;
    }
  }
  // 轮数耗尽兜底：零动作可完成的步骤（确认式/条件式指令，目标状态已在页面）曾是完成判据
  // 规则下的分布外样本——模型不敢零动作 done，反复「找事做」空转到耗尽（2026-11-08 prod228
  // 实录：登录用例的「检查输入框展示」步 5 轮 ×41s 全灭，事后归因 LLM 已判「目标已达成」
  // 但归因只写 note 不改判定）。这里用当前页面截图问一次「目标是否已达成」，达成则改判通过。
  // 严判防假阳性：非明确 achieved:true 一律照旧抛错；判定失败也照旧抛错（best-effort）。
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
    // 兜底判定失败照旧按超时抛错
  }
  throw new Error(`aiTask 超过 ${maxTurns} 轮未完成：${instruction.slice(0, 80)}`);
}
