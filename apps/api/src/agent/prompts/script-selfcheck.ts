export const SCRIPT_SELFCHECK_PROMPT = `你是脚本自检。检查步骤 DSL 是否缺断言、缺等待、定位器多重。
输出 JSON: { "issues": [{ "stepOrder": number, "issue": string }] }`;
