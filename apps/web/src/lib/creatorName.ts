import type { Creator } from '../api/client';

/** 创建人/执行人公共渲染名：displayName 优先，否则 username；均缺失（存量/用户已删）显示 —。 */
export function creatorName(c?: Creator | null): string {
  return c?.displayName?.trim() ? c.displayName : c?.username ?? '—';
}