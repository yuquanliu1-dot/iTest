import { createContext, useContext } from 'react';
import { api } from '../../api/client';

/** Backend /threads row (pagination contract). title/time keys may be missing (JSON undefined); consumers must treat them as optional. */
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
 * History thread list pager: react-pi's list adapter disables built-in pagination (list drops {after} and returns no
 * nextCursor), so this builds its own channel — the runtime's list() always fetches a fresh page 1 and merges it with
 * cached old pages by id before returning the whole set; infinite scrolling only pages forward into the cache, then
 * aui.threads.reload() hydrates the cache back into the runtime store. Why page 1 must be fresh: core's classifyThreads
 * only outputs threads returned by list(); a pure cache would drop just-created threads from the list on settle reload.
 * The instance shares SpaceWorkspace's mount lifecycle (the component remounts by key=versionId, the instance follows the version).
 */
export class ThreadListPager {
  private state: PagerSnapshot = { rows: [], hasMore: false, loadingMore: false };
  private listeners = new Set<() => void>();
  private loadMorePromise: Promise<void> | null = null;
  /** Whether the keyset is exhausted: set once loadMore gets hasMore=false; afterwards reload must not revive
   *  hasMore (see refreshForRuntime). The sort anchor is createdAt (immutable), row positions never move; new threads
   *  only appear at the top of page 1 and never sink below the cursor, so no invalidation is needed after setting. */
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

  // useSyncExternalStore requires stable subscribe/getSnapshot references; arrow property binding
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

  /** runtime list() entry: fresh page 1 + cached old pages merged by id (fresh copy wins).
   *  Position-drift self-heal: an old-page row floating into the page 1 window → its cached copy is deduped away;
   *  not in the window → the cached copy is kept.
   *  hasMore is suppressed via reachedEnd: when page 1 is a full page p1.hasMore is always true (there really are more
   *  rows beyond page 1 — they're in the cache), copying verbatim would revive the extinguished sentinel; when the user sits at the list bottom the sentinel,
   *  once mounted, fires observe immediately, triggering a doomed empty paging+reload infinite loop. */
  async refreshForRuntime(): Promise<ThreadRow[]> {
    const p1 = await this.fetchPage(this.versionId, { limit: this.pageSize });
    const freshIds = new Set(p1.threads.map((r) => r.id));
    const rows = [...p1.threads, ...this.state.rows.filter((r) => !freshIds.has(r.id))];
    this.commit({ rows, hasMore: p1.hasMore && !this.reachedEnd });
    return rows;
  }

  /** Infinite-scroll paging: cursor takes the cached last row's id, append with dedup. Concurrent calls reuse the same in-flight promise. */
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

  /** Clear the cache row after deletion: the store-side delete is optimistic; without clearing, the row revives from cache on next reload. */
  removeLocal(id: string): void {
    if (!this.state.rows.some((r) => r.id === id)) return;
    this.commit({ rows: this.state.rows.filter((r) => r.id !== id) });
  }

  /** Sync renames into the cache, so deep-page rows don't wait for the next fresh page 1 to see the new title. */
  renameLocal(id: string, title: string): void {
    if (!this.state.rows.some((r) => r.id === id)) return;
    this.commit({ rows: this.state.rows.map((r) => (r.id === id ? { ...r, title } : r)) });
  }
}

/** Components rendered through ItemByIndex component slots like RailItem get no props; fetch the pager via Context. */
export const ThreadPagerContext = createContext<ThreadListPager | null>(null);

export function useThreadPager(): ThreadListPager {
  const pager = useContext(ThreadPagerContext);
  if (!pager) throw new Error('ThreadPagerContext missing: SpaceWorkspace must provide the pager');
  return pager;
}
