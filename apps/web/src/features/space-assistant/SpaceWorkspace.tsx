import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AssistantRuntimeProvider,
  CompositeAttachmentAdapter,
  SimpleImageAttachmentAdapter,
  useAui,
  useAuiState,
  type ThreadSuggestion,
} from '@assistant-ui/react';
import { useTranslation } from 'react-i18next';
import { createPiHttpClient, usePiRuntime, type PiClientEvent } from '@assistant-ui/react-pi';
import { FileAttachmentAdapter } from './FileAttachmentAdapter';
import SpaceThreadPane from './SpaceThreadPane';
import SpaceThreadList from './SpaceThreadList';
import StagePanel from './StagePanel';
import LiveViewRail, { useActiveLiveView } from './LiveViewRail';
import VerticalSplit from '../../components/ui/VerticalSplit';
import { api } from '../../api/client';
import { useSpaceEventsStore } from './spaceEventsStore';
import { ThreadListPager, ThreadPagerContext } from './threadListPager';

/** localStorage key for the left-rail thread list collapsed state ('1' = collapsed). */
const RAIL_COLLAPSED_KEY = 'itest.assistant.railCollapsed';

interface Props {
  /** Version-space id ≡ pi's workspacePath: the thread list is scoped by it, new threads auto-attach. */
  versionId: string;
  /** First prompt from the previous hop's location.state; when non-empty, auto-send once on the initial draft. */
  initialMessage?: string;
  /** Create/send failures inside the runtime (network, assertion) propagate; the page renders a blocking banner accordingly. */
  onError?: (error: unknown) => void;
  /** Thread created successfully but snapshot carries lastError (non-blocking warnings like repo unavailable); reported by thread id. */
  onWarning?: (threadId: string, message: string) => void;
  /** Current thread changed (undefined → draft); the page uses it for per-thread warnings and SSE attribution. */
  onActiveThreadIdChange?: (threadId: string) => void;
}

/**
 * Space assistant runtime container: client points at /api/assistant (a subset sharing /api/pi's contract).
 * Thread management goes through assistant-ui ThreadList (workspacePath-scoped, uncontrolled):
 * the runtime first loads onto the draft, the thread is only truly created when the first message is sent; the left SpaceThreadList handles switch/rename/delete.
 * subscribe dispatch: custom events (confirm_request/stage/announce) first enter the space events store,
 * then pass through unchanged to the runtime (pi contract events are handled by the runtime itself, whose reducer ignores custom events).
 * The parent mounts this component with key=versionId: switching versions remounts a fresh runtime.
 */
