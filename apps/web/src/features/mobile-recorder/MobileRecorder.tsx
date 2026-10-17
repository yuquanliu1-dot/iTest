import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  /** 当前用户在 ProjectsHome 已选 projectId（用于 deviceTargets.list）。Caller 负责从 store 取。 */
  projectId: string;
  onClose: () => void;
}

/** 移动端录制 UI（占位实现）：
 *  - 顶部 toolbar：设备目标下拉 + 启动/完成/关闭按钮
 *  - 中央：iframe 嵌入 viewerUrl（占位文本，目前 viewerUrl 由后端接口提供）
 *  - 右侧：accessibility tree 列表（占位 mock 数据；真实 snapshot 由后端 WS 推送）
 *  - 点选节点 → 把 step push 到 onRecordedSteps，调用方收到后写入 case.steps
 *
 * 后端 REST/WS 协议在 commit 落地后由 device-targets service 层对接；
 * 此组件只负责「呈现 + 事件流」，不直连协议。 */
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

  // 启动 mobile recording 会话（占位实现：用 fetch 直连后端，后续与 ws 协议合并）
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
      // 占位 mock tree — 真实 snapshot 由后端 WS 推送
      setTree([
        { accessibilityId: 'login_button', label: '登录', role: 'Button', bounds: { x: 100, y: 200, width: 200, height: 48 } },
        { accessibilityId: 'username_field', label: '用户名', role: 'TextField', bounds: { x: 50, y: 100, width: 300, height: 40 } },
      ]);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
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
      toast(e instanceof Error ? e.message : String(e), 'error');
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

  /** 把已记录的步骤批量追加到用例（走 replaceSteps 是与既有 UI 入口对齐的统一方式）。 */
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
      toast(e instanceof Error ? e.message : String(e), 'error');
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
