import { estimateMaxLen, type CompositeValue } from '@itest/shared';

/** Estimates the worst-case length of a CompositeValue, for the frontend builder's live hint. */
export function estimateCompositeMaxLen(c: CompositeValue): number {
  return estimateMaxLen(c);
}
