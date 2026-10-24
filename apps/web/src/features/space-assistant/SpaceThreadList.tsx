import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelLeftClose, PanelLeftOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/Modal';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { groupByBucket, type BucketKey } from './threadBuckets';
import { useThreadPager, type ThreadListPager } from './threadListPager';

/**
 * 助手左侧线程列表(ThreadList 原语):「新对话」按钮 + 历史线程(切换/改名/删除)。
 * 非受控:当前线程由 runtime 持有,这里只读 main item 的 remoteId 做高亮——
 * undefined 即草稿(新线程首条消息发出前),高亮落到「新对话」上。
 * 草稿不进 Items(底层 threadIds 只收 regular/archived),后端也只返回有消息的线程。
 * 可收缩:collapsed 时只剩窄条(展开按钮 + 新对话图标),宽度切换由父级容器驱动。
 * 分页:列表数据由 ThreadListPager 供给(react-pi 适配层封死内建分页),滚动近底部
 * 经哨兵自动翻页 + aui.threads.reload() 把缓存灌回 runtime store;时间表直接读
 * pager 行(react-pi 的 mapThreadMetadata 丢弃 updatedAt,store 里拿不到时间)。
 */
export default function SpaceThreadList({ pager, collapsed, onToggleCollapsed }: {
  pager: ThreadListPager;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { t } = useTranslation();
  const activeRemoteId = useAuiState((s) => s.optional.threadListItem?.remoteId);
  const isLoading = useAuiState((s) => s.threads.isLoading);
  const threadIds = useAuiState((s) => s.threads.threadIds);
  // 分页快照(store 侧不可变对象,commit 时换新):行数据即时间表,对话 settle 时
  // SuggestionWatcher 的 aui.threads.reload() → runtime list() → pager.refreshForRuntime()
  // → commit 通知,时间表随之刷新,无需这里自拉。
  const snap = useSyncExternalStore(pager.subscribe, pager.getSnapshot);
  const updatedAtById = useMemo(
    () => Object.fromEntries(snap.rows.map((r) => [r.id, r.updatedAt])),
    [snap.rows],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 p-2">
        <button
          type="button"
          className="btn-tint rounded-md p-1.5 w-full flex justify-center"
          style={{ color: 'var(--muted-foreground)' }}
          title={t('assistant:threadList.expand')}
          aria-label={t('assistant:threadList.expand')}
          onClick={onToggleCollapsed}
        >
          <PanelLeftOpen size={16} />
        </button>
        <ThreadListPrimitive.New
          className={`btn-tint rounded-md p-1.5 w-full flex justify-center ${
            activeRemoteId === undefined ? 'btn-sel-muted' : ''
          }`}
          title={t('assistant:newChat')}
          aria-label={t('assistant:newChat')}
        >
          <Plus size={16} />
        </ThreadListPrimitive.New>
      </div>
    );
  }
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2 shrink-0 flex items-center gap-1" style={{ borderBottom: '1px solid var(--border)' }}>
        <ThreadListPrimitive.New
          className={`btn-tint flex-1 min-w-0 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-left truncate ${
            activeRemoteId === undefined ? 'btn-sel-muted' : ''
          }`}
        >
          {t('assistant:newChat')}
        </ThreadListPrimitive.New>
        <button
          type="button"
          className="btn-tint rounded-md p-1.5 shrink-0"
          style={{ color: 'var(--muted-foreground)' }}
          title={t('assistant:threadList.collapse')}
          aria-label={t('assistant:threadList.collapse')}
          onClick={onToggleCollapsed}
        >
          <PanelLeftClose size={15} />
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5">
        {!isLoading && threadIds.length === 0 && (
          <div className="text-[12px] px-2 py-1" style={{ color: 'var(--muted-foreground)' }}>
            {t('assistant:threadList.noHistory')}
          </div>
        )}
        <GroupedItems updatedAtById={updatedAtById} pager={pager} scrollRef={scrollRef} />
      </div>
    </div>
  );
}

/** 单条线程:整行 Trigger 切换;悬停出改名/删除。改名走 item.rename(PATCH),
 *  删除走 item.delete(DELETE)——删的是当前线程时核心会自动切到新草稿。 */
/** render 回调给的 item 是 store 的 ThreadListItemState;这里只声明用到的字段,
 *  避开 @assistant-ui/react 同时导出的同名 runtime 类型(isMain 等运行时态字段)。 */
interface RailItemData {
  id: string;
  remoteId: string | undefined;
  title?: string;
  isRunning: boolean;
}

