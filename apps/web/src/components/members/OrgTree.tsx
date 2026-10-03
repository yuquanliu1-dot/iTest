import { useState, useEffect } from 'react';
import { orgTreeApi } from '../../api/orgTree';

export interface OrgTreeNode {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  memberCount?: number;
  projectCount?: number;
}

interface Props {
  selectedOrgId: string | null;
  onSelect: (org: OrgTreeNode) => void;
  canManage: boolean;
  onCreate: (parentId: string | null) => void;
  /** 外部触发刷新（建/删组织后）。 */
  reloadToken?: number;
}

export default function OrgTree({ selectedOrgId, onSelect, canManage, onCreate, reloadToken }: Props) {
  const [nodes, setNodes] = useState<OrgTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    orgTreeApi
      .list(canManage, reloadToken, attempt)
      .then((list) => {
        if (cancelled) return;
        setNodes(list);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setNodes([]);
        setFailed(true);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage, reloadToken, attempt]);

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center justify-between" style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-glass-border)' }}>
        <h2 className="text-[14px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
          组织
        </h2>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 6px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--color-foreground-disabled)', fontSize: 13 }}>
            加载中…
          </div>
        ) : failed ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--color-destructive)', fontSize: 13 }}>
            <div>加载失败</div>
            <button
              onClick={() => setAttempt((a) => a + 1)}
              className="rounded text-[12px]"
              style={{ marginTop: 8, padding: '4px 12px', border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer' }}
            >
              重试
            </button>
          </div>
        ) : nodes.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--color-foreground-disabled)', fontSize: 13 }}>
            暂无组织
          </div>
        ) : (
          nodes.map((n) => {
            const depth = n.path.split('/').filter(Boolean).length;
            const selected = n.id === selectedOrgId;
            return (
              <div
                key={n.id}
                onClick={() => onSelect(n)}
                className="flex items-center gap-1.5 rounded"
                style={{
                  padding: '5px 8px',
                  marginLeft: Math.max(0, depth - 1) * 16,
                  cursor: 'pointer',
                  background: selected ? 'var(--color-accent-light)' : 'transparent',
                  color: selected ? 'var(--color-accent)' : 'var(--color-foreground)',
                  fontSize: 13,
                }}
              >
                <span className="truncate" style={{ flex: 1 }}>{n.name}</span>
                {n.memberCount !== undefined && (
                  <span style={{ fontSize: 11, color: 'var(--color-foreground-disabled)' }}>
                    {n.memberCount}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {canManage && (
        <div className="shrink-0" style={{ borderTop: '1px solid var(--color-glass-border)', padding: 8 }}>
          <button
            onClick={() => onCreate(null)}
            className="w-full rounded text-[12px]"
            style={{ padding: '6px 0', border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-accent)', cursor: 'pointer' }}
          >
            + 新建组织
          </button>
        </div>
      )}
    </div>
  );
}
