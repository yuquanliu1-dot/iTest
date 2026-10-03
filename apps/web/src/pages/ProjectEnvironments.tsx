import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Environment, type ProjectVersion } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import './ProjectEnvironments.css';

interface Props { projectId: string }

type FieldKey =
  | 'name'
  | 'dbHost'
  | 'dbPort'
  | 'dbName'
  | 'dbUser'
  | 'dbPassword'
  | 'syslogHost'
  | 'syslogUser'
  | 'syslogSshPort'
  | 'syslogKey'
  | 'syslogFilePath';

type FormState = Record<FieldKey, string>;

const FIELDS: ReadonlyArray<FieldKey> = [
  'name',
  'dbHost',
  'dbPort',
  'dbName',
  'dbUser',
  'dbPassword',
  'syslogHost',
  'syslogUser',
  'syslogSshPort',
  'syslogKey',
  'syslogFilePath',
] as const;

const FIELD_LABELS: Record<FieldKey, string> = {
  name: '名称',
  dbHost: '数据库主机',
  dbPort: '数据库端口',
  dbName: '数据库名',
  dbUser: '数据库用户',
  dbPassword: '数据库密码',
  syslogHost: 'syslog 主机',
  syslogUser: 'syslog 用户',
  syslogSshPort: 'syslog SSH 端口',
  syslogKey: 'syslog SSH 私钥（PEM）',
  syslogFilePath: 'syslog 文件路径',
};

type EnvBody = Parameters<typeof api.environments.create>[1];

function buildSubmitBody(form: FormState, versionId: string | null): EnvBody {
  const num = (v: string): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== '' ? n : undefined;
  };
  return {
    name: form.name,
    versionId: versionId ?? undefined,
    dbHost: form.dbHost || undefined,
    dbPort: num(form.dbPort),
    dbName: form.dbName || undefined,
    dbUser: form.dbUser || undefined,
    dbPassword: form.dbPassword || undefined,
    syslogHost: form.syslogHost || undefined,
    syslogUser: form.syslogUser || undefined,
    syslogSshPort: num(form.syslogSshPort),
    syslogKey: form.syslogKey || undefined,
    syslogFilePath: form.syslogFilePath || undefined,
  };
}

function initialFormFromRecord(record: Environment | null): FormState {
  return {
    name: record?.name ?? '',
    dbHost: record?.dbHost ?? '',
    dbPort: record?.dbPort != null ? String(record.dbPort) : '',
    dbName: record?.dbName ?? '',
    dbUser: record?.dbUser ?? '',
    dbPassword: '',
    syslogHost: record?.syslogHost ?? '',
    syslogUser: record?.syslogUser ?? '',
    syslogSshPort: record?.syslogSshPort != null ? String(record.syslogSshPort) : '22',
    syslogKey: '',
    syslogFilePath: record?.syslogFilePath ?? '',
  };
}