function RailItem({ item, active }: { item: RailItemData; active: boolean }) {
  const { t } = useTranslation();
  const aui = useAui();
  const pager = useThreadPager();
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={item.title ?? ''}
        className="w-full rounded-md px-2.5 py-1.5 text-[13px] outline-none"
        style={{ border: '1px solid var(--primary)', background: 'var(--popover)', color: 'var(--foreground)' }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const v = e.currentTarget.value.trim();
            if (v) {
              aui.threadListItem.rename(v);
              // 分页缓存同步改名:深页行不必等下一次新鲜第 1 页才见到新标题
              if (item.remoteId) pager.renameLocal(item.remoteId, v);
            }
            setEditing(false);
          } else if (e.key === 'Escape') {
            setEditing(false);
          }
        }}
        onBlur={() => setEditing(false)}
      />
    );
  }
  return (
    <div
      className={`group relative flex items-center rounded-md ${active ? 'btn-sel-muted' : ''}`}
    >
      <ThreadListItemPrimitive.Trigger
        className="btn-tint flex-1 min-w-0 text-left rounded-md px-2.5 py-1.5 pr-14 text-[13px] flex items-center gap-1.5"
        style={{ color: 'var(--foreground)' }}
      >
        {item.isRunning && (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: 'var(--primary)' }}
            aria-label={t('assistant:runningIndicator')}
          />
        )}
        <span className="truncate">{item.title || t('assistant:threadList.untitled')}</span>
      </ThreadListItemPrimitive.Trigger>
      {/* 悬停操作:盖在行尾,背景与行底色对齐避免穿帮 */}
      <div
        className="absolute right-1 hidden group-hover:flex items-center gap-0.5 rounded px-1"
        style={{ background: active ? 'var(--muted)' : 'var(--popover)' }}
      >
        <button
          type="button"
          className="btn-tint rounded p-1"
          style={{ color: 'var(--muted-foreground)' }}
          title={t('assistant:threadList.rename')}
          onClick={() => setEditing(true)}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className="btn-tint rounded p-1"
          style={{ color: 'var(--muted-foreground)' }}
          title={t('assistant:threadList.delete')}
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {/* 删除确认:与用例/数据集等删除同款 Dialog(shadcn),替代原生 window.confirm。
          挂在 RailItem 内是为让确认按钮的 aui.threadListItem.delete() 仍命中本行 item 作用域。 */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('assistant:threadList.delete')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('assistant:threadList.confirmDelete', { title: item.title || t('assistant:threadList.untitled') })}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>{t('common:cancel')}</Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                // 分页缓存同步清行(与 store 的乐观删除同拍):不清则下次 reload 从缓存复活。
                // 删除失败属网络边角,行仍在库,下次新鲜第 1 页自愈。
                if (item.remoteId) pager.removeLocal(item.remoteId);
                aui.threadListItem.delete();
              }}
            >
              {t('assistant:threadList.confirmDeleteAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 段标题的 i18n key：groupToday / groupYesterday / groupWeek / groupMonth / groupOlder */
function bucketLabelKey(k: BucketKey): string {
  return `assistant:threadList.group${k[0]!.toUpperCase()}${k.slice(1)}`;
}

/** ItemByIndex 作用域内的条目。必须是独立组件——components.ThreadListItem 里
 *  不能内联调 useAuiState（违反 Hooks 规则，且组件身份不稳定会反复重挂载）。
 *  active 在组件内部订阅:store 侧对 store 侧比较,且引用稳定才能过 ItemByIndex 的 memo。 */
function IndexedRailItem() {
  const item = useAuiState((s) => s.optional.threadListItem);
  // store 侧对 store 侧:mainThreadId 与 threadListItem.id 同域,不受本地 __LOCALID_ 与后端 uuid 混用影响
  const active = useAuiState((s) => s.threads.mainThreadId === s.optional.threadListItem?.id);
  if (!item) return null;
  return <RailItem item={item as unknown as RailItemData} active={active} />;
}

/** 按五段分组渲染。Items 原语内部是 threadIds.map 死平铺、插不进段标题,
 *  故用 ItemByIndex 按 index 自行排版,保留 item scope 的 switchTo/rename/delete。
 *  末尾挂无限滚动哨兵:hasMore 时滚动近底部自动翻页。 */
function GroupedItems({ updatedAtById, pager, scrollRef }: {
  updatedAtById: Record<string, string | undefined>;
  pager: ThreadListPager;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  // 本地新建的会话在 store 里永久保留 __LOCALID_ 前缀的 store id(reconcile 后 survivor=本地槽位),
  // 时间表按后端 uuid 键入 → 须经 threadItems 把 store id 解析成 remoteId 再查。
  const remoteIdById = useMemo(
    () => new Map(threadItems.map((i) => [i.id, i.remoteId])),
    [threadItems],
  );
  const rows = useMemo(
    () => groupByBucket(threadIds.map((id) => ({ id, updatedAt: updatedAtById[remoteIdById.get(id) ?? id] }))),
    [threadIds, updatedAtById, remoteIdById],
  );
  // ItemByIndex 的 index 必须是 threadIds 里的原始下标,不能用分组后的序号
  const indexById = useMemo(() => new Map(threadIds.map((id, i) => [id, i])), [threadIds]);
  return (
    <>
      {rows.map((group) => (
        <div key={group.key} className="mb-1">
          <div className="px-2 py-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {t(bucketLabelKey(group.key))}
          </div>
          {group.items.map((row) => (
            <ThreadListPrimitive.ItemByIndex
              key={row.id}
              index={indexById.get(row.id)!}
              components={{ ThreadListItem: IndexedRailItem }}
            />
          ))}
        </div>
      ))}
      <LoadMoreSentinel pager={pager} scrollRef={scrollRef} />
    </>
  );
}

/** 无限滚动哨兵:IntersectionObserver 盯滚动容器底部(rootMargin 提前 200px 预取),
 *  命中即 pager.loadMore() 翻页 + aui.threads.reload() 把缓存灌回 runtime store
 *  (分页器只是数据源,store 才是渲染真相)。busyRef 防重入(翻页+reload 在途时
 *  布局变化会再次触发 observer)。hasMore=false 时不渲染,停止观察。 */
function LoadMoreSentinel({ pager, scrollRef }: {
  pager: ThreadListPager;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const aui = useAui();
  const snap = useSyncExternalStore(pager.subscribe, pager.getSnapshot);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !snap.hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || busyRef.current) return;
        busyRef.current = true;
        void pager
          .loadMore()
          .then(() => aui.threads.reload())
          .finally(() => { busyRef.current = false; });
      },
      { root: scrollRef.current, rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [pager, aui, snap.hasMore, scrollRef]);
  if (!snap.hasMore) return null;
  return (
    <div ref={sentinelRef} className="px-2 py-1.5 text-[12px] text-center" style={{ color: 'var(--muted-foreground)' }}>
      {snap.loadingMore ? t('assistant:threadList.loadingMore') : ''}
    </div>
  );
}
