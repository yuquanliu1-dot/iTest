import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MemberRow, type OrgSummary } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Toggle from '../components/ui/Toggle';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';

/** 物化路径 '/<rootId>/<childId>/' → 树深度（根为 0）。 */
function depthOf(path: string): number {
  return Math.max(0, path.split('/').filter(Boolean).length - 1);
}

export default function MembersPage() {
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const orgsQuery = useQuery({ queryKey: ['organizations'], queryFn: api.orgs.list });
  const orgs: OrgSummary[] = orgsQuery.data ?? [];
  // 默认选中第一个可见组织（path 排序后即根组织）
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const selectedOrg = orgs.find((o) => o.id === selectedOrgId) ?? orgs[0] ?? null;

  const membersQuery = useQuery({
    queryKey: ['org-members', selectedOrg?.id],
    queryFn: () => api.orgs.members(selectedOrg!.id),
    enabled: Boolean(selectedOrg),
  });
  const members: MemberRow[] = membersQuery.data?.items ?? [];
  const canManage = Boolean(selectedOrg?.isManager);

  // 新建子组织
  const [subOrgModal, setSubOrgModal] = useState<{ parentId: string; parentName: string } | null>(null);
  const [subOrgName, setSubOrgName] = useState('');
  // 添加成员
  const [addModal, setAddModal] = useState(false);
  const [addUsername, setAddUsername] = useState('');
  const [addIsManager, setAddIsManager] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['organizations'] });
    if (selectedOrg) qc.invalidateQueries({ queryKey: ['org-members', selectedOrg.id] });
  };

  const createSubOrg = useMutation({
    mutationFn: () => api.orgs.createSubOrg(subOrgName.trim(), subOrgModal!.parentId),
    onSuccess: () => {
      toast('子组织已创建', 'success');
      setSubOrgModal(null);
      setSubOrgName('');
      qc.invalidateQueries({ queryKey: ['organizations'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const addMember = useMutation({
    mutationFn: () => api.orgs.addMember(selectedOrg!.id, { username: addUsername.trim(), isManager: addIsManager }),
    onSuccess: () => {
      toast('成员已添加', 'success');
      setAddModal(false);
      setAddUsername('');
      setAddIsManager(false);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const updateMember = useMutation({
    mutationFn: (vars: { userId: string; body: { isManager?: boolean; isUser?: boolean } }) =>
      api.orgs.updateMember(selectedOrg!.id, vars.userId, vars.body),
    onSuccess: invalidate,
    onError: (e: Error) => {
      toast(e.message, 'error');
      invalidate();
    },
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.orgs.removeMember(selectedOrg!.id, userId),
    onSuccess: () => {
      toast('成员已移除', 'success');
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <div className="flex h-full overflow-hidden">
      {/* 左侧：组织树（path 排序天然父在前） */}
      <div
        style={{
          width: 260,
          minWidth: 260,
          borderRight: '1px solid var(--color-border-subtle)',
          overflowY: 'auto',
          padding: '16px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-foreground-muted)', padding: '0 8px 8px' }}>
          组织
        </div>
        {orgs.map((o) => {
          const depth = depthOf(o.path);
          const active = selectedOrg?.id === o.id;
          return (
            <button
              key={o.id}
              onClick={() => setSelectedOrgId(o.id)}
              className="group-nav-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: active ? 'var(--color-accent-light)' : 'transparent',
                color: active ? 'var(--color-accent)' : 'var(--color-foreground-secondary)',
                borderRadius: 5,
                padding: '6px 8px',
                marginLeft: depth * 14,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <Icon name="layers" size={14} style={{ flexShrink: 0 }} />
              <span className="flex-1 truncate">{o.name}</span>
              <span style={{ fontSize: 11, color: 'var(--color-foreground-muted)' }}>{o.memberCount}</span>
            </button>
          );
        })}
        {canManage && selectedOrg && (
          <button
            onClick={() => setSubOrgModal({ parentId: selectedOrg.id, parentName: selectedOrg.name })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-foreground-muted)',
              padding: '6px 8px',
              marginLeft: depthOf(selectedOrg.path) * 14 + 20,
              cursor: 'pointer',
              fontSize: 12,
              textAlign: 'left',
            }}
          >
            <Icon name="plus" size={14} />
            新建子组织
          </button>
        )}
      </div>

      {/* 右侧：成员表 */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <div>
            <h1 className="text-[18px] font-bold tracking-tight" style={{ color: 'var(--color-foreground)' }}>
              {selectedOrg ? `成员管理 · ${selectedOrg.name}` : '成员管理'}
            </h1>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--color-foreground-muted)' }}>
              管理员可管理组织与成员；普通成员仅可使用项目
            </p>
          </div>
          {canManage && (
            <Button onClick={() => setAddModal(true)} disabled={!selectedOrg}>
              <Icon name="plus" size={14} />
              添加成员
            </Button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-6">
          {!selectedOrg ? (
            <EmptyState icon="layers" title="暂无可见组织" description="你尚未加入任何组织，请联系管理员" />
          ) : members.length === 0 ? (
            <EmptyState icon="user" title="暂无成员" description={canManage ? '点击右上角添加成员' : '该组织还没有成员'} />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: 'var(--color-foreground-muted)', fontSize: 11, textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>用户</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>管理员</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>可执行测试</th>
                  {canManage && <th style={{ padding: '8px 12px', fontWeight: 500, width: 70 }}>操作</th>}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId} style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ color: 'var(--color-foreground)', fontWeight: 500 }}>{m.displayName}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-foreground-muted)' }}>@{m.username}</div>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <Toggle
                        checked={m.isManager}
                        disabled={!canManage}
                        onChange={(v) => updateMember.mutate({ userId: m.userId, body: { isManager: v } })}
                      />
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <Toggle
                        checked={m.isUser}
                        disabled={!canManage}
                        onChange={(v) => updateMember.mutate({ userId: m.userId, body: { isUser: v } })}
                      />
                    </td>
                    {canManage && (
                      <td style={{ padding: '10px 12px' }}>
                        <button
                          onClick={() => removeMember.mutate(m.userId)}
                          title="移除成员"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-destructive)', padding: 4 }}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 新建子组织 */}
      <Dialog open={Boolean(subOrgModal)} onOpenChange={(open) => !open && setSubOrgModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建子组织{subOrgModal ? `（${subOrgModal.parentName} 下）` : ''}</DialogTitle>
          </DialogHeader>
          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input
              label="组织名称"
              value={subOrgName}
              onChange={(e) => setSubOrgName(e.target.value)}
              placeholder="例如：研发部"
              autoFocus
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="plain" onClick={() => setSubOrgModal(null)}>
                取消
              </Button>
              <Button onClick={() => createSubOrg.mutate()} disabled={!subOrgName.trim() || createSubOrg.isPending}>
                {createSubOrg.isPending ? '创建中…' : '创建'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 添加成员（按用户名） */}
      <Dialog open={addModal} onOpenChange={setAddModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加成员到 {selectedOrg?.name ?? ''}</DialogTitle>
          </DialogHeader>
          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Input
              label="用户名"
              value={addUsername}
              onChange={(e) => setAddUsername(e.target.value)}
              placeholder="已注册的用户名"
              autoFocus
            />
            <Toggle checked={addIsManager} onChange={setAddIsManager} label="设为管理员" />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button variant="plain" onClick={() => setAddModal(false)}>
                取消
              </Button>
              <Button onClick={() => addMember.mutate()} disabled={!addUsername.trim() || addMember.isPending}>
                {addMember.isPending ? '添加中…' : '添加'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
