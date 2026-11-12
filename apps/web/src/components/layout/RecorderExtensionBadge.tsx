import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../../i18n';
import { api } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { useUIStore } from '../../stores/ui';
import { Button } from '../ui/shadcn/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';
import Icon from '../Icon';
import { deriveExtState, offersDownload, type RecorderExtState } from './recorderExtVersion';

const PING_TIMEOUT_MS = 800;
const PING_SOURCE = 'ita-web';
const PONG_SOURCE = 'ita-ext';

/** Persistent top-bar badge + popover: detects the Chrome recorder extension, downloads the zip, shows install instructions.
 *  Detection mechanism: ping/pong. The extension's content/bridge.js replies to a ping with {source:'ita-ext',type:'pong',id,version}.
 *  See apps/recorder/content/bridge.js for details.
 *  Upgrade awareness: the installed version reported by pong is compared **three-way** against the current version from
 *  /api/recorder/extension/version (see recorderExtVersion.ts): installed older → 'update' amber state + download button; installed newer → 'ahead' blue state
 *  with **no download entry** (downloading would overwrite the new version with the old one — a downgrade); equal → 'ready'.
 *  Existing users can sense a new extension without ever looking at version numbers. */
export default function RecorderExtensionBadge() {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const toast = useUIStore((s) => s.showToast);

  const [state, setState] = useState<'unknown' | 'ready' | 'stale' | 'missing'>('unknown');
  const [version, setVersion] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [probeNonce, setProbeNonce] = useState(0);
  const pendingRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  // Fetch the currently deployed version so it can be compared once the pong arrives. Triggered by the same mount as the probe; refreshed together on re-probe.
  useEffect(() => {
    if (!isAuthenticated) return;
    api.recorder
      .extensionVersion()
      .then((r) => setCurrent(r.version))
      .catch(() => setCurrent(null)); // if the fetch fails, skip comparison and keep ready so no upgrade is misreported
  }, [isAuthenticated, probeNonce]);

  const sendPing = useCallback(() => {
    if (!isAuthenticated) return;
    // Clear any still-pending old ping to avoid concurrent pings crossing ids
    if (pendingRef.current) {
      clearTimeout(pendingRef.current.timer);
      pendingRef.current = null;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      pendingRef.current = null;
      setState('missing');
      setVersion(null);
    }, PING_TIMEOUT_MS);
    pendingRef.current = { id, timer };
    window.postMessage({ source: PING_SOURCE, type: 'ping', id }, '*');
  }, [isAuthenticated]);

  // Ping on mount; re-ping when probeNonce changes (used by the "re-detect" button in the popover)
  useEffect(() => {
    if (!isAuthenticated) return;
    sendPing();
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timer);
        pendingRef.current = null;
      }
    };
  }, [sendPing, isAuthenticated, probeNonce]);

  // Persistent pong listener. Also catches late injection (content script still injecting).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.source !== PONG_SOURCE || e.data?.type !== 'pong') return;
      const pending = pendingRef.current;
      // Ignore a pong that doesn't belong to us (e.g. a delayed response to an old ping)
      if (pending && e.data.id !== pending.id) return;
      if (pending) {
        clearTimeout(pending.timer);
        pendingRef.current = null;
      }
      if (e.data.version) {
        // The installed version is the baseline state of "extension detected"; the final ready/update is derived by effectiveState's version comparison.
        setVersion(e.data.version);
        setState('ready');
      } else {
        // Pong received but version empty → the extension was just reloaded, context invalidated
        setState('stale');
        setVersion(null);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Derived state: pong has a version + the current version was fetched → compare into ready / update / ahead.
  // state only stores the probing-phase result (unknown/missing/stale); the three version-related states are computed by comparison.
  const effectiveState: RecorderExtState = useMemo(
    () => deriveExtState(state, version, current),
    [state, version, current],
  );

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const blob = await api.downloadExtensionZip();
      // Use the itest-recorder-v0.0.1.zip name from Content-Disposition; fall back to a generic name when unavailable
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'itest-recorder.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser a moment to trigger the download before reclaiming the URL
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(e instanceof Error ? localizeApiError(e) : String(e), 'error');
    } finally {
      setDownloading(false);
    }
  }, [toast]);

  if (!isAuthenticated) return null;

  const dotColor =
    effectiveState === 'ready'
      ? 'var(--success)'
      : effectiveState === 'update'
        ? 'var(--warning)'
        : effectiveState === 'ahead'
          ? 'var(--info)'
          : effectiveState === 'stale'
            ? 'var(--warning)'
            : 'var(--destructive)';
  const label =
    effectiveState === 'ready'
      ? t('mobile:recorderExt.installedVer', { version: version ?? '' })
      : effectiveState === 'update'
        ? t('mobile:recorderExt.updatableVer', { version: current ?? '' })
        : effectiveState === 'ahead'
          ? t('mobile:recorderExt.aheadVer', { version: version ?? '' })
          : effectiveState === 'stale'
            ? t('mobile:recorderExt.labelStale')
            : t('mobile:recorderExt.labelMissing');

  return (
    <>
      <Button
        variant="outline-ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={t('mobile:recorderExt.statusTitle')}
        className="h-7 gap-1.5 px-2 text-xs"
      >
        <span
          aria-hidden
          style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }}
        />
        {effectiveState === 'unknown' ? t('mobile:recorderExt.detecting') : label}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('mobile:recorderExt.statusTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4 text-xs/relaxed">
            <StatusRow state={effectiveState} version={version} current={current} onRecheck={() => setProbeNonce((n) => n + 1)} />

            {effectiveState === 'ready' ? (
              <UpdateHint />
            ) : effectiveState === 'update' ? (
              <>
                <p className="text-[11px]" style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}>
                  {t('mobile:recorderExt.updateTip')}
                </p>
                <ol className="flex flex-col gap-1 pl-4 text-xs/relaxed" style={{ listStyle: 'decimal' }}>
                  <li>{t('mobile:recorderExt.updateStep1a')}<code>itest-recorder.zip</code>{t('mobile:recorderExt.updateStep1b')}</li>
                  <li>{t('mobile:recorderExt.updateStep2a')}<code>chrome://extensions/</code>{t('mobile:recorderExt.updateStep2b')}</li>
                  <li>{t('mobile:recorderExt.loadUnpacked')}</li>
                  <li>{t('mobile:recorderExt.goGreenVer', { version: current ?? '' })}</li>
                </ol>
              </>
            ) : effectiveState === 'ahead' ? (
              <p className="text-[11px]" style={{ background: 'var(--info-soft)', color: 'var(--info)' }}>
                {t('mobile:recorderExt.aheadTip')}
              </p>
            ) : (
              <>
                <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                  {t('mobile:recorderExt.installTip')}
                </p>
                <ol className="flex flex-col gap-1 pl-4 text-xs/relaxed" style={{ listStyle: 'decimal' }}>
                  <li>{t('mobile:recorderExt.installStep1a')}<code>itest-recorder.zip</code>{t('mobile:recorderExt.installStep1b')}</li>
                  <li>
                    {t('mobile:recorderExt.installStep2a')}<code>chrome://extensions/</code>{t('mobile:recorderExt.installStep2b')}
                  </li>
                  <li>{t('mobile:recorderExt.installStep3')}</li>
                  <li>{t('mobile:recorderExt.loadUnpacked')}</li>
                  <li>{t('mobile:recorderExt.goGreen')}</li>
                </ol>
                <p className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                  {t('mobile:recorderExt.installHint')}
                </p>
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProbeNonce((n) => n + 1)}
                disabled={effectiveState === 'unknown'}
              >
                <Icon name="refresh" size={12} />
                {t('mobile:recorderExt.recheck')}
              </Button>
              {offersDownload(effectiveState) && (
                <Button size="sm" onClick={handleDownload} disabled={downloading}>
                  <Icon name="download" size={12} />
                  {downloading ? t('mobile:recorderExt.packing') : t('mobile:recorderExt.downloadZip')}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StatusRow({
  state,
  version,
  current,
  onRecheck,
}: {
  state: RecorderExtState;
  version: string | null;
  current: string | null;
  onRecheck: () => void;
}) {
  const { t } = useTranslation();
  if (state === 'ready') {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        style={{ background: 'var(--success-soft)', color: 'var(--success)' }}
      >
        <Icon name="check" size={14} />
        <span className="font-medium">{t('mobile:recorderExt.statusReady')}</span>
        {version && <span className="text-[11px]">v{version}</span>}
      </div>
    );
  }
  if (state === 'update') {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
      >
        <Icon name="download" size={14} />
        <span className="font-medium">{t('mobile:recorderExt.statusUpdate')}</span>
        <span className="text-[11px]">{t('mobile:recorderExt.statusVersions', { installed: version ?? '?', latest: current ?? '?' })}</span>
        <button
          type="button"
          className="ml-auto text-[11px] underline"
          onClick={onRecheck}
        >
          {t('mobile:recorderExt.recheck')}
        </button>
      </div>
    );
  }
  if (state === 'ahead') {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        style={{ background: 'var(--info-soft)', color: 'var(--info)' }}
      >
        <Icon name="information" size={14} />
        <span className="font-medium">{t('mobile:recorderExt.statusAhead')}</span>
        <span className="text-[11px]">{t('mobile:recorderExt.statusAheadVersions', { installed: version ?? '?', latest: current ?? '?' })}</span>
        <button
          type="button"
          className="ml-auto text-[11px] underline"
          onClick={onRecheck}
        >
          {t('mobile:recorderExt.recheck')}
        </button>
      </div>
    );
  }
  if (state === 'stale') {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        style={{ background: 'var(--warning-soft)', color: 'var(--warning)' }}
      >
        <Icon name="warning" size={14} />
        <span className="font-medium">{t('mobile:recorderExt.statusStale')}</span>
        <button
          type="button"
          className="ml-auto text-[11px] underline"
          onClick={onRecheck}
        >
          {t('mobile:recorderExt.recheck')}
        </button>
      </div>
    );
  }
  if (state === 'missing') {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        style={{ background: 'var(--destructive-soft)', color: 'var(--destructive)' }}
      >
        <Icon name="plug" size={14} />
        <span className="font-medium">{t('mobile:recorderExt.statusMissing')}</span>
        <button
          type="button"
          className="ml-auto text-[11px] underline"
          onClick={onRecheck}
        >
          {t('mobile:recorderExt.recheck')}
        </button>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1.5"
      style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
    >
      <Icon name="loader" size={14} />
      <span className="font-medium">{t('mobile:recorderExt.detecting')}</span>
    </div>
  );
}

function UpdateHint() {
  const { t } = useTranslation();
  return (
    <div className="text-[11px] flex flex-col gap-1" style={{ color: 'var(--muted-foreground)' }}>
      <p>
        {t('mobile:recorderExt.currentOk1a')}<code>chrome://extensions/</code>{t('mobile:recorderExt.currentOk1b')}
      </p>
      <p>
        {t('mobile:recorderExt.currentOk2a')}<code>中台地址/api/recorder/extension.zip</code>{t('mobile:recorderExt.currentOk2b')}
      </p>
    </div>
  );
}
