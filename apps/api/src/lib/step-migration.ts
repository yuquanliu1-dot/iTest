import type { StepAction } from '@itest/shared';

/** 老 DSL → 新 DSL 的就地升级，幂等。已迁移结构直接原样返回；未知 kind 原样返回。 */
export function migrateAction(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const action = raw as Record<string, unknown>;
  const kind = action.kind;

  if (kind === 'assertText') {
    if (action.target === undefined) action.target = 'specifiedElement';
    if (action.match === undefined) action.match = 'equals';
    if (!('intentLocator' in action)) action.intentLocator = undefined;
    return action;
  }

  if (kind === 'extract') {
    // phase 4: 老 extract 步骤无 mode 字段，懒迁移为 completeValue
    if (action.mode === undefined) action.mode = 'completeValue';
    if (!('intentLocator' in action)) action.intentLocator = undefined;
    return action;
  }

  // 含 locator 的所有 kind 都补 intentLocator=undefined（保持字段位置一致）
  const locatorKinds = new Set(['click', 'fill', 'hover', 'waitFor', 'check', 'select']);
  if (locatorKinds.has(String(kind))) {
    if (!('intentLocator' in action)) action.intentLocator = undefined;
    return action;
  }

  // 其余 kind（navigate / upload / switchTab / screenshot / assertJson）原样返回
  return action;
}

/**
 * 把 test_steps.assertion（任意形状）规整为 dispatch 认识的 StepAction 子集。
 * 只支持 assertText；其它 kind/null/非对象原样返回。
 * 兼容两种历史形态：
 *  1) 老 AI 保存路径写出的 `{kind:'assertText', text:'...'}`（缺 equals/target/match）→
 *     规范 `{kind:'assertText', locator:[], target:'page', match:'contains', equals:text}`。
 *  2) 已规范形态直接返回。
 */
export function migrateAssertion(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const a = raw as Record<string, unknown>;
  if (a.kind !== 'assertText') return raw;
  // 已有 equals 视为已规范（target/match/locator 缺省时 dispatch 内部用 schema 默认）。
  if (typeof a.equals === 'string') return raw;
  const text = typeof a.text === 'string' ? a.text : '';
  return {
    kind: 'assertText',
    locator: [],
    target: 'page',
    match: 'contains',
    equals: text,
  };
}

/**
 * step-level assertion 的写入清洗：**只做形状规范化，不再按措辞黑名单丢内容**。
 *
 *  历史版本这里有一张 28 词黑名单（DESCRIPTIVE_PHRASES：「展示」「回显」「触发」「应该」……），
 *  凡命中即写 null 入库。动机是对的——AI 常写出「登录表单正常展示」这类描述性短语，
 *  经 migrateAssertion 会变成 `target:'page' match:'contains'` 的整页子串断言，回放必挂；
 *  但硬编码词表和曾经的 CAPTCHA_FAIL_RE 是同一类反模式：每遇一种新写法就得加词，永远追不完，
 *  还误伤真实文案（任何含「提示」「需」字的按钮/toast 都会被丢掉）。
 *
 *  改为交给 LLM 判（pi/space/tools/assertionJudge.ts），在 verify_case 的真实页面上判一次，
 *  判定依据是页面实际存在的文案而非猜。这里只保留空值归一：非 string / 全空白 → null。
 */
export function sanitizeAssertion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text.length === 0 ? null : text;
}

/** 把 unknown 当作 StepAction 类型断言，仅供已通过 Zod 的路径使用。 */
export function asStepAction(a: unknown): StepAction {
  return a as StepAction;
}
