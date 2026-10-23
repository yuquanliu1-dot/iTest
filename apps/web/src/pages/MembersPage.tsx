import { useState, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/auth';
import { isEffectiveManagerOf, sortByPath } from '../utils/orgTree';
import OrgTree, { type OrgTreeNode } from '../components/members/OrgTree';
import OrgDetailPanel from '../components/members/OrgDetailPanel';
import UserDetailPanel from '../components/members/UserDetailPanel';
import ProjectDetailPanel from '../components/members/ProjectDetailPanel';
import ProductLineDetailPanel from '../components/members/ProductLineDetailPanel';
import GlobalUserSearch from '../components/members/GlobalUserSearch';
import OrgFormModal from '../components/members/OrgFormModal';

const PAGE_SIZE = 12;

export default function MembersPage() {
  const { t } = useTranslation();
  const params = useParams<{ '*': string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const organizations = useAuthStore((s) => s.organizations);
  const activeOrgId = useAuthStore((s) => s.activeOrgId);
  const canManage = isEffectiveManagerOf(
    organizations.find((o) => o.id === activeOrgId),
    organizations,
  );

  const [reloadToken, setReloadToken] = useState(0);
  const [orgForm, setOrgForm] = useState<{ org: { id: string; name: string; description?: string; parentId: string | null } | null; parentId: string | null } | null>(null);

  const orgId = searchParams.get('org');
  const tab = (searchParams.get('tab') === 'lines' ? 'lines' : 'users') as 'users' | 'lines';
  const includeSubtree = searchParams.get('subtree') !== '0';
  const q = searchParams.get('q') ?? '';
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1') || 1);

  const segments = (params['*'] ?? '').split('/').filter(Boolean);
  const detailKind =
    segments[0] === 'user' || segments[0] === 'project' || segments[0] === 'productline'
      ? segments[0]
      : null;
  const detailId = detailKind ? segments[1] ?? null : null;

  const patchParams = useCallback((patch: Record<string, string | null>, replace = true) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k); else next.set(k, v);
      }
      return next;
    }, { replace });
  }, [setSearchParams]);

  const handleSelectOrg = useCallback((org: OrgTreeNode) => {
    // 必须走 navigate 而不是只改 searchParams：详情页（/members/:kind/:id）会一直占着路径，
    // 而渲染分支里 detailKind 优先于 orgId——只改 query 的话点了左树没反应，右边仍停在详情页。
    const next = new URLSearchParams();
    next.set('org', org.id);
    next.set('tab', 'users');
    if (includeSubtree) next.set('subtree', '1');
    navigate(`/members?${next.toString()}`);
  }, [navigate, includeSubtree]);

  /** 当前组织上下文的查询串（org/tab/subtree），无组织时为空串。 */
  const orgContext = useCallback(() => {
    if (!orgId) return '';
    const next = new URLSearchParams();
    next.set('org', orgId);
    if (tab !== 'users') next.set('tab', tab);
    if (!includeSubtree) next.set('subtree', '0');
    return `?${next.toString()}`;
  }, [orgId, tab, includeSubtree]);

  // 进详情时把当前组织带在 query 里，否则「返回」无从知道该回到哪个组织。
  const openDetail = useCallback((kind: 'user' | 'project' | 'productline', id: string) => {
    navigate(`/members/${kind}/${id}${orgContext()}`);
  }, [navigate, orgContext]);

  const backToList = useCallback(() => {
    navigate(`/members${orgContext()}`);
  }, [navigate, orgContext]);

  return (
    <div className="flex h-full gap-3 p-3">
      <div className="shrink-0 flex flex-col" style={{ width: 260, background: 'var(--card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
        <OrgTree
          selectedOrgId={orgId}
          onSelect={handleSelectOrg}
          canManage={canManage}
          onCreate={(parentId) => setOrgForm({ org: null, parentId })}
          reloadToken={reloadToken}
        />
      </div>

      <div className="flex-1 min-w-0 flex flex-col" style={{ background: 'var(--card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
        <GlobalUserSearch onPick={(userId) => openDetail('user', userId)} />

        <div style={{ flex: 1, minHeight: 0 }}>
          {detailKind === 'user' && detailId ? (
            <UserDetailPanel userId={detailId} onBack={backToList} />
          ) : detailKind === 'productline' && detailId ? (
            <ProductLineDetailPanel
              productLineId={detailId}
              onBack={backToList}
              onOpenProject={(id) => openDetail('project', id)}
            />
          ) : detailKind === 'project' && detailId ? (
            <ProjectDetailPanel projectId={detailId} onBack={backToList} />
          ) : orgId ? (
            <OrgDetailPanel
              key={orgId}
              orgId={orgId}
              tab={tab}
              includeSubtree={includeSubtree}
              q={q}
              page={page}
              pageSize={PAGE_SIZE}
              onPatchParams={patchParams}
              onOpenUser={(id) => openDetail('user', id)}
              onOpenProductLine={(id) => openDetail('productline', id)}
              onOrgChanged={() => setReloadToken((v) => v + 1)}
              onEditOrg={(o) => setOrgForm({ org: o, parentId: o.parentId })}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <p className="text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('members:selectOrgPrompt')}
              </p>
            </div>
          )}
        </div>
      </div>

      <OrgFormModal
        visible={orgForm !== null}
        org={orgForm?.org ?? null}
        parentId={orgForm?.parentId ?? null}
        allOrgs={sortByPath(organizations).map((o) => ({ id: o.id, name: o.name, path: o.path ?? '' }))}
        onClose={() => setOrgForm(null)}
        onSaved={() => { setOrgForm(null); setReloadToken((v) => v + 1); }}
      />
    </div>
  );
}
