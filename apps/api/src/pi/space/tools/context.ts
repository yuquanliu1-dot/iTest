import type { AiLang } from '../../../agent/langDirective.js';

/** Version repo background checkout state (usually not ready when the session is built; settles after the checkout completes/fails). */
export interface RepoState {
  /** Repo sandbox directory; null until the background checkout completes. */
  cwd: string | null;
  /** Checkout failure reason other than no_repo (auth_failed etc.); null = no failure. */
  issue: string | null;
  /** The project has no Git repo configured (no_repo stays silent, not fed into issue). */
  noRepo: boolean;
}

export function emptyRepoState(): RepoState {
  return { cwd: null, issue: null, noRepo: false };
}

/** Dynamic cwd resolution for repo sandbox tools: returns the directory when ready; throws when not ready/unavailable,
 *  and the tool's existing try/catch turns it into an error result (the AI can read the concrete reason and tell the user). */
export function repoToolCwd(repo: RepoState): string {
  if (repo.cwd) return repo.cwd;
  if (repo.noRepo) throw new Error('项目未配置 Git 仓库,repo 类工具不可用');
  if (repo.issue) throw new Error(`仓库不可用(${repo.issue}),repo 类工具暂不可用`);
  throw new Error('仓库尚未就绪(后台检出中),请稍后重试');
}

/** Space tool run context: built per thread by session.ts and injected into each tool via closure.
 *  repo is a shared mutable reference; once the background checkout completes cwd is in place and tools resolve it per call. */
export interface SpaceToolsContext {
  threadId: string;
  versionId: string;
  projectId: string;
  repo: RepoState;
  /** Broadcast a custom event to the current thread's SSE subscribers (confirm_request / stage / announce etc.). */
  emit: (e: Record<string, unknown>) => void;
  /** Thread creator: AI-direct-created/staged persistence objects take this as their owner; null on historical threads. */
  createdByUserId: string | null;
  /** Whether the thread creator is a valid manager (resolved at buildSpaceRecord time). false → management tools not registered. */
  manager: boolean;
  /** UI language: the thread creator's language; historical threads default to zh-CN. */
  lang?: AiLang;
  /** Version's dedicated workspace directory (.data/workspaces/v-<versionId>); the .pi/skills root for read_skill. */
  workspaceDir?: string;
  /** Thread purpose: save_rca_result is registered only for 'rca'; default equals 'chat' (historical threads/test stubs omit this field). */
  purpose?: string;
  /** Whether to register the playground live view. Default/true = on (current session-link behavior); explicit false = off for batch background links (saves the 0.5fps screenshot-polling overhead). */
  liveView?: boolean;
}
