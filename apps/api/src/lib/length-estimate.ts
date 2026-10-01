import { estimateMaxLen, type CompositeValue } from '@itest/shared';

/** 估算 CompositeValue 在最坏情况下的长度，供前端 builder 实时提示使用。 */
export function estimateCompositeMaxLen(c: CompositeValue): number {
  return estimateMaxLen(c);
}
