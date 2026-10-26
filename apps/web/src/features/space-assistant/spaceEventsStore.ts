import { create } from 'zustand';

/** 后端 confirm_request 事件(pick 相关字段;confirmId 去重用)。 */
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

/** verify_case 实时进度（verify_progress SSE 事件驱动）：逐步渲染 AI 验证进展。 */
export interface VerifyProgressStep {
  order: number;
  status: 'running' | 'passed' | 'failed';
  brief?: string;
  reason?: string;
  durationMs?: number;
  /** LLM 当轮自报的登录行为（'logged-in' 在该步实际执行了登录填表）。 */
  login?: 'logged-in' | 'not-needed';
}

export interface VerifyProgressState {
  caseId: string;
  total: number;
  targetUrl: string | null;
  /** 登录态缓存命中与否（start 事件）；null=未上报。 */
  loginCache: 'hit' | 'miss' | null;
  /** 环境配置的登录用户名；null=未配置凭据。 */
  loginUser: string | null;
  steps: VerifyProgressStep[];
  /** compiled 机械回放干跑（replay_start/replay_done 事件）；null=未进入该阶段。 */
  replay: { status: 'running' | 'passed' | 'failed'; reason?: string } | null;
  result: 'passed' | 'failed' | null;
  /** end 事件：本轮是否已回写登录态缓存。 */
  cacheSaved: boolean;
  /** 本线程暂存的 caseOp 叠加数（>0 表示验证基于暂存修改，未落库）。 */
  stagedOps: number;
  /** 浏览器实时画面流地址（MJPEG multipart，<img> 直接解码）；null=不可用。 */
  liveUrl: string | null;
}

/** solidify_case 实时进度（solidify_progress SSE 事件驱动）：单行指示（start/end 两相）。 */
export interface SolidifyProgressState {
  caseId: string;
  total: number;
  /** 可固化（视觉模式）步骤数（start 事件）。 */
  solidifiable: number;
  result: 'solidified' | 'failed' | 'nothing-solidified' | null;
  /** end 事件：固化步骤数 / 保持视觉步骤数。 */
  solidified: number | null;
  kept: number | null;
  /** 失败原因（result='failed' 时）。 */
  reason: string | null;
  /** 浏览器实时画面流地址（MJPEG multipart，<img> 直接解码）；null=不可用。 */
  liveUrl: string | null;
}

/** artifact SSE 事件（AI 产出文件下载卡）。 */
export interface ArtifactItem {
  token: string;
  name: string;
  size: number;
  count?: number;
  at: string;
}

/** 暂存条目：stage_case / stage_scenario / stage_environment / stage_plan 写入。
 *  payload 是 StageDoc 中对应 kind 的单条对象,前端直接渲染预览/勾选。 */
export interface StagedItem<TPayload = unknown> {
  localId: string;
  kind: Exclude<StageKind, 'group'>;
  payload: TPayload;
  stagedAt: string;
}

/** threadId → (localId → item)；后端 stage 事件 upsert；save 成功后 remove。 */
export type StagedByThread = Map<string, Map<string, StagedItem>>;

/** threadId → 选中的 `kind:localId` 集合。 */
export type StagedSelection = Map<string, Set<string>>;

