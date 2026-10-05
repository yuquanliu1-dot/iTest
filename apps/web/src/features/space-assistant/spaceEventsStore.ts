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

export type StageKind = 'case' | 'scenario' | 'environment' | 'plan' | 'group';

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
  stageHistory: StageObject[];
  announce: AnnounceState | null;
  /** 暂存对象池：用户预览/勾选 → save 时入参的 source of truth。 */
  stagedByThread: StagedByThread;
  stagedSelection: StagedSelection;
  /** Pi client 订阅分流入口:只认空间自定义事件,pi 契约事件忽略。 */
  ingest: (e: Record<string, unknown>) => void;
  setCurrentThreadId: (threadId: string) => void;
  removeConfirm: (confirmId: string) => void;
  /** 整批替换(初次进入空间页 / 路由切换时由 listStage 拉取后塞入)。 */
  setStaged: (threadId: string, doc: { cases: unknown[]; scenarios: unknown[]; environments: unknown[]; plans: unknown[] }) => void;
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
 * 已知限制(刻意不建机制):SSE 断线重连只重放 snapshot,挂起中的确认卡会丢,
 * 后端 5 分钟超时后 AI 会收到"用户取消"。快照帧(type='snapshot')不在分支内,天然忽略。
 */
export const useSpaceEventsStore = create<SpaceEventsState>((set) => ({
  threadId: '',
  confirms: [],
  stageHistory: [],
  announce: null,
  stagedByThread: new Map(),
  stagedSelection: new Map(),
  ingest: (e) => {
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
    if (e.type === 'agent_start') {
      // 新一轮开始:清掉上一轮的 announce 进度(舞台历史保留)
      set((s) => (s.announce ? { announce: null } : s));
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
    confirms: [], stageHistory: [], announce: null,
    stagedByThread: new Map(), stagedSelection: new Map(),
  }),
}));
