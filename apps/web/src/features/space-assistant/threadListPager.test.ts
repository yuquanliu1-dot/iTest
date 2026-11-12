import { describe, it, expect, vi } from 'vitest';
import { ThreadListPager, type ThreadRow, type FetchPage, type PagerSnapshot } from './threadListPager';

const row = (id: string, updatedAt: string, title = `t-${id}`): ThreadRow => ({
  id,
  title,
  status: 'idle',
  updatedAt,
});

/** A fetchPage returning pages in sequence: no cursor takes pages[0], with a cursor advances in order, out-of-range reuses the last page. */
function pageSource(...pages: { threads: ThreadRow[]; hasMore: boolean }[]): {
  fetchPage: FetchPage;
  calls: { limit: number; cursor?: string }[];
} {
  const calls: { limit: number; cursor?: string }[] = [];
  let pageIdx = 0;
  const fetchPage: FetchPage = vi.fn(async (_v, opts) => {
    calls.push(opts);
    if (opts.cursor) pageIdx = Math.min(pageIdx + 1, pages.length - 1);
    return pages[pageIdx]!;
  });
  return { fetchPage, calls };
}

describe('ThreadListPager.refreshForRuntime', () => {
  it('首拉返回第 1 页并记录 hasMore', async () => {
    const { fetchPage } = pageSource({ threads: [row('a', 'd1'), row('b', 'd2')], hasMore: true });
    const pager = new ThreadListPager('v1', { fetchPage });
    const rows = await pager.refreshForRuntime();
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(pager.getSnapshot().hasMore).toBe(true);
  });

  it('翻页后 reload:新鲜第 1 页与缓存旧页按 id 合并,新会话进顶、旧页保留', async () => {
    const p1 = [row('n1', 'd0'), row('a', 'd1'), row('b', 'd2')];
    const p2 = [row('c', 'd3'), row('d', 'd4')];
    const { fetchPage } = pageSource({ threads: p1, hasMore: true }, { threads: p2, hasMore: false });
    const pager = new ThreadListPager('v1', { fetchPage });
    await pager.refreshForRuntime();
    await pager.loadMore();
    expect(pager.getSnapshot().rows.map((r) => r.id)).toEqual(['n1', 'a', 'b', 'c', 'd']);
    // New thread n2 appeared: the fresh page 1 wins, cached a/b are kept
    const { fetchPage: fp2 } = pageSource({ threads: [row('n2', 'dx'), row('n1', 'd0'), row('a', 'd1')], hasMore: false });
    (pager as unknown as { opts: { fetchPage: FetchPage } }).opts.fetchPage = fp2;
    const merged = await pager.refreshForRuntime();
    // b is not in the fresh page 1 window → cached copy kept; merge order = fresh page first, cached old pages in original order after
    expect(merged.map((r) => r.id)).toEqual(['n2', 'n1', 'a', 'b', 'c', 'd']);
  });

  it('行同时出现在新鲜页与缓存 → 新鲜副本胜出(单份、新标题)', async () => {
    const { fetchPage } = pageSource(
      { threads: [row('a', 'd1', '旧标题'), row('b', 'd2')], hasMore: true },
      { threads: [row('c', 'd3')], hasMore: false },
    );
    const pager = new ThreadListPager('v1', { fetchPage });
    await pager.refreshForRuntime();
    await pager.loadMore();
    const { fetchPage: fp2 } = pageSource({ threads: [row('a', 'd1', '新标题'), row('b', 'd2'), row('c', 'd3')], hasMore: false });
    (pager as unknown as { opts: { fetchPage: FetchPage } }).opts.fetchPage = fp2;
    const merged = await pager.refreshForRuntime();
    expect(merged.filter((r) => r.id === 'a')).toHaveLength(1);
    expect(merged.find((r) => r.id === 'a')?.title).toBe('新标题');
  });

  it('keyset 耗尽后 reload 不复活 hasMore(防哨兵死循环)', async () => {
    // When the server's page 1 is a full page, hasMore is always true (remaining rows are already in cache); copying it verbatim on reload would
    // revive the extinguished sentinel → bottom observe fires immediately → empty paging + reload infinite loop.
    const { fetchPage } = pageSource(
      { threads: [row('a', 'd1'), row('b', 'd2')], hasMore: true },
      { threads: [row('c', 'd3')], hasMore: false },
    );
    const pager = new ThreadListPager('v1', { fetchPage });
    await pager.refreshForRuntime();
    await pager.loadMore();
    expect(pager.getSnapshot().hasMore).toBe(false);
    // reload: fresh page 1 still reports hasMore=true → suppressed to false
    const { fetchPage: fp2 } = pageSource({ threads: [row('a', 'd1'), row('b', 'd2')], hasMore: true });
    (pager as unknown as { opts: { fetchPage: FetchPage } }).opts.fetchPage = fp2;
    await pager.refreshForRuntime();
    expect(pager.getSnapshot().hasMore).toBe(false);
  });
});

