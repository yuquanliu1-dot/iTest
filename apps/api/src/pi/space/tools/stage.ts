import type { SpaceToolsContext } from './context.js';

export type StageKind = 'case' | 'scenario' | 'environment' | 'plan' | 'group';

/** 广播舞台事件:Plan 3 前端据此高亮/滚动到被操作的对象。
 *  stage_* 工具发出的 action='stage' / save 后的 action='remove' 共用同一通道。 */
export function emitStage(ctx: SpaceToolsContext, e: { kind: StageKind; id: string; action: string; diff?: string }): void {
  ctx.emit({ type: 'stage', kind: e.kind, id: e.id, action: e.action, ...(e.diff ? { diff: e.diff } : {}) });
}
