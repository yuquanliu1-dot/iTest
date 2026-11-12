import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type OrgProductLineSummary } from '../../api/client';
import Badge from './Badge';

interface Props {
  orgId: string;
  includeSubtree: boolean;
  q: string;
  page: number;
  pageSize: number;
  /** Increment to trigger a re-fetch (used after creating a product line). */
  reloadToken: number;
  onTotal: (n: number) => void;
  onOpen: (productLineId: string) => void;
}

/**
 * Product lines under an organization. In the member management UI product lines have fully replaced projects — projects no longer attach
 * directly to organizations; ownership is decided by the product line, so the org view shows "which product lines exist under this organization".
 */
export default function ProductLineListTab({ orgId, includeSubtree, q, page, pageSize, reloadToken, onTotal, onOpen }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<OrgProductLineSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    api.orgs.productLines(orgId, { q, includeSubtree, page, limit: pageSize })
      .then((res) => {
        if (stale) return;
        setItems(res.items);
        onTotal(res.total);
      })
      .catch(() => { if (!stale) { setItems([]); onTotal(0); } })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [orgId, includeSubtree, q, page, pageSize, reloadToken, onTotal]);

  if (loading && items.length === 0) {
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted-foreground)', fontSize: 13 }}>{t('common:loading')}</div>;
  }
  if (items.length === 0) {
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted-foreground)', fontSize: 13 }}>{t('members:noProductLines')}</div>;
  }
  return (
    <>
      {items.map((l) => (
        <div
          key={l.id}
          onClick={() => onOpen(l.id)}
          className="flex items-center gap-2 rounded"
          style={{ minHeight: 56, padding: '8px 10px', cursor: 'pointer', fontSize: 13, color: 'var(--foreground)' }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="truncate">{l.name}</div>
            {l.description && (
              <div className="truncate" style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>{l.description}</div>
            )}
          </div>
          <Badge label={t('members:lineProjectCount', { count: l.projectCount })} />
        </div>
      ))}
    </>
  );
}
