import type { SpaceToolsContext } from './context.js';

export type StageKind = 'case' | 'scenario' | 'environment' | 'plan' | 'group';

/** 广播舞台事件:Plan 3 前端据此高亮/滚动到被操作的对象。 */
export function emitStage(ctx: SpaceToolsContext, e: { kind: StageKind; id: string; action: string; diff?: string }): void {
  ctx.emit({ type: 'stage', kind: e.kind, id: e.id, action: e.action, ...(e.diff ? { diff: e.diff } : {}) });
}
