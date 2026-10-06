// apps/web/src/lib/stepValidation.ts
import { StepAction } from '@itest/shared';

export interface StepEditInput {
  action: unknown;
  delayMs?: number;
}

export interface StepValidationResult {
  ok: boolean;
  /** key 为字段路径，如 'delayMs' | 'action.url' | 'action.locator.0.value' */
  errors: Record<string, string>;
}

/** zod 报错路径 → 中文文案。 */
function messageFor(path: string, raw: string): string {
  if (path === 'delayMs') return '延迟必须是不超过 60000 的非负整数';
  if (path === 'action' || path === 'action.kind') return '操作内容不合法';
  if (path === 'action.locator') return '至少需要一个定位候选';
  const locMatch = /^action\.locator\.(\d+)\.value$/.exec(path);
  if (locMatch) return `定位候选 ${Number(locMatch[1]) + 1} 的值不能为空`;
  if (/^action\.locator\.\d+\.strategy$/.test(path)) return `定位候选的 strategy 不合法`;
  if (path === 'action.url') return 'URL 不合法（需完整 http(s) 地址）';
  if (path === 'action.fileId') return '请绑定上传文件';
  if (path === 'action.varName') return '变量名不能为空';
  if (path === 'action.pattern') return '正则表达式不能为空';
  if (path === 'action.tabRef') return '标签引用不能为空';
  if (path === 'action.instruction') return '指令不能为空';
  if (path === 'action.value') return '填写值不合法';
  if (path === 'action.value.fragments') return '组合值不合法（至少 1 段，总长 ≤ 1024）';
  if (path === 'action.timeoutMs') return '超时必须是正整数（毫秒）';
  return `${path || 'action'}: ${raw}`.slice(0, 120);
}

export function validateStepEdit(input: StepEditInput): StepValidationResult {
  const errors: Record<string, string> = {};

  if (input.delayMs != null) {
    const d = input.delayMs;
    if (!Number.isInteger(d) || d < 0 || d > 60000) errors.delayMs = messageFor('delayMs', '');
  }

  const parsed = StepAction.safeParse(input.action);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.length ? 'action.' + issue.path.join('.') : 'action';
      if (errors[path] == null) errors[path] = messageFor(path, issue.message);
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}
