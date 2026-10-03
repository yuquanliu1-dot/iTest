import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type ProjectVersion } from '../../api/client';
import { useProjectStore } from '../../stores/project';
import Icon from '../Icon';

/** 版本切换 chip：在侧边栏顶部展示「当前 v1.0 ▾」，点开下拉切换或进管理。
 *  切换即写 store + 跳到 /v/:newVid/overview，确保 URL 与状态一致。 */
export default function VersionChip() {
  const { projectId, versionId: urlVid } = useParams<{ projectId: string; versionId?: string }>();
  const navigate = useNavigate();
  const switchVersion = useProjectStore((s) => s.switchVersion);
  const current = useProjectStore((s) => s.current);
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId!),
    enabled: !!projectId && !!current,
  });

  const versions: ProjectVersion[] = data ?? [];
  const currentVid = urlVid ?? current?.versionId ?? null;
  const currentVersion = versions.find((v) => v.id === currentVid) ?? null;
  const displayName = currentVersion?.name ?? current?.versionName ?? '选版本';

  // 关闭菜单：点外面 / Esc
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-version-chip-root]')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // store 的 versionId 与 URL 不一致：把 URL 当真，store 自动同步（避免 URL 是 source of truth）
  useEffect(() => {
    if (urlVid && current && current.versionId !== urlVid) {
      const v = versions.find((x) => x.id === urlVid);
      switchVersion(urlVid, v?.name ?? current.versionName ?? '');
    }
  }, [urlVid, current, versions, switchVersion]);

  if (!current || !projectId) return null;
  if (versions.length === 0) return null;

  const pick = (v: ProjectVersion) => {
    switchVersion(v.id, v.name);
    setOpen(false);
    navigate(`/p/${projectId}/v/${v.id}/overview`);
  };

  return (
    <div
      data-version-chip-root
      style={{
        position: 'relative',
        padding: '6px 8px',
        margin: '0 4px 6px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface-elevated)',
        border: '1px solid var(--color-glass-panel-border)',
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="press"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--color-foreground-secondary)',
          fontSize: 12,
        }}
      >
        <Icon name="tag" size={12} />
        <span style={{ flex: 1, textAlign: 'left', fontWeight: 500 }}>{displayName}</span>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={10} />
      </button>
      {open && (
        <div
          role="listbox"
          className="popover-in"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            background: 'var(--color-surface-overlay)',
            border: '1px solid var(--color-glass-panel-border)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-popover)',
            padding: 4,
            zIndex: 50,
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {versions.map((v) => (
            <button
              key={v.id}
              role="option"
              aria-selected={v.id === currentVid}
              onClick={() => pick(v)}
              className="press"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '6px 8px',
                background: v.id === currentVid ? 'var(--color-accent-light)' : 'transparent',
                color: v.id === currentVid ? 'var(--color-accent)' : 'var(--color-foreground)',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                textAlign: 'left',
              }}
            >
              <span style={{ flex: 1 }}>{v.name}</span>
              {v.isDefault && (
                <span
                  style={{
                    fontSize: 9,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    padding: '1px 5px',
                    borderRadius: 999,
                    background: 'var(--color-accent-soft)',
                    color: 'var(--color-accent)',
                  }}
                >
                  默认
                </span>
              )}
            </button>
          ))}
          <button
            onClick={() => { setOpen(false); navigate(`/p/${projectId}/versions`); }}
            className="press"
            style={{
              display: 'block',
              width: '100%',
              padding: '6px 8px',
              marginTop: 4,
              borderTop: '1px solid var(--color-border-subtle)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-foreground-muted)',
              fontSize: 11,
              textAlign: 'left',
            }}
          >
            管理版本…
          </button>
        </div>
      )}
    </div>
  );
}