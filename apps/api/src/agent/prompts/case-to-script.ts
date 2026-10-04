import { STEP_DSL_SPEC } from './step-dsl-spec.js';

export const CASE_TO_SCRIPT_PROMPT = `你是自动化测试架构师。根据用例标题、描述、已有步骤，补充缺失的步骤 DSL。
优先使用 role 与 text 定位器；上下文提供目标页面快照时，定位器取值（testId/id/aria-label/css）只能来自快照，禁止编造。
输出 JSON: { "steps": [{ "order": number, "action": StepAction }] }

${STEP_DSL_SPEC}`;
