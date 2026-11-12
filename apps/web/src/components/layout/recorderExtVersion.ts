/** Version comparison and state derivation for the recorder extension badge. */

/** The five badge states. 'ahead' = the installed version is newer than the deployed one. */
export type RecorderExtState = 'unknown' | 'ready' | 'update' | 'ahead' | 'stale' | 'missing';

/** Simple semver comparison: 0.0.1 < 0.0.2. The manifest version is always x.y.z, so this suffices.
 *  Returns a negative number for a < b, positive for a > b, 0 for equal. */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Installed version vs deployed version → badge state.
 *
 *  Three-way comparison, not the one-dimensional "older or not":
 *   - installed < current → 'update': installed is older, prompt an upgrade
 *   - installed > current → 'ahead': installed is newer than the server (typical: local dev has an
 *     unreleased version number). In that case **no** download entry — downloading would overwrite
 *     the new version with the old one, which is a downgrade.
 *   - equal → 'ready'
 *
 *  The 'ahead' state is required: one-way comparison (only checking installed < current) would misreport
 *  "installed is newer" as a green ready, making users think they are up to date while the server is still on the old version.
 *
 *  probe is the probing-phase result (unknown/missing/stale) and takes no part in version comparison —
 *  when the extension wasn't detected there is no version to compare.
 */
export function deriveExtState(
  probe: 'unknown' | 'ready' | 'stale' | 'missing',
  installed: string | null,
  current: string | null,
): RecorderExtState {
  if (probe === 'missing' || probe === 'stale' || probe === 'unknown') return probe;
  if (!installed || !current) return 'ready'; // don't misreport an upgrade when versions are unavailable
  const cmp = compareVersion(installed, current);
  if (cmp < 0) return 'update';
  if (cmp > 0) return 'ahead';
  return 'ready';
}

/** Whether this state should offer the "download extension zip" entry.
 *  'ahead' returns false — the download is the deployed version, older than installed; overwriting is a downgrade.
 *  The other non-ready states (update/stale/missing/unknown) keep existing behavior and all offer the download entry. */
export function offersDownload(state: RecorderExtState): boolean {
  return state !== 'ready' && state !== 'ahead';
}
