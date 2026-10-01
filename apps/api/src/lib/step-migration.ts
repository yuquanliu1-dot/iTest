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

  // 其余 kind（navigate / upload / switchTab / screenshot / aiStep / assertJson）原样返回
  return action;
}

/** 整批迁移（steps PUT 入口处用）。 */
export function migrateSteps(steps: Array<{ action: unknown }>): void {
  for (const s of steps) {
    s.action = migrateAction(s.action);
  }
}

/** 把 unknown 当作 StepAction 类型断言，仅供已通过 Zod 的路径使用。 */
export function asStepAction(a: unknown): StepAction {
  return a as StepAction;
}
