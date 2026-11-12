import type { Locator } from 'playwright-core';

/**
 * "Expanded dropdown's filter input" detection.
 *
 * Why: controls like Element UI's el-select(remote+filterable) clear the query text, close the panel, and restore
 * readonly on blur. The trailing blur at the end of fill would destroy the "typed keyword + candidate list" state,
 * so a remote-search dropdown can never get a candidate selected (measured on prod228 SOC's intranet asset "责任单位":
 * typing succeeded and the remote returned 22 candidates, but after Tab the value was wiped to "" and the panel closed,
 * and the subsequent candidate click timed out).
 *
 * Criteria (host + whether it is expanded):
 * - Element UI: the visible (el-select) / suggestionsVisible (el-autocomplete) of the __vue__ instance on the host root
 * - Ant Design: the host class carries `-open` (React rendering, no __vue__)
 *
 * This function executes in the page context (locator.evaluate); it cannot reference module-scope identifiers.
 */
export function isDropdownFilterInput(el: Element): boolean {
  const host = el.closest('.el-select, .el-autocomplete, .ant-select') as HTMLElement | null;
  if (!host) return false;
  const vm = (host as unknown as { __vue__?: { visible?: unknown; suggestionsVisible?: unknown } }).__vue__;
  if (vm) return vm.visible === true || vm.suggestionsVisible === true;
  return /(^|\s)\S*-open(\s|$)/.test(host.className);
}

/** Locator-form equivalent; when the element has detached / location fails, treated as "not one" (blur proceeds as usual). */
export async function isOpenDropdownFilter(loc: Locator): Promise<boolean> {
  try {
    return await loc.evaluate(isDropdownFilterInput);
  } catch {
    return false;
  }
}
