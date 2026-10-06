import type { SpaceToolsContext } from './context.js';

export type StageKind = 'case' | 'case_op' | 'scenario' | 'environment' | 'plan' | 'group';

type StagedPayload<T> = T & { stagedAt: string };

interface StageEvent {
  kind: StageKind;
  id: string;
  action: string;
  diff?: string;
  payload?: unknown;
}

/** 广播舞台事件:Plan 3 前端据此高亮/滚动到被操作的对象。
 *  stage_* 工具发出的 action='stage' / save 后的 action='remove' 共用同一通道。
 *  action='stage' 必带 payload(StageDoc 单条对象),前端 ingest 直接 upsert 到 stagedByThread,
 *  免去 mount 后才看得到暂存对象的滞后。 */
export function emitStage(ctx: SpaceToolsContext, e: StageEvent): void {
  if (e.action === 'stage' && e.payload) {
    ctx.emit({ type: 'stage', kind: e.kind, id: e.id, action: 'stage', payload: e.payload });
    return;
  }
  ctx.emit({ type: 'stage', kind: e.kind, id: e.id, action: e.action, ...(e.diff ? { diff: e.diff } : {}) });
}