interface SpaceEventsState {
  /** 当前激活线程 id；SpaceWorkspace mount 时写入,StagePanel 据此拉暂存列表。 */
  threadId: string;
  confirms: SpaceConfirmRequest[];
  /** stage 事件序号(仅前端 stageHistory 渲染局部 key,勿与后端 seq 混)。 */
  stageHistory: StageObject[];
  /** 断线重连重放去重基线:threadId → 该线程已处理过的最大事件 seq。重放事件(快照后按原
   *  seq 重发)与实时事件重叠时,seq ≤ 基线直接丢弃;漏掉的事件(seq > 基线)自然补上。 */
  lastSeqByThread: Map<string, number>;
  announce: AnnounceState | null;
  /** verify_case 实时进度卡数据（verify_progress 事件驱动；agent_start/新一轮清空）。 */
  verifyProgress: VerifyProgressState | null;
  /** solidify_case 实时进度（solidify_progress 事件驱动；agent_start/新一轮清空）。 */
  solidifyProgress: SolidifyProgressState | null;
  /** 暂存对象池：用户预览/勾选 → save 时入参的 source of truth。 */
  stagedByThread: StagedByThread;
  stagedSelection: StagedSelection;
  /** threadId → AI 产出文件列表（artifact 事件驱动；每线程上限 20，新的挤掉最旧的）。
   *  不随 agent_start 清空——产出物是交付结果，不是进行时进度。 */
  artifactsByThread: Map<string, ArtifactItem[]>;
  /** Pi client 订阅分流入口:只认空间自定义事件,pi 契约事件忽略。 */
  ingest: (e: Record<string, unknown>) => void;
  setCurrentThreadId: (threadId: string) => void;
  removeConfirm: (confirmId: string) => void;
  /** 整批替换(初次进入空间页 / 路由切换时由 listStage 拉取后塞入)。 */
  setStaged: (threadId: string, doc: { cases: unknown[]; scenarios: unknown[]; environments: unknown[]; plans: unknown[]; caseOps?: unknown[]; datasets?: unknown[] }) => void;
  toggleStaged: (threadId: string, kind: Exclude<StageKind, 'group'>, localId: string) => void;
  selectAllStaged: (threadId: string, kind: Exclude<StageKind, 'group'>, selected: boolean) => void;
  /** save 后调用:从前端 view 清掉已落库条目 + 选中标记。 */
  removeStagedLocal: (threadId: string, kind: Exclude<StageKind, 'group'>, localIds: string[]) => void;
  reset: () => void;
}

const MAX_STAGE_HISTORY = 50;
let stageSeq = 0;
/** SSE 事件不携带 threadId(由后端 emitThreadEvent 添加但前端不读);
 *  暂存预览按当前激活线程写,threadId 存 store 由 SpaceWorkspace mount 时写入,
 *  StagePanel 订阅同一份 state,规避 window 全局变量的 mount 时序竞态。 */

function keyOf(kind: Exclude<StageKind, 'group'>, localId: string): string {
  return `${kind}:${localId}`;
}

/**
 * 断线重连契约:react-pi 自动重连后,服务端在快照后按原序重放缓冲的会话内自定义事件
 * (verify_progress/announce/stage/solidify_progress,60min 内)与仍挂起的确认卡。
 * 本 store 按线程 seq 去重:已处理过的实时事件不因重放二次生效,漏掉的事件自然补上,
 * 因此重连期间的进度卡/确认卡/暂存预览不丢。快照帧(type='snapshot')不在分支内,天然忽略。
 */
export const useSpaceEventsStore = create<SpaceEventsState>((set, get) => ({
  threadId: '',
  confirms: [],
  stageHistory: [],
  lastSeqByThread: new Map(),
  announce: null,
  verifyProgress: null,
  solidifyProgress: null,
  stagedByThread: new Map(),
  stagedSelection: new Map(),
  artifactsByThread: new Map(),
  ingest: (e) => {
    // 断线重连重放去重:服务端在快照后按原 seq 重发缓冲的会话内事件,与已实时处理的可能重叠——
    // seq <= 该线程已见最大值 = 已处理过,丢弃;首次见到的推进基线。快照帧不进本 store 的分支,
    // 但携带更高的 seq,必须先排除,否则会把重放事件(seq < 快照 seq)一律滤掉。
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
      // action='stage' 且带 payload:upsert 到 stagedByThread(实时预览)
      // action='remove':从 stagedByThread 删除(落库成功后清掉)
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
                  result: e.result === 'failed' ? ('failed' as const) : ('passed' as const),
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
          },
        });
        return;
      }
      if (phase === 'end') {
        set((s) => {
          if (!s.solidifyProgress) return s;
          const result =
            e.result === 'failed' ? 'failed' : e.result === 'nothing-solidified' ? 'nothing-solidified' : 'solidified';
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
        if (list.some((x) => x.token === item.token)) return s; // 重放去重（token 天然幂等）
        const next = new Map(s.artifactsByThread);
        next.set(tid, [...list.slice(-19), item]);
        return { artifactsByThread: next };
      });
      return;
    }
    if (e.type === 'agent_start') {
      // 新一轮开始:清掉上一轮的 announce/verify/solidify 进度(舞台历史保留)
      set((s) =>
        s.announce || s.verifyProgress || s.solidifyProgress
          ? { announce: null, verifyProgress: null, solidifyProgress: null }
          : s,
      );
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
  reset: () => set({
    confirms: [], stageHistory: [], announce: null, verifyProgress: null, solidifyProgress: null,
    stagedByThread: new Map(), stagedSelection: new Map(), lastSeqByThread: new Map(),
    artifactsByThread: new Map(),
  }),
}));
