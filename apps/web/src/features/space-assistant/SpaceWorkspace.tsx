import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  useAui,
  useAuiState,
  type ThreadSuggestion,
} from '@assistant-ui/react';
import { createPiHttpClient, usePiRuntime, type PiClientEvent } from '@assistant-ui/react-pi';
import SpaceThreadPane from './SpaceThreadPane';
import SpaceThreadList from './SpaceThreadList';
import StagePanel from './StagePanel';
import LiveViewRail, { useActiveLiveView } from './LiveViewRail';
import VerticalSplit from '../../components/ui/VerticalSplit';
import { api } from '../../api/client';
import { useSpaceEventsStore } from './spaceEventsStore';

/** 左栏线程列表收缩态的 localStorage key('1'=收缩)。 */
const RAIL_COLLAPSED_KEY = 'itest.assistant.railCollapsed';

interface Props {
  /** 版本空间 id ≡ pi 的 workspacePath:线程列表按它圈定,新线程自动归属。 */
  versionId: string;
  /** 来自上一跳 location.state 的首条 prompt;非空时在初始草稿上自动发一次。 */
  initialMessage?: string;
  /** runtime 内创建/发送失败(网络、断言)上抛;页面据此渲染阻断横幅。 */
  onError?: (error: unknown) => void;
  /** 建线程成功但快照带 lastError(repo 不可用等非阻断警告),按线程 id 上报。 */
  onWarning?: (threadId: string, message: string) => void;
  /** 当前线程变化(undefined → 草稿);页面用于按线程显警告、SSE 归属。 */
  onActiveThreadIdChange?: (threadId: string) => void;
}

/**
 * 空间助手运行时容器:client 指向 /api/assistant(与 /api/pi 同契约的子集)。
 * 线程管理走 assistant-ui ThreadList(workspacePath 作用域,非受控):
 * runtime 首载落在草稿上,发首条消息才真正建线程;左栏 SpaceThreadList 负责切换/改名/删除。
 * subscribe 分流:自定义事件(confirm_request/stage/announce)先进空间事件 store,
 * 再原样交给 runtime(pi 契约事件 runtime 自己处理,自定义事件其 reducer 忽略)。
 * 父级以 key=versionId 挂载本组件:切版本即重挂载出全新 runtime。
 */
export default function SpaceWorkspace({ versionId, initialMessage, onError, onWarning, onActiveThreadIdChange }: Props) {
  const { projectId } = useParams<{ projectId: string; versionId: string }>();
  // 回调走 ref:client/usePiRuntime 选项保持稳定引用,避免每渲染重接线
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onWarningRef = useRef(onWarning);
  onWarningRef.current = onWarning;
  const onActiveRef = useRef(onActiveThreadIdChange);
  onActiveRef.current = onActiveThreadIdChange;
  const client = useMemo(() => {
    const base = createPiHttpClient({ baseUrl: '/api/assistant' });
    const ingest = useSpaceEventsStore.getState().ingest;
    return {
      ...base,
      subscribe: (tid: string, listener: (e: PiClientEvent) => void, options?: { includeSnapshot?: boolean }) =>
        base.subscribe(
          tid,
          (e) => {
            ingest(e as unknown as Record<string, unknown>);
            listener(e);
          },
          options,
        ),
      // 建线程成功但快照带 lastError(repo 不可用等):不影响对话,按线程 id 上报给页面出横幅
      createThread: async (input?: Parameters<typeof base.createThread>[0]) => {
        const snap = await base.createThread(input);
        const lastError = (snap as { lastError?: string }).lastError;
        if (lastError) onWarningRef.current?.(snap.metadata.id, lastError);
        return snap;
      },
    };
  }, []);
  // 当前线程镜像(''=草稿):驱动 store 重置/归属,并同步给页面(按线程显警告)
  const [activeThreadId, setActiveThreadId] = useState('');
  // 左栏线程列表收缩态:记忆在 localStorage,跨会话保留用户偏好
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem(RAIL_COLLAPSED_KEY) === '1');
  useEffect(() => {
    localStorage.setItem(RAIL_COLLAPSED_KEY, railCollapsed ? '1' : '0');
  }, [railCollapsed]);
  // 线程切换(含草稿↔实体、删除当前线程自动落草稿)时清掉上一线程的确认卡与舞台状态
  useEffect(() => {
    const store = useSpaceEventsStore.getState();
    store.reset();
    // 线程 id 存 store:StagePanel 订阅同一份 state 拉暂存列表,spaceEventsStore 用于 SSE stage 事件 upsert
    store.setCurrentThreadId(activeThreadId);
  }, [activeThreadId]);
  useEffect(() => () => useSpaceEventsStore.getState().setCurrentThreadId(''), []);
  const hasLiveView = !!useActiveLiveView();
  // 图片附件 adapter:composer 的 addAttachment 没有 adapter 会直接抛
  // 「Attachments are not supported」(base-composer-runtime-core.js:470),而 react-pi
  // 不提供 attachment adapter,必须由这里注入。这个实现把 File 读成 dataURL,
  // ThreadController 再拆成 pi 的 ImageContent 随 input.attachments 上行。
  const attachments = useMemo(() => new SimpleImageAttachmentAdapter(), []);
  // 推荐追问:AI 每轮回答落定后由 SuggestionWatcher 拉一次,喂给 runtime 的 suggestions
  // (react-pi 原样透传进外部 store,渲染见 SpaceThreadPane 的 SuggestionRow)。
  const [suggestions, setSuggestions] = useState<readonly ThreadSuggestion[]>([]);
  const runtime = usePiRuntime({
    client,
    workspacePath: versionId,
    adapters: { attachments },
    suggestions,
    onThreadIdChange: (id) => {
      const next = id ?? '';
      setActiveThreadId(next);
      onActiveRef.current?.(next);
    },
    onError: (e) => onErrorRef.current?.(e),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-1 min-h-0">
        <div
          className={`${railCollapsed ? 'w-11' : 'w-56'} shrink-0 min-h-0 hidden md:flex flex-col overflow-hidden transition-[width] duration-150`}
          style={{ borderRight: '1px solid var(--border)' }}
        >
          <SpaceThreadList collapsed={railCollapsed} onToggleCollapsed={() => setRailCollapsed((v) => !v)} />
        </div>
        <div className="flex-1 min-w-0 min-h-0" style={{ borderRight: '1px solid var(--border)' }}>
          <SpaceThreadPane threadId={activeThreadId} />
        </div>
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
          {/* 有实时画面时上下分栏（可拖拽调整各自高度）；无画面时暂存面板占满。 */}
          {hasLiveView ? (
            <VerticalSplit top={<LiveViewRail />} bottom={<StagePanel projectId={projectId!} versionId={versionId} />} />
          ) : (
            <div className="flex-1 min-w-0 min-h-0">
              <StagePanel projectId={projectId!} versionId={versionId} />
            </div>
          )}
        </div>
      </div>
      {/* aui 必须在 AssistantRuntimeProvider 内使用;首条 prompt 在此层挂载后注入。 */}
      {initialMessage && <InitialMessageInjector text={initialMessage} />}
      <SuggestionWatcher threadId={activeThreadId} onSuggestions={setSuggestions} />
    </AssistantRuntimeProvider>
  );
}

