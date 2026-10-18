import type { AiLang } from '../../../agent/langDirective.js';

/** 版本仓库后台检出状态(session 建立时通常未就绪;检出完成/失败后就位)。 */
export interface RepoState {
  /** 仓库沙箱目录;后台检出完成前为 null。 */
  cwd: string | null;
  /** 非 no_repo 的检出失败原因(auth_failed 等);null = 无失败。 */
  issue: string | null;
  /** 项目未配置 Git 仓库(no_repo 静默,不进 issue)。 */
  noRepo: boolean;
}

export function emptyRepoState(): RepoState {
  return { cwd: null, issue: null, noRepo: false };
}

/** repo 沙箱工具的 cwd 动态解析:就绪返回目录;未就绪/不可用时 throw,
 *  由工具内既有 try/catch 转为错误结果(AI 可读到具体原因并告知用户)。 */
export function repoToolCwd(repo: RepoState): string {
  if (repo.cwd) return repo.cwd;
  if (repo.noRepo) throw new Error('项目未配置 Git 仓库,repo 类工具不可用');
  if (repo.issue) throw new Error(`仓库不可用(${repo.issue}),repo 类工具暂不可用`);
  throw new Error('仓库尚未就绪(后台检出中),请稍后重试');
}

/** 空间工具运行上下文:由 session.ts 按 thread 构建,经闭包注入各工具。
 *  repo 为共享可变引用,后台检出完成后 cwd 就位,工具随调随解析。 */
export interface SpaceToolsContext {
  threadId: string;
  versionId: string;
  projectId: string;
  repo: RepoState;
  /** 向当前线程 SSE 订阅者广播自定义事件(confirm_request / stage / announce 等)。 */
  emit: (e: Record<string, unknown>) => void;
  /** 线程创建人：AI 直建/暂存落库对象以此为归属；历史线程为 null。 */
  createdByUserId: string | null;
  /** 线程创建人是否为有效管理员（buildSpaceRecord 构建时解析）。false → 管理类工具不注册。 */
  manager: boolean;
  /** 界面语言：线程创建人语言，历史线程缺省 zh-CN。 */
  lang?: AiLang;
  /** 版本独立工作空间目录（.data/workspaces/v-<versionId>）；read_skill 的 .pi/skills 根。 */
  workspaceDir?: string;
}
