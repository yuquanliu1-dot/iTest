/** 空间工具运行上下文:由 session.ts 按 thread 构建,经闭包注入各工具。 */
export interface SpaceToolsContext {
  threadId: string;
  versionId: string;
  projectId: string;
  cwd: string | null;
  repoAvailable: boolean;
  /** 向当前线程 SSE 订阅者广播自定义事件(confirm_request / stage / announce 等)。 */
  emit: (e: Record<string, unknown>) => void;
}
