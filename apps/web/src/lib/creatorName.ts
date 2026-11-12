import type { Creator } from '../api/client';

/** Common display name for creator/executor: displayName first, else username; when both missing (legacy/deleted user) show —. */
export function creatorName(c?: Creator | null): string {
  return c?.displayName?.trim() ? c.displayName : c?.username ?? '—';
}