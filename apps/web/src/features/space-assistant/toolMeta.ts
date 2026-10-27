import type { IconName } from '../../components/Icon';

/** 空间工具 → chip 文案与图标;未知工具返回 null 不渲染。label 为 i18n key,由调用方组件 t() 渲染。
 *  对话流(SpaceThreadPane)与完整历史抽屉(ThreadHistorySheet)共用。 */
export function toolMeta(toolName: string, args: unknown): { icon: IconName; label: string; summary: string } | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const action = typeof a.action === 'string' ? a.action : '';
  if (toolName === 'inspect_page') return { icon: 'search', label: 'assistant:tool.inspectPage', summary: typeof a.url === 'string' ? a.url : '' };
  if (toolName === 'announce_plan') return { icon: 'flag', label: 'assistant:tool.announcePlan', summary: typeof a.summary === 'string' ? a.summary : '' };
  if (toolName === 'manage_cases') return { icon: 'beaker', label: 'assistant:tool.manageCases', summary: action };
  if (toolName === 'manage_scenarios') return { icon: 'layers', label: 'assistant:tool.manageScenarios', summary: action };
  if (toolName === 'manage_environments') return { icon: 'globe', label: 'assistant:tool.manageEnvironments', summary: action };
  if (toolName === 'manage_plans') return { icon: 'listChecks', label: 'assistant:tool.managePlans', summary: action };
  if (toolName === 'verify_case') return { icon: 'beaker', label: 'assistant:tool.verifyCase', summary: typeof a.caseId === 'string' ? a.caseId.slice(0, 8) : '' };
  if (toolName === 'solidify_case') return { icon: 'sparkles', label: 'assistant:tool.solidifyCase', summary: typeof a.caseId === 'string' ? a.caseId.slice(0, 8) : '' };
  if (toolName.startsWith('repo_')) {
    return { icon: 'code', label: 'assistant:tool.readRepo', summary: typeof a.path === 'string' ? a.path : (typeof a.command === 'string' ? a.command : '') };
  }
  return null;
}
