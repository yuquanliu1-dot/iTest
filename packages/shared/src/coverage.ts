/**
 * Case coverage types (dialog multi-select → prompt coverage requirements → stage_case.coverageTypes).
 *
 * The definition lives in shared rather than one copy per side: web renders the checkboxes and api
 * validates stage_case inputs — two independent copies would inevitably drift (a new type web can
 * check but api rejects, or vice versa).
 *
 * key is stored in ai_stage_cases.coverage_types (jsonb); label is display-only,
 * so changing a label never affects historical data; only adding/removing keys requires a migration.
 */
export const COVERAGE_TYPES = [
  { key: 'functional', label: '功能（正常流）' },
  { key: 'exception', label: '异常场景' },
  { key: 'boundary', label: '边界值' },
  { key: 'security', label: '安全（SQL 注入·XSS·越权·未授权等）' },
  { key: 'uiux', label: 'UI/UX（呈现·交互）' },
] as const;

export type CoverageType = (typeof COVERAGE_TYPES)[number]['key'];

export const COVERAGE_TYPE_KEYS: readonly CoverageType[] = COVERAGE_TYPES.map((t) => t.key);

/** key → display label. Receipts/summaries echo the human-readable label instead of the English key. */
export const COVERAGE_LABELS: ReadonlyMap<string, string> = new Map(
  COVERAGE_TYPES.map((t) => [t.key, t.label]),
);

/** Coverage requirements assembled into a prompt text block (returns an empty string when no type is checked in the dialog). */
export function coveragePrompt(keys: readonly string[]): string {
  const labels = COVERAGE_TYPES.filter((t) => keys.includes(t.key)).map((t) => t.label);
  if (labels.length === 0) return '';
  return `\n\n【覆盖要求】本次生成必须覆盖以下测试类型：${labels.join('、')}；每类至少 1 条用例，未列出的类型自行判断。`;
}
