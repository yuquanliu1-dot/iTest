import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type OrgProjectSummary } from '../../api/client';
import Badge from './Badge';

interface Props {
  orgId: string;
  includeSubtree: boolean;
  q: string;
  page: number;
  pageSize: number;
  onTotal: (n: number) => void;
  onOpen: (projectId: string) => void;
}

export default function ProjectListTab({ orgId, includeSubtree, q, page, pageSize, onTotal, onOpen }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<OrgProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    api.orgs.projects(orgId, { q, includeSubtree, page, limit: pageSize })
      .then((res) => {
        if (stale) return;
        setItems(res.items);
        onTotal(res.total);
      })
      .catch(() => { if (!stale) { setItems([]); onTotal(0); } })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [orgId, includeSubtree, q, page, pageSize, onTotal]);

  if (loading && items.length === 0) {
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted-foreground)', fontSize: 13 }}>{t('common:loading')}</div>;
  }
  if (items.length === 0) {
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted-foreground)', fontSize: 13 }}>{t('members:noProjects')}</div>;
  }
  return (
    <>
      {items.map((p) => (
        <div
          key={p.id}
          onClick={() => onOpen(p.id)}
          className="flex items-center gap-2 rounded"
          style={{ minHeight: 56, padding: '8px 10px', cursor: 'pointer', fontSize: 13, color: 'var(--foreground)' }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="truncate">{p.name}</div>
            {p.description && (
              <div className="truncate" style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{p.description}</div>
            )}
          </div>
          <Badge label={t('members:assignedCount', { count: p.assignedCount })} />
        </div>
      ))}
    </>
  );
}
