import type { SpaceToolsContext } from './context.js';

export type StageKind = 'case' | 'case_op' | 'scenario' | 'environment' | 'plan' | 'dataset' | 'group' | 'device';

type StagedPayload<T> = T & { stagedAt: string };

interface StageEvent {
  kind: StageKind;
  id: string;
  action: string;
  diff?: string;
  payload?: unknown;
}

/** Broadcasts stage events: the Plan 3 frontend uses these to highlight/scroll to the operated object.
 *  The action='stage' emitted by stage_* tools and the action='remove' after save share this one channel.
 *  action='stage' always carries a payload (a single StageDoc object); the frontend ingest upserts it directly into stagedByThread,
 *  removing the lag of staged objects only appearing after mount. */
export function emitStage(ctx: SpaceToolsContext, e: StageEvent): void {
  if (e.action === 'stage' && e.payload) {
    ctx.emit({ type: 'stage', kind: e.kind, id: e.id, action: 'stage', payload: e.payload });
    return;
  }
  ctx.emit({ type: 'stage', kind: e.kind, id: e.id, action: e.action, ...(e.diff ? { diff: e.diff } : {}) });
}
