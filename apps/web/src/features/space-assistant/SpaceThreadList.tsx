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
 * Assistant left-side thread list (ThreadList primitives): "New chat" button + history threads (switch/rename/delete).
 * Uncontrolled: the current thread is held by the runtime; here we only read the main item's remoteId for highlighting —
 * undefined means draft (before the new thread's first message is sent), highlight falls on "New chat".
 * Drafts don't enter Items (underlying threadIds only takes regular/archived), and the backend only returns threads with messages.
 * Collapsible: when collapsed only a narrow strip remains (expand button + new-chat icon); width switching is driven by the parent container.
 * Pagination: list data is supplied by ThreadListPager (react-pi adapter layer disables built-in pagination); scrolling near the bottom
 * auto-pages via the sentinel + aui.threads.reload() hydrates the cache back into the runtime store; timestamps read
 * pager rows directly (react-pi's mapThreadMetadata drops time fields, unavailable from the store).
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
  // Pagination snapshot (immutable store-side object, replaced on commit): rows are the timestamps; on thread settle
  // SuggestionWatcher's aui.threads.reload() → runtime list() → pager.refreshForRuntime()
  // → commit notification refreshes the timestamps; no need to fetch here.
  const snap = useSyncExternalStore(pager.subscribe, pager.getSnapshot);
  const createdAtById = useMemo(
    () => Object.fromEntries(snap.rows.map((r) => [r.id, r.createdAt])),
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
        <GroupedItems createdAtById={createdAtById} pager={pager} scrollRef={scrollRef} />
      </div>
    </div>
  );
}

/** Single thread: the whole row's Trigger switches; hover reveals rename/delete. Rename goes through item.rename(PATCH),
 *  delete through item.delete(DELETE) — deleting the current thread auto-switches the core to a new draft. */
/** The item given by the render callback is the store's ThreadListItemState; only the used fields are declared here,
 *  avoiding @assistant-ui/react's simultaneously exported same-named runtime type (isMain and other runtime-state fields). */
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
              // Sync rename into the pagination cache: deep-page rows don't have to wait for the next fresh page 1 to see the new title
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
      {/* Hover actions: overlaid on the row end, background aligned with the row background to avoid seams */}
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
      {/* Delete confirmation: same Dialog(shadcn) as case/dataset deletions, replacing native window.confirm.
          Mounted inside RailItem so the confirm button's aui.threadListItem.delete() still hits this row's item scope. */}
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
                // Sync row removal into the pagination cache (in step with the store's optimistic delete): without clearing, the row revives from cache on next reload.
                // Delete failure is a network edge case; the row is still in the DB and the next fresh page 1 self-heals.
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

/** i18n keys for section headings: groupToday / groupYesterday / groupWeek / groupMonth / groupOlder */
function bucketLabelKey(k: BucketKey): string {
  return `assistant:threadList.group${k[0]!.toUpperCase()}${k.slice(1)}`;
}

/** Entry within the ItemByIndex scope. Must be a standalone component — inside components.ThreadListItem
 *  useAuiState cannot be called inline (violates the Hooks rule, and unstable component identity causes repeated remounts).
 *  active is subscribed inside the component: store-side vs store-side comparison, and the reference must be stable to pass ItemByIndex's memo. */
function IndexedRailItem() {
  const item = useAuiState((s) => s.optional.threadListItem);
  // Store-side vs store-side: mainThreadId and threadListItem.id are in the same domain, unaffected by mixing local __LOCALID_ with backend uuid
  const active = useAuiState((s) => s.threads.mainThreadId === s.optional.threadListItem?.id);
  if (!item) return null;
  return <RailItem item={item as unknown as RailItemData} active={active} />;
}

/** Render grouped into five sections. The Items primitive is a flat threadIds.map internally with no way to insert section headings,
 *  so ItemByIndex lays out by index, keeping the item scope's switchTo/rename/delete.
 *  An infinite-scroll sentinel hangs at the end: when hasMore, scrolling near the bottom auto-pages. */
function GroupedItems({ createdAtById, pager, scrollRef }: {
  createdAtById: Record<string, string | undefined>;
  pager: ThreadListPager;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  // Locally created threads keep the __LOCALID_-prefixed store id in the store permanently (after reconcile the survivor = local slot),
  // timestamps are keyed by backend uuid → must resolve the store id into remoteId via threadItems before lookup.
  const remoteIdById = useMemo(
    () => new Map(threadItems.map((i) => [i.id, i.remoteId])),
    [threadItems],
  );
  const rows = useMemo(
    () => groupByBucket(threadIds.map((id) => ({ id, createdAt: createdAtById[remoteIdById.get(id) ?? id] }))),
    [threadIds, createdAtById, remoteIdById],
  );
  // ItemByIndex's index must be the original index in threadIds, not the post-grouping sequence number
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

/** Infinite-scroll sentinel: IntersectionObserver watches the scroll container's bottom (rootMargin prefetches 200px early),
 *  on hit pager.loadMore() pages + aui.threads.reload() hydrates the cache back into the runtime store
 *  (the pager is only the data source, the store is the render source of truth). busyRef guards re-entry (layout changes while
 *  paging+reload are in flight re-trigger the observer). Not rendered when hasMore=false, stopping observation. */
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
