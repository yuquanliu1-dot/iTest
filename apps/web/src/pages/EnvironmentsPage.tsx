import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Environment, type EnvironmentObject } from '../api/client';
import { useUIStore } from '../stores/ui';
import Icon from '../components/Icon';
import EmptyState from '../components/ui/EmptyState';
import IconButton from '../components/ui/IconButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/Modal';
import Input from '../components/ui/Input';
import Button from '../components/ui/Button';
import Segmented from '../components/ui/Segmented';
import {
  PageShell,
  PageShellActions,
  PageShellContent,
  PageShellDescription,
  PageShellHeader,
} from '../components/layout/PageShell';

interface EnvFormState {
  open: boolean;
  mode: 'create' | 'edit';
  id: string | null;
  name: string;
  baseUrl: string;
}
const EMPTY_ENV_FORM: EnvFormState = { open: false, mode: 'create', id: null, name: '', baseUrl: '' };

type ObjType = 'db' | 'syslog' | 'login';
interface ObjFormState {
  open: boolean;
  envId: string;
  envName: string;
  objectType: ObjType;
  /** null → 新建对象 */
  object: EnvironmentObject | null;
  dbType: 'postgres' | 'mysql';
  syslogAuth: 'key' | 'password';
  host: string;
  port: string;
  dbName: string;
  user: string;
  password: string;
  sshPort: string;
  filePath: string;
  privateKey: string;
  loginUrl: string;
}
const EMPTY_OBJ_FORM: ObjFormState = {
  open: false, envId: '', envName: '', objectType: 'db', object: null,
  dbType: 'postgres', syslogAuth: 'key',
  host: '', port: '', dbName: '', user: '', password: '', sshPort: '22', filePath: '', privateKey: '',
  loginUrl: '',
};

/** db 表单 → 连接参数：保存 payload 与「测试连接」共用同一映射。密码留空不上送（后端保留旧密文）。 */
function dbFormConn(f: ObjFormState) {
  return {
    dbType: f.dbType,
    host: f.host.trim(),
    ...(f.port.trim() ? { port: Number(f.port) } : {}),
    dbName: f.dbName.trim(),
    user: f.user.trim(),
    ...(f.password ? { password: f.password } : {}),
  };
}

/** syslog 表单 → 连接参数：保存 payload 与「测试连接」共用同一映射。凭据留空不上送（后端保留旧密文）。 */
function syslogFormConn(f: ObjFormState) {
  return {
    host: f.host.trim(),
    user: f.user.trim(),
    ...(f.sshPort.trim() ? { sshPort: Number(f.sshPort) } : {}),
    filePath: f.filePath.trim(),
    authType: f.syslogAuth,
    ...(f.syslogAuth === 'password'
      ? (f.password ? { password: f.password } : {})
      : (f.privateKey ? { privateKey: f.privateKey } : {})),
  };
}

/** 组装对象 payload：密码/私钥字段原样上送，留空由后端保留旧密文（不覆盖语义）。 */
function buildObjectPayload(f: ObjFormState): Record<string, unknown> {
  if (f.objectType === 'db') {
    return dbFormConn(f);
  }
  if (f.objectType === 'login') {
    return {
      user: f.user.trim(),
      ...(f.loginUrl.trim() ? { loginUrl: f.loginUrl.trim() } : {}),
      ...(f.password ? { password: f.password } : {}),
    };
  }
  return syslogFormConn(f);
}

function objectSummary(o: EnvironmentObject): string {
  const p = (o.payload ?? {}) as Record<string, unknown>;
  if (o.objectType === 'db') {
    return [p.host, p.port != null ? String(p.port) : null, p.dbName].filter(Boolean).join(':');
  }
  if (o.objectType === 'login') {
    return String(p.user ?? '');
  }
  return [p.host, p.filePath].filter(Boolean).join(' · ');
}