export default function SpaceWorkspace({ versionId, initialMessage, onError, onWarning, onActiveThreadIdChange }: Props) {
  const { projectId } = useParams<{ projectId: string; versionId: string }>();
  // Callbacks go through refs: client/usePiRuntime options keep stable references, avoiding rewiring every render
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onWarningRef = useRef(onWarning);
  onWarningRef.current = onWarning;
  const onActiveRef = useRef(onActiveThreadIdChange);
  onActiveRef.current = onActiveThreadIdChange;
  // History thread pager: the react-pi adapter layer disables built-in pagination; list pagination (first screen 50 + infinite scroll) goes through it,
  // the instance lives as long as the component is mounted (the parent remounts by key=versionId, the instance follows the version).
  const pager = useMemo(() => new ThreadListPager(versionId), [versionId]);
  const client = useMemo(() => {
    const base = createPiHttpClient({ baseUrl: '/api/assistant' });
    const ingest = useSpaceEventsStore.getState().ingest;
    return {
      ...base,
      // runtime's list() goes through the pager: fresh page 1 + cached old pages merged by id (see ThreadListPager).
      // Row structure is runtime-compatible with PiThreadMetadata (same backend serialization; the old path already passed react-pi validation),
      // only status's TS union type is wider and needs an assertion.
      listThreads: (() => pager.refreshForRuntime()) as typeof base.listThreads,
      subscribe: (tid: string, listener: (e: PiClientEvent) => void, options?: { includeSnapshot?: boolean }) =>
        base.subscribe(
          tid,
          (e) => {
            ingest(e as unknown as Record<string, unknown>);
            listener(e);
          },
          options,
        ),
      // Thread created successfully but snapshot carries lastError (repo unavailable etc.): doesn't affect the thread, reported to the page by thread id to show a banner
      createThread: async (input?: Parameters<typeof base.createThread>[0]) => {
        const snap = await base.createThread(input);
        const lastError = (snap as { lastError?: string }).lastError;
        if (lastError) onWarningRef.current?.(snap.metadata.id, lastError);
        return snap;
      },
    };
  }, [pager]);
  // Current thread mirror ('' = draft): drives store reset/attribution, and syncs to the page (per-thread warnings)
  const [activeThreadId, setActiveThreadId] = useState('');
  // Left-rail thread list collapsed state: remembered in localStorage, user preference preserved across sessions
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem(RAIL_COLLAPSED_KEY) === '1');
  useEffect(() => {
    localStorage.setItem(RAIL_COLLAPSED_KEY, railCollapsed ? '1' : '0');
  }, [railCollapsed]);
  // On thread switch (including draft↔entity, deleting the current thread auto-falling to draft) clear the previous thread's confirm cards and stage state
  useEffect(() => {
    const store = useSpaceEventsStore.getState();
    store.reset();
    // Thread id stored in the store: StagePanel subscribes to the same state to fetch the staged list; spaceEventsStore is used for SSE stage event upserts
    store.setCurrentThreadId(activeThreadId);
    // Hydrate persisted artifacts: download cards survive across sessions/refreshes after persistence. SSE artifact events are only pushed while running;
    // static threads rely on this to restore download cards. Fetch failure doesn't block the conversation (this round's SSE events can still produce cards live).
    if (activeThreadId) {
      api.listArtifacts(activeThreadId)
        .then((items) => useSpaceEventsStore.getState().hydrateArtifacts(activeThreadId, items))
        .catch(() => { /* list unavailable, degrade to empty, no error toast */ });
    }
  }, [activeThreadId]);
  useEffect(() => () => useSpaceEventsStore.getState().setCurrentThreadId(''), []);
  const hasLiveView = !!useActiveLiveView();
  const { t } = useTranslation();
  // Composite attachment adapters: images go through SimpleImage (dataURL → pi ImageContent);
  // docx/xlsx go through File (pre-upload → send() returns the <uploaded-file …/> tag as a text part,
  // ThreadController flattens it into the message body — verbatim identical to pi's record, userContentKey reconciliation produces no duplicate bubbles).
  const attachments = useMemo(
    () => new CompositeAttachmentAdapter([
      new SimpleImageAttachmentAdapter(),
      new FileAttachmentAdapter(versionId, { tooLarge: t('assistant:attachment.fileTooLarge') }),
    ]),
    [versionId, t],
  );
  // Suggested follow-ups: fetched once by SuggestionWatcher after each AI answer settles, fed into the runtime's suggestions
  // (react-pi passes them through as-is into its external store; rendering in SpaceThreadPane's SuggestionRow).
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
    <ThreadPagerContext.Provider value={pager}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="flex flex-1 min-h-0">
          <div
            className={`${railCollapsed ? 'w-11' : 'w-56'} shrink-0 min-h-0 hidden md:flex flex-col overflow-hidden transition-[width] duration-150`}
            style={{ borderRight: '1px solid var(--border)' }}
          >
            <SpaceThreadList pager={pager} collapsed={railCollapsed} onToggleCollapsed={() => setRailCollapsed((v) => !v)} />
          </div>
          <div className="flex-1 min-w-0 min-h-0" style={{ borderRight: '1px solid var(--border)' }}>
            <SpaceThreadPane threadId={activeThreadId} />
          </div>
          <div className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
            {/* With a live view, split top/bottom (heights draggable); without one, the stage panel fills.
                The no-view branch must have flex flex-col: otherwise the CollapsiblePanel root height degrades to
                auto, the inner overflow-y-auto gets no definite parent height and won't scroll, and content is clipped by the right
                overflow-hidden (same constraint as the VerticalSplit bottom branch). */}
            {hasLiveView ? (
              <VerticalSplit top={<LiveViewRail />} bottom={<StagePanel projectId={projectId!} versionId={versionId} />} />
            ) : (
              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                <StagePanel projectId={projectId!} versionId={versionId} />
              </div>
            )}
          </div>
        </div>
        {/* aui must be used inside AssistantRuntimeProvider; the first prompt is injected after this layer mounts. */}
        {initialMessage && <InitialMessageInjector text={initialMessage} />}
        <SuggestionWatcher threadId={activeThreadId} onSuggestions={setSuggestions} />
      </AssistantRuntimeProvider>
    </ThreadPagerContext.Provider>
  );
}

/** Fetch suggested follow-ups as soon as an answer settles; a new round immediately clears and invalidates in-flight requests.
 *  isRunning uses useAuiState rather than SSE events: react-pi folds agent_start/agent_end/compaction/retry
 *  all into this single boolean (threadState.js's runStatus + isPiStateRunning), matching the "truly idle"
 *  semantic; when the frontend is no longer running the backend is necessarily settled too (same-source session.isStreaming), so the suggestions endpoint is readable.
 *  Skip when threadId is empty (the instant a draft's first message is sent): the entity id isn't ready yet, no way to query. */
function SuggestionWatcher({ threadId, onSuggestions }: { threadId: string; onSuggestions: (s: readonly ThreadSuggestion[]) => void }) {
  const aui = useAui();
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const wasRunningRef = useRef(false);
  // Clear immediately on thread switch: suggestions belong to the previous thread and don't travel with it, otherwise they'd hang under the new thread and mislead clicks.
  useEffect(() => {
    onSuggestions([]);
  }, [threadId, onSuggestions]);
  /** Request generation: +1 when a new round starts; by the time an in-flight response returns the generation has changed → discard, preventing old-round suggestions overwriting the new round. */
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
    // Fetch only on the true→false edge: mount/thread switch/history restore (isRunning stays false) don't trigger,
    // avoiding burning a wasted LLM call every time a thread is entered.
    if (!settled || !threadId) return;
    // The first message's auto title is persisted after this round settles; the promoted draft entry still carries the "New chat" fallback name at this moment;
    // re-pull the list once on the settle edge, refreshing the title (and the new threads enqueued by creation time) into the left rail.
    void aui.threads.reload().catch(() => {});
    const gen = genRef.current;
    void api.assistant
      .suggestions(threadId)
      .then((list) => {
        if (genRef.current !== gen) return;
        onSuggestions(list.map((prompt) => ({ prompt })));
      })
      // Suggestions are a bonus: any failure (LLM unconfigured/no active thread/network) is silent, never interrupting the conversation flow.
      .catch(() => {});
  }, [isRunning, threadId, onSuggestions, aui]);
  return null;
}

/** After the thread list first load completes (an uncontrolled runtime necessarily lands on the draft), send the first prompt into the draft —
 *  onNew → initialize (POST /threads {workspacePath}) → truly persisted and sent.
 *  StrictMode double-trigger is guarded by a ref; if already switched to an entity thread (remoteId non-empty) don't inject again. */
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
