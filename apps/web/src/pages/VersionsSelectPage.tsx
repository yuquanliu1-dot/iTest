import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type ProjectVersion } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';

/** 选版本中间页。路径 /p/:projectId/versions/select
 *  列表展示项目所有版本卡；点击即进入 /v/:versionId/overview。
 *  store 里的 versionId/versionName 在此处落定，之后 ProjectGuard 直接放行。 */
export default function VersionsSelectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const enter = useProjectStore((s) => s.enter);
  const switchVersion = useProjectStore((s) => s.switchVersion);
  const current = useProjectStore((s) => s.current);
  const toast = useUIStore((s) => s.showToast);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId!),
    enabled: !!projectId,
  });

  useEffect(() => {
    if (!projectId) return;
    if (!current || current.id !== projectId) {
      // 非法深链：清掉 store，回首页
      navigate('/', { replace: true });
    }
  }, [projectId, current, navigate]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>加载中...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--color-foreground-muted)', fontSize: 13 }}>
        加载失败：{(error as Error)?.message ?? '未知错误'}
      </div>
    );
  }

  const versions: ProjectVersion[] = data ?? [];

  const pick = (v: ProjectVersion) => {
    if (!projectId) return;
    switchVersion(v.id, v.name);
    // 兼容老 URL：直接进版本化的二级路径 /v/:vid/overview
    navigate(`/p/${projectId}/v/${v.id}/overview`);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-5 pb-2">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
            选择版本
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
            {current?.name ?? ''} · {versions.length} 个版本
          </p>
        </div>
        <Button variant="ghost" onClick={() => navigate(`/p/${projectId}/versions`)}>
          管理版本
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {versions.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'var(--color-foreground-muted)' }}>
            暂无版本
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {versions.map((v) => (
              <button
                key={v.id}
                onClick={() => pick(v)}
                className="glass-panel press text-left"
                style={{
                  padding: '14px 16px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-surface-elevated)',
                  border: '1px solid var(--color-glass-panel-border)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div className="flex items-center gap-2">
                  <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-foreground)' }}>
                    {v.name}
                  </span>
                  {v.isDefault && (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        padding: '2px 6px',
                        borderRadius: 999,
                        background: 'var(--color-accent-soft)',
                        color: 'var(--color-accent)',
                      }}
                    >
                      默认
                    </span>
                  )}
                </div>
                {v.description && (
                  <div className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
                    {v.description}
                  </div>
                )}
                <div className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                  用例 {v.caseCount ?? 0} · 环境 {v.environmentCount ?? 0} · 计划 {v.planCount ?? 0}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}