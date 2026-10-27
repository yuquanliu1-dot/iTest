import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import Button from '../components/ui/Button';
import Icon from '../components/Icon';
import {
  PageShell,
  PageShellActions,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
  PageShellTitle,
} from '../components/layout/PageShell';
import SpaceWorkspace from '../features/space-assistant/SpaceWorkspace';
import ThreadHistorySheet from '../features/space-assistant/ThreadHistorySheet';

interface AssistantInitialMessageState {
  initialMessage?: string;
}

/**
 * 版本空间 AI 助手(AI-First 主入口):进入版本空间落地即对话。
 * 线程管理(列表/切换/改名/删除)全部下沉到 SpaceWorkspace 内的 ThreadList 原语,
 * 页面层只剩横幅:创建/发送失败(initError,阻断引导)与按线程的 lastError 警告。
 *
 * 首条消息支持:从用例管理「AI 创建用例」/其他入口带 location.state.initialMessage 跳来时,
 * 在初始草稿上自动注入首条 prompt(注入器在 SpaceWorkspace 内,aui 必须在
 * AssistantRuntimeProvider 内使用,页面不持有 runtime)。
 */
export default function AssistantPage() {
  const { t } = useTranslation();
  const { versionId } = useParams<{ projectId: string; versionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [initError, setInitError] = useState<string | null>(null);
  // 非阻断警告(repo 不可用等,建线程时后端经快照 lastError 透出):按线程 id 记,对话仍可用
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const [activeThreadId, setActiveThreadId] = useState('');
  // 「查看完整历史」抽屉：展示 JSONL 全量（含被压缩掉的旧消息），随活跃线程切换
  const [historyOpen, setHistoryOpen] = useState(false);
  // 上一跳 location.state 携带的首条 prompt:捕获进组件 state,
  // 因为 SpaceWorkspace 挂载后 location.state 会被 effect 清空。
  const [initialMessage] = useState(((location.state ?? {}) as AssistantInitialMessageState).initialMessage);

  // mount 时清掉 location.state,避免用户再次进入同名路径又带回 stale initialMessage
  useEffect(() => {
    if (!initialMessage) return;
    navigate(location.pathname, { replace: true });
    // 仅在 mount 时清 stale state,不依赖 navigate/location(否则每次导航都会触发)
  }, []);

  const llmMissing = initError?.includes('LLM 未配置') ?? false;
  const warning = activeThreadId ? warnings[activeThreadId] : undefined;

  return (
    <PageShell contained>
      <PageShellHeader>
        <PageShellTitle>{t('common:navAssistant')}</PageShellTitle>
        <PageShellDescription>{t('assistant:subtitle')}</PageShellDescription>
        <PageShellActions>
          <Button variant="ghost" size="sm" disabled={!activeThreadId} onClick={() => setHistoryOpen(true)}>
            <Icon name="clock" size={14} />
            {t('assistant:history.button')}
          </Button>
        </PageShellActions>
      </PageShellHeader>

      <PageShellContent className="min-h-0">
        {initError && (
          <div
            className="rounded-[var(--radius-sm)] px-4 py-3 text-[13px] shrink-0"
            style={{ border: '1px solid var(--destructive)', color: 'var(--destructive)' }}
          >
            {initError}
            <div className="flex gap-2 mt-2">
              {llmMissing && <Button size="sm" onClick={() => navigate('/settings')}>{t('assistant:goConfigureModel')}</Button>}
              {/* 阻断错误只影响当次发送:收掉横幅即可重发,无需整页重试 */}
              <Button size="sm" variant="ghost" onClick={() => setInitError(null)}>{t('common:close')}</Button>
            </div>
          </div>
        )}
        {warning && (
          <div
            className="rounded-[var(--radius-sm)] px-4 py-2.5 text-[12px] shrink-0"
            style={{ border: '1px solid var(--warning-soft-border)', color: 'var(--warning)', background: 'var(--warning-soft)' }}
          >
            {warning}
          </div>
        )}
        <SpaceWorkspace
          key={versionId}
          versionId={versionId!}
          initialMessage={initialMessage}
          onError={(e) => setInitError(e instanceof Error ? e.message : String(e))}
          onWarning={(threadId, msg) => setWarnings((m) => ({ ...m, [threadId]: msg }))}
          onActiveThreadIdChange={setActiveThreadId}
        />
      </PageShellContent>

      <ThreadHistorySheet threadId={activeThreadId} open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </PageShell>
  );
}
