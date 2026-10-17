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

/** zod 报错路径 → i18n token（渲染层经 `t('cases:' + token)` 翻译；未知路径回落 zod 原文）。 */
function messageFor(path: string, raw: string): string {
  if (path === 'delayMs') return 'stepDelayRange';
  if (path === 'action' || path === 'action.kind') return 'stepActionInvalid';
  if (path === 'action.locator') return 'stepLocatorEmpty';
  if (/^action\.locator\.\d+\.value$/.test(path)) return 'stepLocatorValueEmpty';
  if (/^action\.locator\.\d+\.strategy$/.test(path)) return 'stepLocatorStrategyInvalid';
  if (path === 'action.url') return 'stepUrlInvalid';
  if (path === 'action.fileId') return 'stepFileRequired';
  if (path === 'action.varName') return 'stepVarNameEmpty';
  if (path === 'action.pattern') return 'stepPatternEmpty';
  if (path === 'action.tabRef') return 'stepTabRefEmpty';
  if (path === 'action.instruction') return 'stepInstructionEmpty';
  if (path === 'action.value') return 'stepValueInvalid';
  if (path === 'action.value.fragments') return 'stepCompositeInvalid';
  if (path === 'action.timeoutMs') return 'stepTimeoutPositive';
  if (path.startsWith('action.headers.')) return 'stepHeadersInvalid';
  if (path === 'action.saveAs.varName') return 'stepSaveVarNameEmpty';
  if (path === 'action.saveAs.path') return 'stepSavePathInvalid';
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
