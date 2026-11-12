import { create } from 'zustand';

/** Backend confirm_request event (pick-related fields; used for confirmId dedup). */
export interface SpaceConfirmRequest {
  confirmId: string;
  toolName: string;
  action: string;
  summary: string;
  diff?: string;
  risk: 'update' | 'delete' | 'secret';
}

export type StageKind = 'case' | 'case_op' | 'scenario' | 'environment' | 'plan' | 'dataset' | 'group';

export interface StageObject {
  key: string;
  kind: StageKind;
  id: string;
  action: string;
  diff?: string;
}

export interface AnnounceState {
  summary: string;
  total: number;
  done: number;
}

/** verify_case live progress (driven by verify_progress SSE events): renders AI verification progress step by step. */
export interface VerifyProgressStep {
  order: number;
  status: 'running' | 'passed' | 'failed';
  brief?: string;
  reason?: string;
  durationMs?: number;
  /** Login behavior self-reported by the LLM that round ('logged-in' = the step actually performed the login form fill). */
  login?: 'logged-in' | 'not-needed';
}

export interface VerifyProgressState {
  caseId: string;
  total: number;
  targetUrl: string | null;
  /** Whether the login state cache was hit (start event); null = not reported. */
  loginCache: 'hit' | 'miss' | null;
  /** Login username configured on the environment; null = no credentials configured. */
  loginUser: string | null;
  steps: VerifyProgressStep[];
  /** compiled mechanical replay dry run (replay_start/replay_done events); null = phase not entered. */
  replay: { status: 'running' | 'passed' | 'failed'; reason?: string } | null;
  result: 'passed' | 'failed' | 'cancelled' | null;
  /** end event: whether the login state cache was written back this round. */
  cacheSaved: boolean;
  /** Number of staged caseOp overlays on this thread (>0 = verification based on staged changes not yet persisted). */
  stagedOps: number;
  /** Browser live view stream URL (MJPEG multipart, decoded directly by <img>); null = unavailable. */
  liveUrl: string | null;
  /** seq of this round's start event (globally monotonic on the backend): when multiple cards have liveUrl, use it to pick the latest round,
   *  so the login card and the previous round's finished verify card don't fight over the same view area (a finished liveUrl 404s on reconnect). */
  seq?: number;
}

/** solidify_case live progress (driven by solidify_progress SSE events): single-line indicator (start/end phases). */
export interface SolidifyProgressState {
  caseId: string;
  total: number;
  /** Number of solidifiable (visual-mode) steps (start event). */
  solidifiable: number;
  result: 'solidified' | 'failed' | 'nothing-solidified' | 'cancelled' | null;
  /** end event: solidified step count / steps kept as visual. */
  solidified: number | null;
  kept: number | null;
  /** Failure reason (when result='failed'). */
  reason: string | null;
  /** Browser live view stream URL (MJPEG multipart, decoded directly by <img>); null = unavailable. */
  liveUrl: string | null;
  /** seq of this round's start event (globally monotonic on the backend): when multiple cards have liveUrl, use it to pick the latest round. */
  seq?: number;
}

/** perform_login environment-credential login progress (driven by login_progress SSE events): live-streams the whole login in the right rail. */
export interface LoginProgressState {
  /** Login username configured on the environment; null = unknown (batch path / no credentials). */
  user: string | null;
  /** Login target URL. */
  targetUrl: string | null;
  result: 'passed' | 'failed' | null;
  /** Browser live view stream URL (MJPEG multipart, decoded directly by <img>); null = unavailable. */
  liveUrl: string | null;
  /** seq of this round's start event (globally monotonic on the backend): when multiple cards have liveUrl, use it to pick the latest round. */
  seq?: number;
}

/** artifact SSE event (AI-produced file download card). */
export interface ArtifactItem {
  token: string;
  name: string;
  size: number;
  count?: number;
  at: string;
}

/** Staged entries: written by stage_case / stage_scenario / stage_environment / stage_plan.
 *  payload is the single object of the corresponding kind in StageDoc; the frontend renders preview/checkboxes directly. */
export interface StagedItem<TPayload = unknown> {
  localId: string;
  kind: Exclude<StageKind, 'group'>;
  payload: TPayload;
  stagedAt: string;
}

/** threadId → (localId → item); upserted by backend stage events; removed after save succeeds. */
export type StagedByThread = Map<string, Map<string, StagedItem>>;

