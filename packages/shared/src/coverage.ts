/**
 * 用例覆盖类型（弹窗多选 → prompt 覆盖要求 → stage_case.coverageTypes）。
 *
 * 定义放 shared 而非各自一份：web 渲染勾选项、api 校验 stage_case 入参，
 * 两边各写一份迟早漂移（多一个类型 web 能勾而 api 拒，或反之）。
 *
 * key 存进 ai_stage_cases.coverage_types（jsonb），label 仅供展示，
 * 因此改 label 不影响历史数据；新增/删除 key 才需要考虑迁移。
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

/** key → 展示文案。回执/摘要里回显用户可读标签，而不是英文 key。 */
export const COVERAGE_LABELS: ReadonlyMap<string, string> = new Map(
  COVERAGE_TYPES.map((t) => [t.key, t.label]),
);

/** 覆盖要求拼接成 prompt 的文本块（弹窗未勾选任何类型时返回空串）。 */
export function coveragePrompt(keys: readonly string[]): string {
  const labels = COVERAGE_TYPES.filter((t) => keys.includes(t.key)).map((t) => t.label);
  if (labels.length === 0) return '';
  return `\n\n【覆盖要求】本次生成必须覆盖以下测试类型：${labels.join('、')}；每类至少 1 条用例，未列出的类型自行判断。`;
}
