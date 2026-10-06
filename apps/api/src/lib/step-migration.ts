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
 * AI 写出来的 step-level assertion 文本里常含"描述性短语"（"登录表单正常展示"、"账号已触发锁定"、
 * "登录请求已发出"）——它们通过 `migrateAssertion` 后会被当成 `target:'page' match:'contains'` 子串
 * 校验，回放时拿 `document.body.innerText` 一定命中不到，整步 fail。
 *
 * 这层做内容级过滤：识别"描述性短语"返回 `null`，调用方写 `null` 入库，回放阶段自然跳过断言。
 * 真实 UI 文案（按钮/toast/页面标题）短且具体，命中不到描述性动词表，得以保留。
 *
 * 判定：
 *  - 空字符串 / 非 string → null
 *  - 长度 > 4 且命中描述性动词白名单任一项 → null
 *  - 其它原样返回（让调用方继续 migrateAssertion）
 */
const DESCRIPTIVE_PHRASES = [
  '展示', '回显', '触发', '已发出', '发出', '应该', '预期', '需要',
  '已实现', '可能', '大概', '或许', '应当', '可见', '已被', '已接收',
  '提示', '需', '已成功', '成功提交', '提交了', '已完成', '完成回显',
  '正常回显', '正常展示', '正常显示', '填写成功', '展示成功',
];

export function sanitizeAssertion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length <= 4) {
    // 短断言（按钮/toast 真实文案）放行；空/纯空白也走 null。
    return text.length === 0 ? null : text;
  }
  for (const p of DESCRIPTIVE_PHRASES) {
    if (text.includes(p)) return null;
  }
  return text;
}

/** 把 unknown 当作 StepAction 类型断言，仅供已通过 Zod 的路径使用。 */
export function asStepAction(a: unknown): StepAction {
  return a as StepAction;
}