/** threadId → set of selected `kind:localId`. */
export type StagedSelection = Map<string, Set<string>>;

interface SpaceEventsState {
  /** Currently active thread id; written on SpaceWorkspace mount, StagePanel uses it to fetch the staged list. */
  threadId: string;
  confirms: SpaceConfirmRequest[];
  /** stage event sequence (only a local render key for frontend stageHistory; do not confuse with the backend seq). */
  stageHistory: StageObject[];
  /** Replay-dedup baseline on reconnect: threadId → the max event seq already processed for that thread. When replayed events (re-sent
   *  by original seq after the snapshot) overlap live events, seq ≤ baseline is dropped directly; missed events (seq > baseline) are naturally covered. */
  lastSeqByThread: Map<string, number>;
  announce: AnnounceState | null;
  /** verify_case live progress card data (driven by verify_progress events). Completed cards are not cleared on
   *  agent_start — the right-rail live view frozen frame/replay survives across rounds; a new round's events overwrite wholesale. */
  verifyProgress: VerifyProgressState | null;
  /** solidify_case live progress (driven by solidify_progress events). Same lifecycle as verifyProgress. */
  solidifyProgress: SolidifyProgressState | null;
  /** perform_login environment-credential login progress (driven by login_progress events). Same lifecycle as verifyProgress. */
  loginProgress: LoginProgressState | null;
  /** Staged object pool: user preview/checkboxes → source of truth for the save payload. */
  stagedByThread: StagedByThread;
  stagedSelection: StagedSelection;
  /** threadId → AI-produced file list (driven by artifact events; cap 20 per thread, newer evicts oldest).
   *  Not cleared on agent_start — deliverables are results, not in-flight progress. */
  artifactsByThread: Map<string, ArtifactItem[]>;
  /** Pi client subscription dispatch entry: only accepts space custom events, ignores pi contract events. */
  ingest: (e: Record<string, unknown>) => void;
  setCurrentThreadId: (threadId: string) => void;
  removeConfirm: (confirmId: string) => void;
  /** Bulk replace (populated from listStage on first entering the space page / on route switch). */
  setStaged: (threadId: string, doc: { cases: unknown[]; scenarios: unknown[]; environments: unknown[]; plans: unknown[]; caseOps?: unknown[]; datasets?: unknown[] }) => void;
  toggleStaged: (threadId: string, kind: Exclude<StageKind, 'group'>, localId: string) => void;
  selectAllStaged: (threadId: string, kind: Exclude<StageKind, 'group'>, selected: boolean) => void;
  /** Called after save: clears persisted entries + selection marks from the frontend view. */
  removeStagedLocal: (threadId: string, kind: Exclude<StageKind, 'group'>, localIds: string[]) => void;
  /** Hydrates persisted artifacts after switching threads (merges REST list with SSE events, dedup by token). */
  hydrateArtifacts: (threadId: string, items: Array<{ token: string; name: string; size: number; count: number | null; createdAt: string }>) => void;
  reset: () => void;
}

const MAX_STAGE_HISTORY = 50;
let stageSeq = 0;
/** SSE events do not carry threadId (added by the backend's emitThreadEvent but not read by the frontend);
 *  staged previews are written against the currently active thread; threadId lives in the store, written on SpaceWorkspace mount,
 *  and StagePanel subscribes to the same state, avoiding the mount-timing race of window globals. */

function keyOf(kind: Exclude<StageKind, 'group'>, localId: string): string {
  return `${kind}:${localId}`;
}

/**
 * Reconnect contract: after react-pi auto-reconnects, the server replays buffered in-session custom events
 * (verify_progress/announce/stage/solidify_progress, within 60min) plus still-pending confirm cards in original order.
 * This store dedups by thread seq: already-processed live events don't take effect twice on replay, missed events
 * are covered naturally, so progress/confirm/staged previews survive reconnects. Snapshot frames (type='snapshot') hit no branch, naturally ignored.
 */
