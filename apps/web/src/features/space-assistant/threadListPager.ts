import { createContext, useContext } from 'react';
import { api } from '../../api/client';

/** 后端 /threads 行(分页契约)。title/时间可能缺键(JSON undefined),消费方按可缺省处理。 */
export interface ThreadRow {
  id: string;
  title?: string | null;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PagerSnapshot {
  rows: ThreadRow[];
  hasMore: boolean;
  loadingMore: boolean;
}

export type FetchPage = (
  versionId: string,
  opts: { limit: number; cursor?: string },
) => Promise<{ threads: ThreadRow[]; hasMore: boolean }>;

export const THREAD_PAGE_SIZE = 50;

/**
 * 历史会话列表分页器:react-pi 的 list 适配层封死了内建分页(list 丢弃 {after} 且不回
 * nextCursor),这里自建通道——runtime 的 list() 每次都新鲜拉第 1 页并与本地缓存旧页按
 * id 合并后整体返回,无限滚动只往后翻页、进缓存,再经 aui.threads.reload() 把缓存灌回
 * runtime store。必须新鲜拉第 1 页的原因:core 的 classifyThreads 只输出 list() 返回的
 * 线程,纯缓存会让 settle 重载时刚创建的会话从列表里丢失。
 * 实例与 SpaceWorkspace 挂载同生命周期(组件按 key=versionId 重挂载,实例随版本走)。
 */
export class ThreadListPager {
  private state: PagerSnapshot = { rows: [], hasMore: false, loadingMore: false };
  private listeners = new Set<() => void>();
  private loadMorePromise: Promise<void> | null = null;
  /** keyset 是否已耗尽:loadMore 拿到 hasMore=false 即置位,此后 reload 不得把 hasMore
   *  复活(见 refreshForRuntime)。行只会因收到新消息 updatedAt 增大而上浮,不会沉到
   *  游标之下,故置位后无需失效。 */
  private reachedEnd = false;

  constructor(
    private readonly versionId: string,
    private readonly opts: { pageSize?: number; fetchPage?: FetchPage } = {},
  ) {}

  private get pageSize(): number {
    return this.opts.pageSize ?? THREAD_PAGE_SIZE;
  }

  private get fetchPage(): FetchPage {
    return this.opts.fetchPage ?? ((v, o) => api.assistant.listThreadsPaged(v, o));
  }

  // useSyncExternalStore 要求 subscribe/getSnapshot 引用稳定,箭头属性绑定
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): PagerSnapshot => this.state;

  private commit(partial: Partial<PagerSnapshot>): void {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l();
  }

  /** runtime list() 入口:新鲜第 1 页 + 缓存旧页按 id 合并(新鲜副本胜出)。
   *  位置漂移自愈:旧页行上浮进第 1 页窗口 → 去重掉缓存副本;没进窗口 → 缓存副本保留。
   *  hasMore 用 reachedEnd 压制:第 1 页满页时 p1.hasMore 恒为 true(第 1 页外确实还有
   *  行——就在缓存里),照抄会把已熄灭的哨兵复活;用户停在列表底部时哨兵一挂载 observe
   *  立即命中,触发注定为空的翻页+reload 死循环。 */
  async refreshForRuntime(): Promise<ThreadRow[]> {
    const p1 = await this.fetchPage(this.versionId, { limit: this.pageSize });
    const freshIds = new Set(p1.threads.map((r) => r.id));
    const rows = [...p1.threads, ...this.state.rows.filter((r) => !freshIds.has(r.id))];
    this.commit({ rows, hasMore: p1.hasMore && !this.reachedEnd });
    return rows;
  }

  /** 无限滚动翻页:游标取缓存末行 id,追加去重。并发调用复用同一 in-flight promise。 */
  loadMore(): Promise<void> {
    if (this.loadMorePromise) return this.loadMorePromise;
    if (!this.state.hasMore || this.state.loadingMore) return Promise.resolve();
    const cursorId = this.state.rows[this.state.rows.length - 1]?.id;
    if (!cursorId) return Promise.resolve();
    this.commit({ loadingMore: true });
    this.loadMorePromise = (async () => {
      try {
        const next = await this.fetchPage(this.versionId, { limit: this.pageSize, cursor: cursorId });
        const known = new Set(this.state.rows.map((r) => r.id));
        if (!next.hasMore) this.reachedEnd = true;
        this.commit({
          rows: [...this.state.rows, ...next.threads.filter((r) => !known.has(r.id))],
          hasMore: next.hasMore,
        });
      } finally {
        this.loadMorePromise = null;
        this.commit({ loadingMore: false });
      }
    })();
    return this.loadMorePromise;
  }

  /** 删除后清缓存行:store 侧 delete 是乐观删除,不清的话下次 reload 会从缓存复活。 */
  removeLocal(id: string): void {
    if (!this.state.rows.some((r) => r.id === id)) return;
    this.commit({ rows: this.state.rows.filter((r) => r.id !== id) });
  }

  /** 改名同步缓存,深页行不必等下一次新鲜第 1 页才见到新标题。 */
  renameLocal(id: string, title: string): void {
    if (!this.state.rows.some((r) => r.id === id)) return;
    this.commit({ rows: this.state.rows.map((r) => (r.id === id ? { ...r, title } : r)) });
  }
}

/** RailItem 等经 ItemByIndex components 槽位渲染的组件拿不到 props,经 Context 取 pager。 */
export const ThreadPagerContext = createContext<ThreadListPager | null>(null);

export function useThreadPager(): ThreadListPager {
  const pager = useContext(ThreadPagerContext);
  if (!pager) throw new Error('ThreadPagerContext missing: SpaceWorkspace must provide the pager');
  return pager;
}