export default function ProjectEnvironments({ projectId }: Props) {
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const currentVersionId = useProjectStore((s) => s.current?.versionId ?? null);
  const currentVersionName = useProjectStore((s) => s.current?.versionName ?? null);

  const versions = useQuery({
    queryKey: ['versions', projectId],
    queryFn: () => api.versions.list(projectId),
    enabled: !!projectId,
  });
  const versionById = new Map<string, ProjectVersion>(
    (versions.data ?? []).map((v) => [v.id, v] as const),
  );

  const list = useQuery({
    queryKey: ['environments', projectId, currentVersionId],
    queryFn: () => api.environments.list(projectId, { versionId: currentVersionId ?? undefined }),
    enabled: !!projectId,
  });

  const [editing, setEditing] = useState<{ id?: string; record: Environment | null } | null>(null);

  const create = useMutation({
    mutationFn: (body: EnvBody) => api.environments.create(projectId, body),
    onSuccess: () => {
      toast('环境已创建', 'success');
      qc.invalidateQueries({ queryKey: ['environments', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: EnvBody }) => api.environments.patch(id, body),
    onSuccess: () => {
      toast('环境已保存', 'success');
      qc.invalidateQueries({ queryKey: ['environments', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: boolean }) =>
      api.environments.remove(id, { confirm }),
    onSuccess: (r, vars) => {
      if (r.requiresConfirm && !vars.confirm) {
        const ok = window.confirm(
          `有 ${r.caseCount ?? 0} 个用例与 ${r.planCount ?? 0} 个计划引用此环境，确认删除？引用将自动解除。`,
        );
        if (ok) remove.mutate({ id: vars.id, confirm: true });
        return;
      }
      toast('环境已删除', 'success');
      qc.invalidateQueries({ queryKey: ['environments', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const openCreate = () => setEditing({ record: null });
  const openEdit = (e: Environment) => setEditing({ id: e.id, record: e });
  const closeDrawer = () => setEditing(null);

  const handleSubmit = (form: FormState) => {
    const body = buildSubmitBody(form, currentVersionId);
    if (!body.name) {
      toast('名称不能为空', 'error');
      return;
    }
    if (editing?.id) {
      patch.mutate({ id: editing.id, body });
    } else {
      create.mutate(body);
    }
    closeDrawer();
  };

  return (
    <div className="env-page">
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ color: 'var(--color-foreground-muted)', fontSize: 12 }}>
          {currentVersionId ? (
            <>
              当前版本 <strong style={{ color: 'var(--color-foreground)' }}>{currentVersionName ?? versionById.get(currentVersionId)?.name ?? '…'}</strong>
              {versionById.get(currentVersionId)?.isDefault ? (
                <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 999, background: 'var(--color-accent-soft)', color: 'var(--color-accent)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  默认
                </span>
              ) : null}
            </>
          ) : (
            '请选择版本后查看环境'
          )}
        </div>
        <button onClick={openCreate} disabled={!currentVersionId}>新建环境</button>
      </div>

      {list.isLoading ? (
        <div style={{ color: 'var(--color-foreground-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="loader" size={16} className="animate-spin" />
          <span>加载中...</span>
        </div>
      ) : list.isError ? (
        <div style={{ color: 'var(--color-destructive)' }}>
          加载失败：{(list.error as Error | null)?.message ?? '未知错误'}
        </div>
      ) : !list.data || list.data.length === 0 ? (
        <div style={{ color: 'var(--color-foreground-muted)' }}>暂无环境，点击右上角"新建环境"创建。</div>
      ) : (
        <table className="env-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>DB</th>
              <th>syslog</th>
              <th style={{ width: 140 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((e) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td>
                  {e.dbHost ?? '—'} / {e.dbName ?? '—'}
                </td>
                <td>
                  {e.syslogHost ?? '—'} / {e.syslogFilePath ?? '—'}
                </td>
                <td>
                  <button onClick={() => openEdit(e)}>编辑</button>
                  <button
                    onClick={() => remove.mutate({ id: e.id, confirm: false })}
                    style={{ marginLeft: 8 }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <EnvDrawer
          key={editing.id ?? '__new__'}
          initial={initialFormFromRecord(editing.record)}
          isEdit={!!editing.id}
          onClose={closeDrawer}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}

interface DrawerProps {
  initial: FormState;
  isEdit: boolean;
  onClose: () => void;
  onSubmit: (form: FormState) => void;
}

function EnvDrawer({ initial, isEdit, onClose, onSubmit }: DrawerProps) {
  const [form, setForm] = useState<FormState>(initial);

  const update = (k: FieldKey) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm({ ...form, [k]: e.target.value });
  };

  return (
    <>
      <div className="env-drawer-mask" onClick={onClose} />
      <div className="env-drawer">
        <h3>{isEdit ? '编辑环境' : '新建环境'}</h3>
        {FIELDS.map((k) => (
          <div className="env-form-row" key={k}>
            <label>{FIELD_LABELS[k]}</label>
            {k === 'syslogKey' ? (
              <textarea
                rows={6}
                value={form[k]}
                onChange={update(k)}
                placeholder="PEM 格式私钥；留空表示不修改"
              />
            ) : (
              <input
                value={form[k]}
                type={k === 'dbPassword' ? 'password' : 'text'}
                onChange={update(k)}
                placeholder={k === 'dbPassword' ? '留空表示不修改' : undefined}
              />
            )}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={() => onSubmit(form)}>保存</button>
          <button onClick={onClose}>取消</button>
        </div>
      </div>
    </>
  );
}