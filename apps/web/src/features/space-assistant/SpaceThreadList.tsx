import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelLeftClose, PanelLeftOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';

/**
 * 助手左侧线程列表(ThreadList 原语):「新对话」按钮 + 历史线程(切换/改名/删除)。
 * 非受控:当前线程由 runtime 持有,这里只读 main item 的 remoteId 做高亮——
 * undefined 即草稿(新线程首条消息发出前),高亮落到「新对话」上。
 * 草稿不进 Items(底层 threadIds 只收 regular/archived),后端也只返回有消息的线程。
 * 可收缩:collapsed 时只剩窄条(展开按钮 + 新对话图标),宽度切换由父级容器驱动。
 */
export default function SpaceThreadList({ collapsed, onToggleCollapsed }: { collapsed: boolean; onToggleCollapsed: () => void }) {
  const { t } = useTranslation();
  const activeRemoteId = useAuiState((s) => s.optional.threadListItem?.remoteId);
  const isLoading = useAuiState((s) => s.threads.isLoading);
  const threadIds = useAuiState((s) => s.threads.threadIds);
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
        <ThreadListPrimitive.Items>
          {({ threadListItem: item }) => (
            <RailItem key={item.id} item={item} active={item.remoteId === activeRemoteId} />
          )}
        </ThreadListPrimitive.Items>
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
