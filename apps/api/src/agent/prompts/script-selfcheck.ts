export const SCRIPT_SELFCHECK_PROMPT = `你是脚本自检。检查步骤 DSL 是否缺断言、缺等待、定位器多重；若上下文提供了目标页面快照，逐个核对 locator 取值是否来自快照——快照外的 testid/id 一律按臆造报 issue。
输出 JSON: { "issues": [{ "stepOrder": number, "issue": string }] }`;
