import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type OrgMemberRow } from '../../api/client';
import Badge from './Badge';

interface Props {
  orgId: string;
  includeSubtree: boolean;
  q: string;
  page: number;
  pageSize: number;
  reloadToken?: number;
  onTotal: (n: number) => void;
  onOpen: (userId: string) => void;
}

export default function MemberListTab({ orgId, includeSubtree, q, page, pageSize, reloadToken, onTotal, onOpen }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<OrgMemberRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    api.orgs.members(orgId, { q, includeSubtree, page, limit: pageSize })
      .then((res) => {
        if (stale) return;
        setItems(res.items);
        onTotal(res.total);
      })
      .catch(() => { if (!stale) { setItems([]); onTotal(0); } })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [orgId, includeSubtree, q, page, pageSize, onTotal, reloadToken]);

  if (loading && items.length === 0) {
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted-foreground)', fontSize: 13 }}>{t('common:loading')}</div>;
  }
  if (items.length === 0) {
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted-foreground)', fontSize: 13 }}>{t('members:noMembers')}</div>;
  }
  return (
    <>
      {items.map((m) => (
        <div
          key={m.id}
          onClick={() => onOpen(m.userId)}
          className="flex items-center gap-2 rounded"
          style={{ minHeight: 56, padding: '8px 10px', cursor: 'pointer', fontSize: 13, color: 'var(--foreground)' }}
        >
          <span className="truncate" style={{ flex: 1 }}>
            {m.displayName}{' '}
            <span style={{ color: 'var(--muted-foreground)' }}>@{m.username}</span>
          </span>
          {includeSubtree && m.organizationName && <Badge label={m.organizationName} />}
          {m.isManager && <Badge label={t('members:roleManager')} accent />}
          {m.isUser && <Badge label={t('members:roleUserShort')} />}
        </div>
      ))}
    </>
  );
}
