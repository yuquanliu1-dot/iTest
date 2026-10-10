/** 候选探测轮询窗口契约（回放 tryFirstMatch 与 verify_case checkCompiledLocators 共用）：
 *  首轮立即探测全部候选，全部落空后每 250ms 轮转再探，最多 12 轮（≈3s）。
 *  覆盖两类滞后：count() 走的 a11y 树 rebuild 滞后（~100-200ms）；SPA 深链路由挂载滞后
 *  （networkidle 后仍可持续秒级，实测 8a178d83 回测 step-1 探测放弃约 2s 后页面才挂载完成）。
 *  放独立模块而非从 cdp.ts 导出：测试普遍 mock cdp.js，常量随 mock 消失会让引用方悬空。
 *  用轮数上限而非墙钟 deadline：窗口语义固定（12×250ms≈3s），且测试 mock 的 waitForTimeout
 *  不推进墙钟，墙钟 deadline 会死循环。 */
export const LOCATOR_PROBE_ROUNDS = 12;
export const LOCATOR_PROBE_INTERVAL_MS = 250;