export default function EnvironmentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const envsQ = useQuery({
    queryKey: ['environments', projectId],
    queryFn: () => api.environments.list(projectId!),
    enabled: !!projectId,
  });

  const [envForm, setEnvForm] = useState<EnvFormState>(EMPTY_ENV_FORM);
  const [objForm, setObjForm] = useState<ObjFormState>(EMPTY_OBJ_FORM);
  const [confirmEnv, setConfirmEnv] = useState<{ env: Environment; caseCount: number; planCount: number } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['environments', projectId] });

  const saveEnv = useMutation({
    mutationFn: () => {
      const name = envForm.name.trim();
      const baseUrl = envForm.baseUrl.trim();
      return envForm.mode === 'create'
        ? api.environments.create(projectId!, { name, baseUrl: baseUrl || undefined })
        : api.environments.patch(envForm.id!, { name, baseUrl: baseUrl || null });
    },
    onSuccess: () => {
      toast(envForm.mode === 'create' ? '环境已创建' : '环境已更新', 'success');
      setEnvForm(EMPTY_ENV_FORM);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const setDefault = useMutation({
    mutationFn: (id: string) => api.environments.patch(id, { isDefault: true }),
    onSuccess: () => {
      toast('默认环境已更新', 'success');
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const removeEnv = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: boolean }) =>
      api.environments.remove(id, { confirm }),
    onSuccess: (r, vars) => {
      if (r.requiresConfirm) {
        const env = envsQ.data?.find((e) => e.id === vars.id);
        if (env) setConfirmEnv({ env, caseCount: r.caseCount ?? 0, planCount: r.planCount ?? 0 });
        return;
      }
      toast('环境已删除', 'success');
      setConfirmEnv(null);
      invalidate();
    },
    onError: (e: Error) => {
      toast(e.message, 'error');
      setConfirmEnv(null);
    },
  });

  const saveObj = useMutation({
    mutationFn: () => {
      const payload = buildObjectPayload(objForm);
      if (objForm.object) return api.environments.patchObject(objForm.object.id, { payload });
      const env = envsQ.data?.find((e) => e.id === objForm.envId);
      const typeHasDefault = env?.objects.some((o) => o.objectType === objForm.objectType && o.isDefault) ?? false;
      return api.environments.createObject(objForm.envId, {
        objectType: objForm.objectType,
        payload,
        isDefault: !typeHasDefault,
      });
    },
    onSuccess: () => {
      toast(objForm.object ? '配置已保存' : '对象已添加', 'success');
      setObjForm(EMPTY_OBJ_FORM);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const removeObj = useMutation({
    mutationFn: (id: string) => api.environments.removeObject(id),
    onSuccess: () => {
      toast('对象已删除', 'success');
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // 连接测试：用表单当前值（未保存也可）；编辑态凭据留空由后端回退已存密文
  const testConn = useMutation({
    mutationFn: () => {
      if (objForm.objectType === 'db') {
        return api.environments.testDb({ objectId: objForm.object?.id, ...dbFormConn(objForm) });
      }
      return api.environments.testSyslog({ objectId: objForm.object?.id, ...syslogFormConn(objForm) });
    },
  });

  const openObjForm = (env: Environment, objectType: ObjType, object: EnvironmentObject | null) => {
    testConn.reset();
    const p = (object?.payload ?? {}) as Record<string, unknown>;
    setObjForm({
      ...EMPTY_OBJ_FORM,
      open: true,
      envId: env.id,
      envName: env.name,
      objectType,
      object,
      dbType: p.dbType === 'mysql' ? 'mysql' : 'postgres',
      syslogAuth: p.authType === 'password' ? 'password' : 'key',
      host: String(p.host ?? ''),
      port: p.port != null ? String(p.port) : '',
      dbName: String(p.dbName ?? ''),
      user: String(p.user ?? ''),
      // 密码/私钥永不回显：留空提交即保留旧密文
      sshPort: p.sshPort != null ? String(p.sshPort) : '22',
      filePath: String(p.filePath ?? ''),
      loginUrl: String(p.loginUrl ?? ''),
    });
  };

  const envs = envsQ.data ?? [];

  return (
    <PageShell>
      <PageShellHeader>
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 self-center">
          <IconButton icon="chevronLeft" title="返回项目" onClick={() => navigate('/')} />
          <h1 className="min-w-0 truncate text-2xl font-medium tracking-tight md:text-3xl">
            环境管理
          </h1>
        </div>
        <PageShellActions>
          <Button onClick={() => setEnvForm({ open: true, mode: 'create', id: null, name: '', baseUrl: '' })}>
            <Icon name="plus" size={14} />
            新建环境
          </Button>
        </PageShellActions>
        <PageShellDescription>
          项目级维护 DB / syslog / 登录凭据对象；未被用例、计划、版本显式指定时使用默认环境
        </PageShellDescription>
      </PageShellHeader>

      <PageShellContent>
        {envsQ.isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>加载中...</span>
          </div>
        ) : envsQ.isError ? (
          <div className="text-[13px]" style={{ color: 'var(--destructive)' }}>
            加载失败：{(envsQ.error as Error | null)?.message ?? '未知错误'}
          </div>
        ) : envs.length === 0 ? (
          <EmptyState icon="database" title="还没有环境" description="创建环境并录入数据库 / syslog 对象，供执行时解析连接信息。" />
        ) : (
          <div className="flex flex-col gap-3" data-stagger>
            {envs.map((env) => (
              <div
                key={env.id}
                className="rounded-[var(--radius-sm)] overflow-hidden"
                style={{ border: '1px solid var(--border)', background: 'var(--card)' }}
              >
                <div className="flex items-center gap-3 px-3 py-2" style={{ background: 'var(--muted)' }}>
                  <Icon name="database" size={13} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
                  <div className="flex flex-col min-w-0">
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>
                      {env.name}
                    </span>
                    {env.baseUrl && (
                      <span className="text-[11px] font-mono truncate" style={{ color: 'var(--muted-foreground)' }}>
                        {env.baseUrl}
                      </span>
                    )}
                  </div>
                  {env.isDefault && (
                    <span
                      className="text-[10px] font-semibold uppercase px-1.5 py-[1px] rounded"
                      style={{ background: 'var(--primary-soft)', color: 'var(--primary)', letterSpacing: '0.04em' }}
                    >
                      默认
                    </span>
                  )}
                  <div className="flex-1" />
                  <div className="flex items-center gap-1">
                    <IconButton
                      icon="star"
                      title={env.isDefault ? '已是默认环境' : '设为默认环境'}
                      onClick={() => setDefault.mutate(env.id)}
                      disabled={env.isDefault}
                    />
                    <IconButton icon="pencil" title="编辑环境" onClick={() => setEnvForm({ open: true, mode: 'edit', id: env.id, name: env.name, baseUrl: env.baseUrl ?? '' })} />
                    <IconButton icon="trash" title="删除环境" tone="destructive" onClick={() => removeEnv.mutate({ id: env.id, confirm: false })} />
                  </div>
                </div>
                <div className="px-3 py-2 flex flex-col">
                  {env.objects.length === 0 && (
                    <div className="text-[12px] py-1" style={{ color: 'var(--muted-foreground)' }}>
                      暂无对象，可添加数据库、syslog 或登录凭据配置
                    </div>
                  )}
                  {env.objects.map((o) => (
                    <div
                      key={o.id}
                      className="flex items-center gap-3 py-1.5 hairline-top"
                      style={{ borderColor: 'var(--muted)' }}
                    >
                      <Icon
                        name={o.objectType === 'db' ? 'database' : o.objectType === 'login' ? 'user' : 'terminal'}
                        size={12}
                        style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}
                      />
                      <span className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                        {o.objectType === 'db' ? '数据库' : o.objectType === 'login' ? '登录凭据' : 'syslog'}
                        {o.label ? ` · ${o.label}` : ''}
                      </span>
                      {o.isDefault && (
                        <span
                          className="text-[10px] px-1.5 py-[1px] rounded"
                          style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
                        >
                          默认
                        </span>
                      )}
                      <span className="text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>
                        {objectSummary(o) || '未填写'}
                      </span>
                      <div className="flex-1" />
                      <div className="flex items-center gap-1">
                        <IconButton icon="pencil" title="编辑对象" onClick={() => openObjForm(env, o.objectType, o)} />
                        <IconButton icon="trash" title="删除对象" tone="destructive" onClick={() => removeObj.mutate(o.id)} />
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => openObjForm(env, 'db', null)}
                      className="flex items-center gap-1.5 text-[12px]"
                      style={{ background: 'transparent', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}
                    >
                      <Icon name="plus" size={12} />
                      数据库
                    </button>
                    <button
                      type="button"
                      onClick={() => openObjForm(env, 'syslog', null)}
                      className="flex items-center gap-1.5 text-[12px]"
                      style={{ background: 'transparent', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}
                    >
                      <Icon name="plus" size={12} />
                      syslog
                    </button>
                    <button
                      type="button"
                      onClick={() => openObjForm(env, 'login', null)}
                      className="flex items-center gap-1.5 text-[12px]"
                      style={{ background: 'transparent', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}
                    >
                      <Icon name="plus" size={12} />
                      登录凭据
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </PageShellContent>

      {/* 环境新建/重命名弹窗 */}
      <Dialog open={envForm.open} onOpenChange={(open) => setEnvForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{envForm.mode === 'create' ? '新建环境' : '编辑环境'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input
              label="环境名"
              placeholder="如：开发测试、预生产"
              value={envForm.name}
              onChange={(e) => setEnvForm((f) => ({ ...f, name: e.target.value }))}
            />
            <Input
              label="基础 URL（可空，执行期导航兜底）"
              placeholder="https://example.com"
              value={envForm.baseUrl}
              onChange={(e) => setEnvForm((f) => ({ ...f, baseUrl: e.target.value }))}
            />
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top" style={{ borderColor: 'var(--border)' }}>
            <Button variant="ghost" onClick={() => setEnvForm(EMPTY_ENV_FORM)}>取消</Button>
            <Button disabled={!envForm.name.trim() || saveEnv.isPending} onClick={() => saveEnv.mutate()}>
              {saveEnv.isPending ? '保存中...' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 对象（DB / syslog）编辑弹窗 */}
      <Dialog open={objForm.open} onOpenChange={(open) => setObjForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {objForm.object ? '编辑' : '添加'}{objForm.objectType === 'db' ? ' 数据库' : objForm.objectType === 'login' ? ' 登录凭据' : ' syslog'} · {objForm.envName}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 px-5 py-4 overflow-y-auto flex flex-col gap-3">
            {objForm.objectType === 'db' ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>数据库类型</label>
                  <Segmented
                    value={objForm.dbType}
                    onChange={(v) => setObjForm((f) => ({ ...f, dbType: v }))}
                    options={[
                      { value: 'postgres', label: 'PostgreSQL' },
                      { value: 'mysql', label: 'MySQL' },
                    ]}
                  />
                </div>
                <Input label="数据库主机" value={objForm.host} onChange={(e) => setObjForm((f) => ({ ...f, host: e.target.value }))} placeholder="db.example.com" />
                <Input label="数据库端口" value={objForm.port} onChange={(e) => setObjForm((f) => ({ ...f, port: e.target.value }))} placeholder={objForm.dbType === 'mysql' ? '3306' : '5432'} />
                <Input label="数据库名" value={objForm.dbName} onChange={(e) => setObjForm((f) => ({ ...f, dbName: e.target.value }))} />
                <Input label="数据库用户" value={objForm.user} onChange={(e) => setObjForm((f) => ({ ...f, user: e.target.value }))} />
                <Input
                  label="数据库密码"
                  type="password"
                  value={objForm.password}
                  onChange={(e) => setObjForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder={objForm.object ? '留空表示不修改' : '留空表示不设置'}
                />
              </>
            ) : objForm.objectType === 'login' ? (
              <>
                <Input
                  label="登录页地址（可选）"
                  value={objForm.loginUrl}
                  onChange={(e) => setObjForm((f) => ({ ...f, loginUrl: e.target.value }))}
                  placeholder="留空用计划检测页，如 https://example.com/login"
                />
                <Input label="用户名" value={objForm.user} onChange={(e) => setObjForm((f) => ({ ...f, user: e.target.value }))} />
                <Input
                  label="密码"
                  type="password"
                  value={objForm.password}
                  onChange={(e) => setObjForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder={objForm.object ? '留空表示不修改' : '留空表示不设置'}
                />
                <p className="text-[11px] m-0" style={{ color: 'var(--muted-foreground)' }}>
                  计划开启「登录准备」且未选登录用例时，执行将用此凭据自动填表登录。
                </p>
              </>
            ) : (
              <>
                <Input label="syslog 主机" value={objForm.host} onChange={(e) => setObjForm((f) => ({ ...f, host: e.target.value }))} placeholder="logs.example.com" />
                <Input label="syslog 用户" value={objForm.user} onChange={(e) => setObjForm((f) => ({ ...f, user: e.target.value }))} />
                <Input label="SSH 端口" value={objForm.sshPort} onChange={(e) => setObjForm((f) => ({ ...f, sshPort: e.target.value }))} placeholder="22" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>认证方式</label>
                  <Segmented
                    value={objForm.syslogAuth}
                    onChange={(v) => setObjForm((f) => ({ ...f, syslogAuth: v }))}
                    options={[
                      { value: 'key', label: 'SSH 私钥' },
                      { value: 'password', label: '密码' },
                    ]}
                  />
                </div>
                {objForm.syslogAuth === 'password' ? (
                  <Input
                    label="SSH 密码"
                    type="password"
                    value={objForm.password}
                    onChange={(e) => setObjForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder={objForm.object ? '留空表示不修改' : '留空表示不设置'}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>SSH 私钥（PEM）</label>
                    <textarea
                      className="input-base"
                      rows={6}
                      value={objForm.privateKey}
                      onChange={(e) => setObjForm((f) => ({ ...f, privateKey: e.target.value }))}
                      placeholder={objForm.object ? '留空表示不修改' : '首次添加时填写'}
                    />
                  </div>
                )}
                <Input label="syslog 文件路径" value={objForm.filePath} onChange={(e) => setObjForm((f) => ({ ...f, filePath: e.target.value }))} placeholder="/var/log/syslog" />
              </>
            )}
          </div>
          <div className="flex items-center gap-2 px-5 py-3 hairline-top shrink-0" style={{ borderColor: 'var(--border)' }}>
            {objForm.objectType !== 'login' && (
              <>
                <Button
                  variant="ghost"
                  className="shrink-0"
                  disabled={
                    testConn.isPending ||
                    !objForm.host.trim() ||
                    !objForm.user.trim() ||
                    (objForm.objectType === 'db' ? !objForm.dbName.trim() : !objForm.filePath.trim())
                  }
                  onClick={() => testConn.mutate()}
                >
                  {testConn.isPending ? '测试中...' : '测试连接'}
                </Button>
                {testConn.isPending && (
                  <span className="text-[12px] min-w-0 break-words" style={{ color: 'var(--muted-foreground)' }}>正在连接...</span>
                )}
                {testConn.isSuccess && testConn.data.ok && (
                  <span className="text-[12px] min-w-0 break-words" style={{ color: 'var(--success)' }}>连接成功 · {testConn.data.latencyMs}ms</span>
                )}
                {testConn.isSuccess && !testConn.data.ok && (
                  <span className="text-[12px] min-w-0 break-words" style={{ color: 'var(--destructive)' }}>连接失败：{testConn.data.error}</span>
                )}
              </>
            )}
            <div className="flex-1" />
            <Button variant="ghost" className="shrink-0" onClick={() => setObjForm(EMPTY_OBJ_FORM)} disabled={saveObj.isPending}>取消</Button>
            <Button className="shrink-0" disabled={saveObj.isPending} onClick={() => saveObj.mutate()}>
              {saveObj.isPending ? '保存中...' : objForm.object ? '保存' : '添加'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除环境确认（被用例/计划引用时两段确认） */}
      <Dialog open={!!confirmEnv} onOpenChange={(open) => { if (!open) setConfirmEnv(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>删除环境</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            「{confirmEnv?.env.name}」被 {confirmEnv?.caseCount} 个用例、{confirmEnv?.planCount} 个计划引用。
            删除后这些引用会自动清空，执行时回退到项目默认环境。确定删除？
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top" style={{ borderColor: 'var(--border)' }}>
            <Button variant="ghost" onClick={() => setConfirmEnv(null)}>取消</Button>
            <Button
              variant="danger"
              disabled={removeEnv.isPending}
              onClick={() => confirmEnv && removeEnv.mutate({ id: confirmEnv.env.id, confirm: true })}
            >
              {removeEnv.isPending ? '删除中...' : '确认删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
