/** 录制扩展徽标的版本比较与状态推导。 */

/** 徽标的五种状态。'ahead' = 已装版本比部署版本还新。 */
export type RecorderExtState = 'unknown' | 'ready' | 'update' | 'ahead' | 'stale' | 'missing';

/** 简单 semver 比较：0.0.1 < 0.0.2。manifest version 恒为 x.y.z，够用。
 *  返回负数表示 a < b，正数表示 a > b，0 表示相等。 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 已装版本 vs 部署版本 → 徽标状态。
 *
 *  三方比较，不是一维的「旧于/不旧于」：
 *   - installed < current → 'update'：装的旧了，提示可升级
 *   - installed > current → 'ahead'：装的比服务器还新（典型：本地开发装的是未发版的
 *     版本号）。此时**不能**给下载入口——下载会把新版本覆盖成旧版本，是降级。
 *   - 相等 → 'ready'
 *
 *  'ahead' 这态是必需的：单向比较（只判 installed < current）会把「装的更新」
 *  误报成绿色 ready，用户以为已是最新，实际服务器那边还停在旧版。
 *
 *  probe 是探测阶段的结果（unknown/missing/stale），不参与版本比较——
 *  没探测到扩展时没什么版本可比。
 */
export function deriveExtState(
  probe: 'unknown' | 'ready' | 'stale' | 'missing',
  installed: string | null,
  current: string | null,
): RecorderExtState {
  if (probe === 'missing' || probe === 'stale' || probe === 'unknown') return probe;
  if (!installed || !current) return 'ready'; // 拿不到版本时不误报升级
  const cmp = compareVersion(installed, current);
  if (cmp < 0) return 'update';
  if (cmp > 0) return 'ahead';
  return 'ready';
}

/** 该状态下是否应提供「下载扩展 zip」入口。
 *  'ahead' 返回 false——下载的是部署版本，比已装的旧，覆盖即降级。
 *  其余非 ready 态（update/stale/missing/unknown）保持既有行为，都给下载入口。 */
export function offersDownload(state: RecorderExtState): boolean {
  return state !== 'ready' && state !== 'ahead';
}
