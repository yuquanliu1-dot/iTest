import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../../i18n';
import { useUIStore } from '../../stores/ui';
import { api, type ProductLine, type ProjectWithCount } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { isManagerOfOrgPath } from '../../utils/orgTree';
import MoveProductLineModal from './MoveProductLineModal';
import ChangeProductLineModal from './ChangeProductLineModal';
import ProductLineFormModal from './ProductLineFormModal';

interface Props {
  productLineId: string;
  onBack: () => void;
  /** 打开线内某个项目的详情（沿用项目详情面板：分配用户 / 变更产品线）。 */
  onOpenProject: (projectId: string) => void;
}

interface LineProject {
  id: string;
  name: string;
  description: string | null;
}

/**
 * 产品线详情。成员管理界面里产品线完全替代项目，所以这一层承接原「项目详情」的位置：
 * - 线内项目列表：点进去仍是项目详情（分配用户、变更产品线）
 * - 可挂载项目：项目必属一条线，挂到本线即换组织（标签一并迁移）
 * - 编辑 / 删除 / 移动产品线
 */
export default function ProductLineDetailPanel({ productLineId, onBack, onOpenProject }: Props) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const organizations = useAuthStore((s) => s.organizations);
  const [line, setLine] = useState<ProductLine | null>(null);
  const [lineProjects, setLineProjects] = useState<LineProject[]>([]);
  const [allProjects, setAllProjects] = useState<ProjectWithCount[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // 「变更产品线」的目标候选：调用者可见的全部线。project_line_id 必填后不存在「移出线」，
  // 换线只有一个方向——挂到另一条线（项目随之换组织）。
  const [visibleLines, setVisibleLines] = useState<ProductLine[]>([]);
  const [changeTarget, setChangeTarget] = useState<LineProject | null>(null);
  // 产品线所属组织的管理员才可写（挂载/改/删/移动/换线）。产品线只有 organizationId 没有
  // path，而 authStore.organizations 只含直接 membership → 目标组织 path 从 managed-subtree
  // 取，与后端 isManagerOfOrg 对齐，避免展示必然 403 的按钮。
  const [orgPaths, setOrgPaths] = useState<Map<string, string>>(new Map());
  // 「移动组织」的候选：调用者对其有管理员权限的子树节点。移动要双闸门（源 + 目标都管），
  // 目标一侧的候选同样按 isManagerOfOrgPath 过滤，否则点下去必然 403。
  const [managedOrgs, setManagedOrgs] = useState<Array<{ id: string; name: string; path: string }>>([]);

  // 切换产品线时旧的异步响应可能后到 → 用 ref 里的当前 id 判一次，避免写脏上一条线。
  const currentIdRef = useRef(productLineId);
  currentIdRef.current = productLineId;

  const loadLine = () => {
    const id = currentIdRef.current;
    api.productLines.get(id)
      .then((d) => { if (currentIdRef.current === id) setLine(d); })
      .catch(() => { if (currentIdRef.current === id) setLine(null); });
    api.productLines.projects(id)
      .then((ps) => { if (currentIdRef.current === id) setLineProjects(ps); })
      .catch(() => { if (currentIdRef.current === id) setLineProjects([]); });
  };

  useEffect(() => {
    setPicked(new Set());
    loadLine();
  }, [productLineId]);

  useEffect(() => {
    let stale = false;
    api.projects.list()
      .then((ps) => { if (!stale) setAllProjects(ps); })
      .catch(() => { if (!stale) setAllProjects([]); });
    return () => { stale = true; };
  }, []);

  useEffect(() => {
    let stale = false;
    api.productLines.list()
      .then((ls) => { if (!stale) setVisibleLines(ls); })
      .catch(() => { if (!stale) setVisibleLines([]); });
    api.orgs.managedSubtree()
      .then((orgs) => {
        if (stale) return;
        setOrgPaths(new Map(orgs.map((o) => [o.id, o.path])));
        setManagedOrgs(orgs.map((o) => ({ id: o.id, name: o.name, path: o.path })));
      })
      .catch(() => {
        if (stale) return;
        setOrgPaths(new Map());
        setManagedOrgs([]);
      });
    return () => { stale = true; };
  }, []);

  const canManageLine = !!line && isManagerOfOrgPath(organizations, orgPaths.get(line.organizationId));
  const moveOrgChoices = managedOrgs.filter((o) => isManagerOfOrgPath(organizations, o.path));

  const inLineIds = new Set(lineProjects.map((p) => p.id));
  // 可挂载候选：本线之外的全部项目——挂载即搬家，所以「在别的线下」不再是障碍。
  const attachable = allProjects.filter((p) => !inLineIds.has(p.id));

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleAttach = async () => {
    if (picked.size === 0) return;
    setBusy(true);
    try {
      await api.productLines.attachProjects(productLineId, [...picked]);
      toast(t('members:linesAttached', { count: picked.size }), 'success');
      setPicked(new Set());
      loadLine();
    } catch (e) {
      toast(e instanceof Error ? localizeApiError(e) : t('members:opFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await api.productLines.remove(productLineId);
      toast(t('members:lineDeleted'), 'success');
      setConfirmDelete(false);
      onBack();
    } catch (e) {
      toast(e instanceof Error ? localizeApiError(e) : t('members:opFailed'), 'error');
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: 13 }}>{t('members:back')}</button>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>{line?.name ?? ''}</span>
        <div className="ml-auto flex gap-2">
          {canManageLine && (
            <>
              <button
                className="text-[12px]"
                style={{ color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer' }}
                onClick={() => setMoveOpen(true)}
              >
                {t('members:moveLineOrg')}
              </button>
              <button
                className="text-[12px]"
                style={{ color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer' }}
                onClick={() => setEditOpen(true)}
              >
                {t('members:edit')}
              </button>
              <button
                className="text-[12px]"
                style={{ color: 'var(--destructive)', background: 'none', border: 'none', cursor: 'pointer' }}
                onClick={() => setConfirmDelete(true)}
              >
                {t('common:delete')}
              </button>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: 12, padding: 12 }}>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--foreground)' }}>{line?.name ?? ''}</span>
            <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>{t('members:lineProjectCount', { count: lineProjects.length })}</span>
          </div>
          {line?.description && (
            <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 4 }}>{line.description}</div>
          )}
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 12 }}>
          <div className="flex items-center gap-2" style={{ padding: '6px 10px', background: 'var(--background)' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted-foreground)', flex: 1 }}>{t('members:lineProjectsTitle', { count: lineProjects.length })}</span>
          </div>
          <div style={{ padding: '4px 8px' }}>
            {lineProjects.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)' }}>{t('members:noLineProjects')}</div>
            ) : lineProjects.map((p) => (
              <div key={p.id} className="flex items-center gap-2" style={{ padding: '6px 4px', fontSize: 13 }}>
                <span
                  className="truncate"
                  style={{ flex: 1, color: 'var(--foreground)', cursor: 'pointer' }}
                  onClick={() => onOpenProject(p.id)}
                >
                  {p.name}
                </span>
                <button
                  className="text-[11px]"
                  style={{ padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--popover)', color: 'var(--muted-foreground)', cursor: 'pointer' }}
                  disabled={busy || !canManageLine}
                  onClick={() => setChangeTarget(p)}
                >
                  {t('members:lineChangeBtn')}
                </button>
              </div>
            ))}
          </div>
        </div>

        {attachable.length > 0 && canManageLine && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            <div className="flex items-center gap-2" style={{ padding: '6px 10px', background: 'var(--background)' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted-foreground)', flex: 1 }}>{t('members:lineAttachableTitle')}</span>
              <button
                className="text-[11px]"
                style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--primary)', background: 'var(--popover)', color: 'var(--primary)', cursor: 'pointer', opacity: picked.size === 0 || busy ? 0.6 : 1 }}
                disabled={picked.size === 0 || busy}
                onClick={() => void handleAttach()}
              >
                {t('members:lineAttachBtn', { count: picked.size })}
              </button>
            </div>
            <div style={{ padding: '4px 8px' }}>
              <div style={{ fontSize: 11, color: 'var(--muted-foreground)', padding: '4px 4px 6px' }}>{t('members:lineAttachHint')}</div>
              {attachable.map((p) => (
                <label key={p.id} className="flex items-center gap-2" style={{ padding: '6px 4px', fontSize: 13, color: 'var(--foreground)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={picked.has(p.id)} onChange={() => togglePick(p.id)} />
                  <span className="truncate">{p.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      <ProductLineFormModal
        visible={editOpen}
        line={editOpen ? line : null}
        organizationId={line?.organizationId ?? ''}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          loadLine();
        }}
      />

      <MoveProductLineModal
        visible={moveOpen}
        productLineId={productLineId}
        productLineName={line?.name ?? ''}
        currentOrganizationId={line?.organizationId ?? ''}
        choices={moveOrgChoices}
        onClose={() => setMoveOpen(false)}
        onMoved={() => {
          setMoveOpen(false);
          toast(t('members:lineMoved'), 'success');
          loadLine();
        }}
      />

      <ChangeProductLineModal
        visible={!!changeTarget}
        projectId={changeTarget?.id ?? ''}
        projectName={changeTarget?.name ?? ''}
        currentProductLineId={productLineId}
        choices={visibleLines}
        onClose={() => setChangeTarget(null)}
        onChanged={() => {
          setChangeTarget(null);
          toast(t('members:lineChanged'), 'success');
          loadLine();
        }}
      />

      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) setConfirmDelete(false); }}>
          <div style={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-2xl)', padding: 16, width: 380, maxWidth: 'calc(100vw - 32px)' }}>
            <h3 style={{ margin: 0, marginBottom: 8, fontSize: 14, fontWeight: 600 }}>{t('members:lineDeleteTitle')}</h3>
            <div style={{ fontSize: 13, color: 'var(--muted-foreground)', marginBottom: 12 }}>
              {t('members:lineDeleteConfirm', { name: line?.name ?? '' })}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirmDelete(false)} style={{ padding: '6px 12px', background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--muted-foreground)', borderRadius: 6, cursor: 'pointer' }}>{t('common:cancel')}</button>
              <button onClick={() => void handleDelete()} style={{ padding: '6px 12px', background: 'var(--destructive)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>{t('common:delete')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