describe('ThreadListPager.loadMore', () => {
  it('游标 = 缓存末行 id;追加去重;hasMore 透传', async () => {
    const { fetchPage, calls } = pageSource(
      { threads: [row('a', 'd1'), row('b', 'd2')], hasMore: true },
      { threads: [row('c', 'd3'), row('b', 'd2')], hasMore: false },
    );
    const pager = new ThreadListPager('v1', { fetchPage });
    await pager.refreshForRuntime();
    await pager.loadMore();
    expect(calls[1]).toEqual({ limit: 50, cursor: 'b' });
    expect(pager.getSnapshot().rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(pager.getSnapshot().hasMore).toBe(false);
  });

  it('并发调用复用同一 in-flight promise,只发一次请求', async () => {
    let release: ((v: { threads: ThreadRow[]; hasMore: boolean }) => void) | undefined;
    const fetchPage: FetchPage = vi.fn(
      (_v, opts): Promise<{ threads: ThreadRow[]; hasMore: boolean }> =>
        new Promise((resolve) => {
          if (!opts.cursor) resolve({ threads: [row('a', 'd1')], hasMore: true });
          else release = resolve;
        }),
    );
    const pager = new ThreadListPager('v1', { fetchPage });
    await pager.refreshForRuntime();
    const p1 = pager.loadMore();
    const p2 = pager.loadMore();
    expect(p1).toBe(p2);
    release?.({ threads: [row('c', 'd3')], hasMore: false });
    await Promise.all([p1, p2]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(pager.getSnapshot().rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(pager.getSnapshot().loadingMore).toBe(false);
  });

  it('无更多(hasMore=false)时不发请求', async () => {
    const { fetchPage } = pageSource({ threads: [row('a', 'd1')], hasMore: false });
    const pager = new ThreadListPager('v1', { fetchPage });
    await pager.refreshForRuntime();
    await pager.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('加载失败:loadingMore 复位、异常上抛,缓存行保留', async () => {
    const fail: FetchPage = async (_v, opts) => {
      if (opts.cursor) throw new Error('boom');
      return { threads: [row('a', 'd1')], hasMore: true };
    };
    const pager = new ThreadListPager('v1', { fetchPage: fail });
    await pager.refreshForRuntime();
    await expect(pager.loadMore()).rejects.toThrow('boom');
    expect(pager.getSnapshot().loadingMore).toBe(false);
    expect(pager.getSnapshot().rows.map((r) => r.id)).toEqual(['a']);
    // Retryable after failure (loadMorePromise already cleared)
    await expect(pager.loadMore()).rejects.toThrow('boom');
  });
});

describe('ThreadListPager 本地缓存维护', () => {
  it('removeLocal 删行;不存在时静默', async () => {
    const { fetchPage } = pageSource({ threads: [row('a', 'd1'), row('b', 'd2')], hasMore: false });
    const pager = new ThreadListPager('v1', { fetchPage });
    await pager.refreshForRuntime();
    pager.removeLocal('a');
    expect(pager.getSnapshot().rows.map((r) => r.id)).toEqual(['b']);
    pager.removeLocal('ghost');
    expect(pager.getSnapshot().rows.map((r) => r.id)).toEqual(['b']);
  });

  it('renameLocal 改标题;状态变化通知订阅者', async () => {
    const { fetchPage } = pageSource({ threads: [row('a', 'd1')], hasMore: false });
    const pager = new ThreadListPager('v1', { fetchPage });
    await pager.refreshForRuntime();
    const seen: PagerSnapshot[] = [];
    pager.subscribe(() => seen.push(pager.getSnapshot()));
    pager.renameLocal('a', '改名了');
    expect(pager.getSnapshot().rows[0]!.title).toBe('改名了');
    expect(seen).toHaveLength(1);
  });
});