export const useSpaceEventsStore = create<SpaceEventsState>((set, get) => ({
  threadId: '',
  confirms: [],
  stageHistory: [],
  lastSeqByThread: new Map(),
  announce: null,
  verifyProgress: null,
  solidifyProgress: null,
  loginProgress: null,
  stagedByThread: new Map(),
  stagedSelection: new Map(),
  artifactsByThread: new Map(),
  ingest: (e) => {
    // Reconnect replay dedup: after the snapshot the server re-sends buffered in-session events by original seq, which may
    // overlap live events already processed — seq <= the thread's max seen seq = processed, drop; first sight advances the baseline.
    // Snapshot frames don't hit this store's branches but carry a higher seq; exclude them first or replays (seq < snapshot seq) get filtered wholesale.
    if (e.type !== 'snapshot') {
      const seq = e.seq;
      if (typeof seq === 'number') {
        const tid = typeof e.threadId === 'string' ? e.threadId : '';
        if (tid) {
          if (seq <= (get().lastSeqByThread.get(tid) ?? -1)) return;
          set((s) => {
            const next = new Map(s.lastSeqByThread);
            next.set(tid, seq);
            return { lastSeqByThread: next };
          });
        }
      }
    }
    if (e.type === 'confirm_request') {
      const c = e as unknown as SpaceConfirmRequest;
      set((s) => (s.confirms.some((x) => x.confirmId === c.confirmId) ? s : { confirms: [...s.confirms, c] }));
      return;
    }
    if (e.type === 'stage') {
      const kind = e.kind as Exclude<StageKind, 'group'>;
      const action = e.action as string;
      const id = e.id as string;
      const obj: StageObject = { key: `s${++stageSeq}`, kind: e.kind as StageKind, id, action, ...(typeof e.diff === 'string' ? { diff: e.diff } : {}) };
      // action='stage' with payload: upsert into stagedByThread (live preview)
      // action='remove': delete from stagedByThread (cleared after successful persistence)
      const patch = (s: SpaceEventsState): Partial<SpaceEventsState> => {
        const next = new Map(s.stagedByThread);
        const map = new Map(next.get(s.threadId) ?? []);
        if (action === 'stage' && e.payload) {
          map.set(id, { localId: id, kind, payload: e.payload, stagedAt: (e.payload as { stagedAt?: string }).stagedAt ?? '' });
        } else if (action === 'remove') {
          map.delete(id);
        }
        next.set(s.threadId, map);
        return { stagedByThread: next };
      };
      set((s) => ({
        ...patch(s),
        stageHistory: [...s.stageHistory, obj].slice(-MAX_STAGE_HISTORY),
        announce: s.announce ? { ...s.announce, done: s.announce.done + 1 } : s.announce,
      }));
      return;
    }
    if (e.type === 'announce') {
      set({
        announce: { summary: String(e.summary ?? ''), total: Number(e.total ?? 0), done: 0 },
      });
      return;
    }
    if (e.type === 'verify_progress') {
      const phase = e.phase as string;
      if (phase === 'start') {
        set({
          verifyProgress: {
            caseId: String(e.caseId ?? ''),
            total: Number(e.total ?? 0),
            targetUrl: (e.targetUrl as string | null) ?? null,
            loginCache: e.loginCache === 'hit' || e.loginCache === 'miss' ? e.loginCache : null,
            loginUser: typeof e.loginUser === 'string' ? e.loginUser : null,
            steps: [],
            replay: null,
            result: null,
            cacheSaved: false,
            stagedOps: Number(e.stagedOps ?? 0),
            liveUrl: typeof e.liveUrl === 'string' ? e.liveUrl : null,
            ...(typeof e.seq === 'number' ? { seq: e.seq } : {}),
          },
        });
        return;
      }
      if (phase === 'step_start') {
        set((s) =>
          s.verifyProgress
            ? {
                verifyProgress: {
                  ...s.verifyProgress,
                  steps: [
                    ...s.verifyProgress.steps,
                    {
                      order: Number(e.order ?? 0),
                      status: 'running' as const,
                      ...(typeof e.brief === 'string' ? { brief: e.brief } : {}),
                    },
                  ],
                },
              }
            : s,
        );
        return;
      }
      if (phase === 'step_done') {
        set((s) => {
          if (!s.verifyProgress) return s;
          const steps = s.verifyProgress.steps.map((st) =>
            st.order === Number(e.order)
              ? {
                  ...st,
                  status: (e.status === 'failed' ? 'failed' : 'passed') as 'failed' | 'passed',
                  ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
                  ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
                  ...(e.login === 'logged-in' || e.login === 'not-needed'
                    ? { login: e.login as 'logged-in' | 'not-needed' }
                    : {}),
                }
              : st,
          );
          return { verifyProgress: { ...s.verifyProgress, steps } };
        });
        return;
      }
      if (phase === 'replay_start') {
        set((s) =>
          s.verifyProgress
            ? { verifyProgress: { ...s.verifyProgress, replay: { status: 'running' as const } } }
            : s,
        );
        return;
      }
      if (phase === 'replay_done') {
        set((s) =>
          s.verifyProgress
            ? {
                verifyProgress: {
                  ...s.verifyProgress,
                  replay: {
                    status: e.status === 'failed' ? ('failed' as const) : ('passed' as const),
                    ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
                  },
                },
              }
            : s,
        );
        return;
      }
      if (phase === 'end') {
        set((s) =>
          s.verifyProgress
            ? {
                verifyProgress: {
                  ...s.verifyProgress,
                  result:
                    e.result === 'failed' ? ('failed' as const)
                    : e.result === 'cancelled' ? ('cancelled' as const)
                    : ('passed' as const),
                  cacheSaved: e.cacheSaved === true,
                },
              }
            : s,
        );
      }
      return;
    }
    if (e.type === 'solidify_progress') {
      const phase = e.phase as string;
      if (phase === 'start') {
        set({
          solidifyProgress: {
            caseId: String(e.caseId ?? ''),
            total: Number(e.total ?? 0),
            solidifiable: Number(e.solidifiable ?? 0),
            result: null,
            solidified: null,
            kept: null,
            reason: null,
            liveUrl: typeof e.liveUrl === 'string' ? e.liveUrl : null,
            ...(typeof e.seq === 'number' ? { seq: e.seq } : {}),
          },
        });
        return;
      }
      if (phase === 'end') {
        set((s) => {
          if (!s.solidifyProgress) return s;
          const result =
            e.result === 'failed' ? 'failed'
            : e.result === 'nothing-solidified' ? 'nothing-solidified'
            : e.result === 'cancelled' ? 'cancelled'
            : 'solidified';
          return {
            solidifyProgress: {
              ...s.solidifyProgress,
              result,
              ...(typeof e.solidified === 'number' ? { solidified: e.solidified } : {}),
              ...(typeof e.kept === 'number' ? { kept: e.kept } : {}),
              ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
            },
          };
        });
      }
      return;
    }
    if (e.type === 'login_progress') {
      const phase = e.phase as string;
      if (phase === 'start') {
        set({
          loginProgress: {
            user: typeof e.user === 'string' ? e.user : null,
            targetUrl: typeof e.targetUrl === 'string' ? e.targetUrl : null,
            result: null,
            liveUrl: typeof e.liveUrl === 'string' ? e.liveUrl : null,
            ...(typeof e.seq === 'number' ? { seq: e.seq } : {}),
          },
        });
        return;
      }
      if (phase === 'end') {
        set((s) =>
          s.loginProgress
            ? {
                loginProgress: {
                  ...s.loginProgress,
                  result: e.result === 'failed' ? ('failed' as const) : ('passed' as const),
                },
              }
            : s,
        );
      }
      return;
    }
    if (e.type === 'artifact') {
      const item: ArtifactItem = {
        token: String(e.token ?? ''),
        name: String(e.name ?? 'export.xmind'),
        size: Number(e.size ?? 0),
        ...(typeof e.count === 'number' ? { count: e.count } : {}),
        at: new Date().toISOString(),
      };
      if (!item.token) return;
      const tid = typeof e.threadId === 'string' && e.threadId ? e.threadId : get().threadId;
      set((s) => {
        const list = s.artifactsByThread.get(tid) ?? [];
        if (list.some((x) => x.token === item.token)) return s; // replay dedup (token is naturally idempotent)
        const next = new Map(s.artifactsByThread);
        next.set(tid, [...list.slice(-19), item]);
        return { artifactsByThread: next };
      });
      return;
    }
    if (e.type === 'agent_start') {
      // New round starts: clear the previous round's announce (stage history kept); verify/solidify/login only clear "unfinished"
      // cards (running cards left behind by stopped runs/errors). Completed progress cards must be kept — the right-rail live view's
      // frozen frame and replay button depend on them, and a finished liveUrl 404s on new connections, remount = black screen: the
      // B-path per-item confirm discussion window must not lose its view. A new round's events overwrite wholesale when they arrive.
      set((s) => {
        const verifyStale = s.verifyProgress !== null && s.verifyProgress.result === null;
        const solidifyStale = s.solidifyProgress !== null && s.solidifyProgress.result === null;
        const loginStale = s.loginProgress !== null && s.loginProgress.result === null;
        if (!s.announce && !verifyStale && !solidifyStale && !loginStale) return s;
        return {
          announce: null,
          verifyProgress: verifyStale ? null : s.verifyProgress,
          solidifyProgress: solidifyStale ? null : s.solidifyProgress,
          loginProgress: loginStale ? null : s.loginProgress,
        };
      });
    }
  },
  removeConfirm: (confirmId) =>
    set((s) => ({ confirms: s.confirms.filter((c) => c.confirmId !== confirmId) })),
  setCurrentThreadId: (threadId) => set({ threadId }),
  setStaged: (threadId, doc) => set((s) => {
    const next = new Map(s.stagedByThread);
    const map = new Map<string, StagedItem>();
    const upsert = (kind: Exclude<StageKind, 'group'>, x: unknown) => {
      const obj = x as { localId: string; stagedAt?: string };
      map.set(obj.localId, {
        localId: obj.localId,
        kind,
        payload: x,
        stagedAt: obj.stagedAt ?? '',
      });
    };
    for (const x of doc.cases) upsert('case', x);
    for (const x of doc.scenarios) upsert('scenario', x);
    for (const x of doc.environments) upsert('environment', x);
    for (const x of doc.plans) upsert('plan', x);
    for (const x of (doc.caseOps ?? [])) upsert('case_op', x);
    for (const x of (doc.datasets ?? [])) upsert('dataset', x);
    next.set(threadId, map);
    return { stagedByThread: next };
  }),
  toggleStaged: (threadId, kind, localId) => set((s) => {
    const next = new Map(s.stagedSelection);
    const set0 = new Set(next.get(threadId) ?? []);
    const k = keyOf(kind, localId);
    if (set0.has(k)) set0.delete(k); else set0.add(k);
    next.set(threadId, set0);
    return { stagedSelection: next };
  }),
  selectAllStaged: (threadId, kind, selected) => set((s) => {
    const staged = s.stagedByThread.get(threadId);
    const next = new Map(s.stagedSelection);
    const set0 = new Set(next.get(threadId) ?? []);
    if (!staged) return s;
    for (const [localId, item] of staged.entries()) {
      if (item.kind !== kind) continue;
      const k = keyOf(kind, localId);
      if (selected) set0.add(k); else set0.delete(k);
    }
    next.set(threadId, set0);
    return { stagedSelection: next };
  }),
  removeStagedLocal: (threadId, kind, localIds) => set((s) => {
    const map = s.stagedByThread.get(threadId);
    if (!map) return s;
    const nextMap = new Map(map);
    for (const lid of localIds) nextMap.delete(lid);
    const next = new Map(s.stagedByThread);
    next.set(threadId, nextMap);
    const sel = new Map(s.stagedSelection);
    const selSet = new Set(sel.get(threadId) ?? []);
    for (const lid of localIds) selSet.delete(keyOf(kind, lid));
    sel.set(threadId, selSet);
    return { stagedByThread: next, stagedSelection: sel };
  }),
  hydrateArtifacts: (threadId, items) => set((s) => {
    const existing = s.artifactsByThread.get(threadId) ?? [];
    const seen = new Set(existing.map((x) => x.token));
    const merged = [...existing];
    for (const it of items) {
      if (seen.has(it.token)) continue;
      seen.add(it.token);
      merged.push({ token: it.token, name: it.name, size: it.size, ...(it.count != null ? { count: it.count } : {}), at: it.createdAt });
    }
    // Sort ascending by time to align with SSE append order; the cap of 20 matches the ingest branch.
    merged.sort((a, b) => a.at.localeCompare(b.at));
    const next = new Map(s.artifactsByThread);
    next.set(threadId, merged.slice(-20));
    return { artifactsByThread: next };
  }),
  reset: () => set({
    confirms: [], stageHistory: [], announce: null, verifyProgress: null, solidifyProgress: null, loginProgress: null,
    stagedByThread: new Map(), stagedSelection: new Map(), lastSeqByThread: new Map(),
    artifactsByThread: new Map(),
  }),
}));