/** 回答落定即拉推荐追问;新一轮开始立刻清空并作废在途请求。
 *  isRunning 用 useAuiState 而非 SSE 事件:react-pi 把 agent_start/agent_end/压缩/重试
 *  全部折进这一个布尔(threadState.js 的 runStatus + isPiStateRunning),对齐「真正空闲」
 *  语义;前端不再 running 时后端也必然 settled(同源 session.isStreaming),转写读得到。
 *  threadId 为空(草稿首条消息发出的瞬间)时跳过:实体 id 尚未就绪,接口无从查起。 */
function SuggestionWatcher({ threadId, onSuggestions }: { threadId: string; onSuggestions: (s: readonly ThreadSuggestion[]) => void }) {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const wasRunningRef = useRef(false);
  // 切线程立刻清空:建议属于上一线程,不随线程走,否则会挂到新线程脚下误导点击。
  useEffect(() => {
    onSuggestions([]);
  }, [threadId, onSuggestions]);
  /** 请求代数:新一轮开始时 +1,在途响应回来时代数已变 → 丢弃,防旧轮建议覆盖新轮。 */
  const genRef = useRef(0);
  useEffect(() => {
    if (isRunning) {
      if (!wasRunningRef.current) onSuggestions([]);
      genRef.current += 1;
      wasRunningRef.current = true;
      return;
    }
    const settled = wasRunningRef.current;
    wasRunningRef.current = false;
    // 只在 true→false 边沿拉取:mount/切线程/恢复历史(isRunning 一直为 false)不触发,
    // 避免每次进入线程都白烧一次 LLM 调用。
    if (!settled || !threadId) return;
    // 首条消息的自动标题落库在本轮 settle 之后,晋升的草稿条目此刻还顶着「新对话」兜底名;
    // settle 边沿重拉一次列表,把标题与 updatedAt 排序刷新进左栏。
    void aui.threads.reload().catch(() => {});
    const gen = genRef.current;
    void api.assistant
      .suggestions(threadId)
      .then((list) => {
        if (genRef.current !== gen) return;
        onSuggestions(list.map((prompt) => ({ prompt })));
      })
      // 建议是锦上添花:任何失败(LLM 未配置/无活跃会话/网络)静默,不打断对话流。
      .catch(() => {});
  }, [isRunning, threadId, onSuggestions, aui]);
  return null;
}

/** 线程列表首载完成(runtime 非受控必然落在草稿上)后,把首条 prompt 发进草稿——
 *  onNew → initialize(POST /threads {workspacePath}) → 真正落库并发送。
 *  StrictMode 双触发由 ref 守护;若已切到实体线程(remoteId 非空)则不再注入。 */
function InitialMessageInjector({ text }: { text: string }) {
  const aui = useAui();
  const remoteId = useAuiState((s) => s.optional.threadListItem?.remoteId);
  const listLoading = useAuiState((s) => s.threads.isLoading);
  const sentRef = useRef(false);
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    if (sentRef.current) return;
    if (listLoading || remoteId !== undefined) return;
    sentRef.current = true;
    aui.thread.append(textRef.current);
  }, [listLoading, remoteId, aui]);
  return null;
}
