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

interface SpaceEventsState {
  confirms: SpaceConfirmRequest[];
  stageHistory: StageObject[];
  announce: AnnounceState | null;
  /** Pi client 订阅分流入口:只认空间自定义事件,pi 契约事件忽略。 */
  ingest: (e: Record<string, unknown>) => void;
  removeConfirm: (confirmId: string) => void;
  reset: () => void;
}

const MAX_STAGE_HISTORY = 50;
let stageSeq = 0;

/**
 * 已知限制(刻意不建机制):SSE 断线重连只重放 snapshot,挂起中的确认卡会丢,
 * 后端 5 分钟超时后 AI 会收到"用户取消"。快照帧(type='snapshot')不在分支内,天然忽略。
 */
export const useSpaceEventsStore = create<SpaceEventsState>((set) => ({
  confirms: [],
  stageHistory: [],
  announce: null,
  ingest: (e) => {
    if (e.type === 'confirm_request') {
      const c = e as unknown as SpaceConfirmRequest;
      set((s) => (s.confirms.some((x) => x.confirmId === c.confirmId) ? s : { confirms: [...s.confirms, c] }));
      return;
    }
    if (e.type === 'stage') {
      const obj: StageObject = {
        key: `s${++stageSeq}`,
        kind: e.kind as StageKind,
        id: e.id as string,
        action: e.action as string,
        ...(typeof e.diff === 'string' ? { diff: e.diff } : {}),
      };
      set((s) => ({
        stageHistory: [...s.stageHistory, obj].slice(-MAX_STAGE_HISTORY),
        // announce 后的 stage 事件驱动进度;无 announce 时静默累计不展示
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
  reset: () => set({ confirms: [], stageHistory: [], announce: null }),
}));
