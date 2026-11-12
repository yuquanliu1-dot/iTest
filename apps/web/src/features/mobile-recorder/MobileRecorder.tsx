import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../../i18n';
import { useQuery } from '@tanstack/react-query';
import { api, type DeviceTarget } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import { type StepClip } from '../../stores/stepClipboard';
import Button from '../../components/ui/Button';
import Icon from '../../components/Icon';

interface AccessibilityNode {
  accessibilityId?: string;
  label?: string;
  role?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  text?: string;
}

export interface MobileRecorderProps {
  caseId: string;
  defaultTargetId?: string;
  /** The projectId currently selected by the user in ProjectsHome (used for deviceTargets.list). The caller fetches it from the store. */
  projectId: string;
  onClose: () => void;
}

/** Mobile recording UI (placeholder implementation):
 *  - Top toolbar: device target dropdown + start/finish/close buttons
 *  - Center: iframe embedding viewerUrl (placeholder text; viewerUrl is currently provided by the backend API)
 *  - Right: accessibility tree list (placeholder mock data; the real snapshot is pushed by the backend over WS)
 *  - Tapping a node → pushes a step to onRecordedSteps; the caller writes it into case.steps
 *
 * The backend REST/WS protocol will be wired through the device-targets service layer once that commit lands;
 * this component only handles "presentation + event flow" and doesn't talk to the protocol directly. */
