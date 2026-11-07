import type { Locator } from 'playwright-core';

/**
 * 「已展开下拉的过滤输入框」判定。
 *
 * Why: Element UI 的 el-select(remote+filterable)这类控件，输入框在 blur 时会清空查询词、
 * 关闭面板、恢复 readonly。fill 收尾那一下失焦会直接摧毁"已输入关键字 + 候选列表"这个状态，
 * 于是远程搜索下拉永远选不中项（实测 prod228 SOC 内网资产「责任单位」：打字成功、远程返回 22 条
 * 候选，Tab 之后 value 被抹成 ""、面板关闭，后续点选项超时）。
 *
 * 判据（宿主 + 是否已展开）：
 * - Element UI：宿主根节点上的 __vue__ 实例的 visible（el-select）/ suggestionsVisible（el-autocomplete）
 * - Ant Design：宿主 class 带 `-open`（React 渲染，无 __vue__）
 *
 * 该函数会在页面上下文里执行（locator.evaluate），不能引用模块作用域标识符。
 */
export function isDropdownFilterInput(el: Element): boolean {
  const host = el.closest('.el-select, .el-autocomplete, .ant-select') as HTMLElement | null;
  if (!host) return false;
  const vm = (host as unknown as { __vue__?: { visible?: unknown; suggestionsVisible?: unknown } }).__vue__;
  if (vm) return vm.visible === true || vm.suggestionsVisible === true;
  return /(^|\s)\S*-open(\s|$)/.test(host.className);
}

/** Locator 形态的同义判定；元素已脱离 DOM / 定位失败时按"不是"处理（照常 blur）。 */
export async function isOpenDropdownFilter(loc: Locator): Promise<boolean> {
  try {
    return await loc.evaluate(isDropdownFilterInput);
  } catch {
    return false;
  }
}
