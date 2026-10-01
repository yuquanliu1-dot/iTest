/** Workspace bus: per-requirement fan-out for workspace_doc SSE events. */

export interface WorkspaceEvent {
  type: 'workspace_doc';
  requirementId: string;
}

type Listener = (e: WorkspaceEvent) => void;

const subs = new Map<string, Set<Listener>>();

export function subscribeWorkspace(requirementId: string, fn: Listener): () => void {
  let set = subs.get(requirementId);
  if (!set) {
    set = new Set();
    subs.set(requirementId, set);
  }
  set.add(fn);
  return () => {
    const cur = subs.get(requirementId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) subs.delete(requirementId);
  };
}

export function publishWorkspaceEvent(e: WorkspaceEvent): void {
  const set = subs.get(e.requirementId);
  if (!set) return;
  for (const fn of set) {
    try { fn(e); } catch { /* listener errors do not break the publisher */ }
  }
}

export function subscriberCountForTesting(requirementId: string): number {
  return subs.get(requirementId)?.size ?? 0;
}