export default function MobileRecorder({ caseId, defaultTargetId, projectId, onClose }: MobileRecorderProps) {
  const toast = useUIStore((s) => s.showToast);
  const { t } = useTranslation();
  const [targetId, setTargetId] = useState<string | undefined>(defaultTargetId);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [tree, setTree] = useState<AccessibilityNode[]>([]);
  const [recordedSteps, setRecordedSteps] = useState<StepClip[]>([]);

  const { data: targets } = useQuery({
    queryKey: ['deviceTargets', projectId],
    queryFn: () => api.deviceTargets.list(projectId),
    enabled: !!projectId,
  });

  // Start a mobile recording session (placeholder: fetch directly to the backend; will merge with the ws protocol later)
  const start = async () => {
    if (!targetId) { toast(t('mobile:pleaseSelectTarget'), 'error'); return; }
    try {
      const r = await fetch('/api/recorder/mobile-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseId, deviceTargetId: targetId }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: t('mobile:startFailed') }));
        throw new Error(err.message ?? t('mobile:startFailed'));
      }
      const data = await r.json() as { sessionId: string; viewerUrl: string; wsToken: string };
      setSessionId(data.sessionId);
      setViewerUrl(data.viewerUrl);
      // Placeholder mock tree — the real snapshot is pushed by the backend over WS
      setTree([
        { accessibilityId: 'login_button', label: '登录', role: 'Button', bounds: { x: 100, y: 200, width: 200, height: 48 } },
        { accessibilityId: 'username_field', label: '用户名', role: 'TextField', bounds: { x: 50, y: 100, width: 300, height: 40 } },
      ]);
    } catch (e) {
      toast(e instanceof Error ? localizeApiError(e) : String(e), 'error');
    }
  };

  const finish = async () => {
    if (!sessionId) return;
    try {
      const r = await fetch(`/api/recorder/mobile-sessions/${sessionId}/finish`, { method: 'POST' });
      if (!r.ok) throw new Error('finish failed');
      const data = await r.json() as { inserted: number };
      toast(t('mobile:wroteSteps', { count: data.inserted }), 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? localizeApiError(e) : String(e), 'error');
    }
  };

  const tapNode = (n: AccessibilityNode) => {
    if (!sessionId) { toast(t('mobile:startSessionFirst'), 'error'); return; }
    if (!n.accessibilityId && !n.label) return;
    const compiled = [{
      kind: 'tap',
      locator: [
        ...(n.accessibilityId ? [{ strategy: 'accessibilityId', value: n.accessibilityId }] : []),
        ...(n.label ? [{ strategy: 'label', value: n.label }] : []),
      ],
    }];
    const step: StepClip = {
      action: compiled[0],
      source: 'mobile-recorder',
      instruction: n.label ?? n.accessibilityId ?? '',
      compiled,
    };
    setRecordedSteps((prev) => [...prev, step]);
  };

  /** Append the recorded steps to the case in batch (replaceSteps is the unified way, aligned with the existing UI entry point). */
  const flushToCase = async () => {
    if (recordedSteps.length === 0) { toast(t('mobile:noStepsRecorded'), 'info'); return; }
    try {
      const current = await api.cases.get(caseId);
      const next = [
        ...current.steps.map((s) => ({
          action: (Array.isArray(s.compiled) && s.compiled[0]) || {},
          source: s.source,
          delayMs: s.delayMs ?? undefined,
          instruction: s.instruction ?? undefined,
          compiled: s.compiled ?? undefined,
        })),
        ...recordedSteps.map((s) => ({
          action: s.action,
          source: s.source,
          delayMs: s.delayMs ?? undefined,
          instruction: s.instruction ?? undefined,
          compiled: s.compiled ?? undefined,
        })),
      ];
      await api.cases.replaceSteps(caseId, next);
      toast(t('mobile:wroteSteps', { count: recordedSteps.length }), 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? localizeApiError(e) : String(e), 'error');
    }
  };

  useEffect(() => {
    return () => { /* cleanup WS on unmount */ };
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Icon name="tablet" size={14} />
        <span className="text-[13px] font-medium">{t('mobile:title')}</span>
        <select
          className="input-base input-sm"
          value={targetId ?? ''}
          onChange={(e) => setTargetId(e.target.value || undefined)}
        >
          <option value="">{t('mobile:selectTarget')}</option>
          {(targets ?? []).map((target: DeviceTarget) => (
            <option key={target.id} value={target.id}>{target.name} ({target.mobileOs})</option>
          ))}
        </select>
        <Button size="sm" onClick={start} disabled={!targetId || !!sessionId}>
          <Icon name="play" size={12} />
          {t('mobile:start')}
        </Button>
        <Button size="sm" onClick={finish} disabled={!sessionId}>
          <Icon name="check" size={12} />
          {t('mobile:finish')}
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose}>{t('common:close')}</Button>
      </div>
      <div className="flex-1 grid grid-cols-2 gap-3 p-3 min-h-0">
        <div className="border rounded-[var(--radius-md)] overflow-hidden bg-[#000]">
          {viewerUrl ? (
            <iframe src={viewerUrl} className="w-full h-full" title="device preview" />
          ) : (
            <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('mobile:previewHint')}
            </div>
          )}
        </div>
        <div className="border rounded-[var(--radius-md)] overflow-y-auto p-2 text-[11px] font-mono">
          <div className="text-[11px] mb-2 font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
            Accessibility Tree
          </div>
          {tree.length === 0 ? (
            <div style={{ color: 'var(--muted-foreground)' }}>{t('mobile:noNodes')}</div>
          ) : (
            tree.map((n, i) => (
              <button
                key={i}
                type="button"
                className="block w-full text-left px-2 py-1 hover:bg-[var(--muted)]"
                onClick={() => tapNode(n)}
              >
                <span style={{ color: 'var(--primary)' }}>{n.role ?? '?'}</span>{' '}
                {n.accessibilityId && <span style={{ color: 'var(--info)' }}>#{n.accessibilityId}</span>}{' '}
                {n.label && <span>{n.label}</span>}
                {n.bounds && (
                  <span style={{ color: 'var(--muted-foreground)' }}>
                    {' '}({Math.round(n.bounds.x)},{Math.round(n.bounds.y)})
                  </span>
                )}
              </button>
            ))
          )}
          {recordedSteps.length > 0 && (
            <div className="mt-3 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="text-[11px] mb-1 font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                {t('mobile:recordedCount', { count: recordedSteps.length })}
              </div>
              <Button size="sm" onClick={flushToCase}>
                <Icon name="save" size={12} />
                {t('mobile:writeToCase')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
