import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelLeftClose, PanelLeftOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { api } from '../../api/client';
import { groupByBucket, type BucketKey } from './threadBuckets';

/** 线程时间表:后端 uuid → updatedAt。react-pi store 里拿不到时间(mapThreadMetadata 丢弃),自持一份。 */
async function fetchUpdatedAtById(versionId: string): Promise<Record<string, string | undefined>> {
  const rows = await api.assistant.listThreads(versionId);
  return Object.fromEntries(rows.map((r) => [r.id, r.updatedAt]));
}

/**
 * 助手左侧线程列表(ThreadList 原语):「新对话」按钮 + 历史线程(切换/改名/删除)。
 * 非受控:当前线程由 runtime 持有,这里只读 main item 的 remoteId 做高亮——
 * undefined 即草稿(新线程首条消息发出前),高亮落到「新对话」上。
 * 草稿不进 Items(底层 threadIds 只收 regular/archived),后端也只返回有消息的线程。
 * 可收缩:collapsed 时只剩窄条(展开按钮 + 新对话图标),宽度切换由父级容器驱动。
 */
export default function SpaceThreadList({ versionId, collapsed, onToggleCollapsed }: {
  versionId: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { t } = useTranslation();
  const activeRemoteId = useAuiState((s) => s.optional.threadListItem?.remoteId);
  const isLoading = useAuiState((s) => s.threads.isLoading);
  const threadIds = useAuiState((s) => s.threads.threadIds);
  // react-pi 的 mapThreadMetadata 丢弃 updatedAt(只透传 status/title/custom 且 custom 是重建的),
  // store 里拿不到时间 → 自持一份。挂载/对话 settle 时刷新,否则刚聊过的会话留在旧桶。
  const [updatedAtById, setUpdatedAtById] = useState<Record<string, string | undefined>>({});
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const wasRunningRef = useRef(false);
  useEffect(() => {
    let alive = true;
    void fetchUpdatedAtById(versionId)
      .then((m) => { if (alive) setUpdatedAtById(m); })
      .catch(() => {}); // 列表拉不到就全落「更早」,不打断对话
    return () => { alive = false; };
  }, [versionId]);

  // 一轮对话 settle(与 SuggestionWatcher 同一 true→false 边沿)→ 重拉时间表
  useEffect(() => {
    if (isRunning) { wasRunningRef.current = true; return; }
    const settled = wasRunningRef.current;
    wasRunningRef.current = false;
    if (!settled) return;
    void fetchUpdatedAtById(versionId).then(setUpdatedAtById).catch(() => {});
  }, [isRunning, versionId]);
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
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5">
        {!isLoading && threadIds.length === 0 && (
          <div className="text-[12px] px-2 py-1" style={{ color: 'var(--muted-foreground)' }}>
            {t('assistant:threadList.noHistory')}
          </div>
        )}
        <GroupedItems updatedAtById={updatedAtById} />
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
  const [editing, setEditing] = useState(false);
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
            if (v) aui.threadListItem.rename(v);
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
          onClick={() => {
            if (window.confirm(t('assistant:threadList.confirmDelete', { title: item.title || t('assistant:threadList.untitled') })))
              aui.threadListItem.delete();
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
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
 *  故用 ItemByIndex 按 index 自行排版,保留 item scope 的 switchTo/rename/delete。 */
function GroupedItems({ updatedAtById }: {
  updatedAtById: Record<string, string | undefined>;
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
    </>
  );
}
