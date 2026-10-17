import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Environment, type EnvironmentObject } from '../api/client';
import { useUIStore } from '../stores/ui';
import { creatorName } from '../lib/creatorName';
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
}
const EMPTY_ENV_FORM: EnvFormState = { open: false, mode: 'create', id: null, name: '' };

type ObjType = 'db' | 'syslog' | 'login' | 'web';
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
  /** web 服务：payload.name（可空，空则视为默认服务）+ scheme + host + port(复用 host/port 字段)。 */
  webName: string;
  webScheme: 'http' | 'https';
}
const EMPTY_OBJ_FORM: ObjFormState = {
  open: false, envId: '', envName: '', objectType: 'db', object: null,
  dbType: 'postgres', syslogAuth: 'key',
  host: '', port: '', dbName: '', user: '', password: '', sshPort: '22', filePath: '', privateKey: '',
  loginUrl: '',
  webName: '', webScheme: 'http',
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
  if (f.objectType === 'web') {
    return {
      ...(f.webName.trim() ? { name: f.webName.trim() } : {}),
      scheme: f.webScheme,
      host: f.host.trim(),
      ...(f.port.trim() ? { port: Number(f.port) } : {}),
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
  if (o.objectType === 'web') {
    return [`${p.scheme}://${p.host}`, p.port != null ? String(p.port) : null].filter(Boolean).join(':');
  }
  return [p.host, p.filePath].filter(Boolean).join(' · ');
}

/** 该对象是否已配置访问凭据：以后端出参的 hasSecret 标志位为准（不再依赖反向解析被 mask 的 secret）。 */
function objectHasSecret(o: EnvironmentObject): boolean {
  return Boolean(o.hasSecret);
}

export default function EnvironmentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { t } = useTranslation();

  const envsQ = useQuery({
    queryKey: ['environments', projectId],
    queryFn: () => api.environments.list(projectId!),
    enabled: !!projectId,
  });

  const [envForm, setEnvForm] = useState<EnvFormState>(EMPTY_ENV_FORM);
  const [objForm, setObjForm] = useState<ObjFormState>(EMPTY_OBJ_FORM);
  const [confirmEnv, setConfirmEnv] = useState<{ env: Environment; caseCount: number; planCount: number } | null>(null);
  /** 删除对象前一律先弹 modal —— 任何引用计数都是 0 也要点确认才走请求。 */
  const [confirmObj, setConfirmObj] = useState<{ id: string; label: string } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['environments', projectId] });

  const saveEnv = useMutation({
    mutationFn: () => {
      const name = envForm.name.trim();
      return envForm.mode === 'create'
        ? api.environments.create(projectId!, { name })
        : api.environments.patch(envForm.id!, { name });
    },
    onSuccess: () => {
      toast(envForm.mode === 'create' ? t('environments:created') : t('environments:updated'), 'success');
      setEnvForm(EMPTY_ENV_FORM);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const setDefault = useMutation({
    mutationFn: (id: string) => api.environments.patch(id, { isDefault: true }),
    onSuccess: () => {
      toast(t('environments:defaultUpdated'), 'success');
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const removeEnv = useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: boolean }) =>
      api.environments.remove(id, { confirm }),
    onSuccess: (r, vars) => {
      // 后端返回 requiresConfirm 时,前端弹二次确认 modal 显示引用计数;否则 done。
      if (r.requiresConfirm) {
        const env = envsQ.data?.find((e) => e.id === vars.id);
        if (env) setConfirmEnv({ env, caseCount: r.caseCount ?? 0, planCount: r.planCount ?? 0 });
        return;
      }
      toast(t('environments:deleted'), 'success');
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
      toast(objForm.object ? t('environments:objConfigSaved') : t('environments:objAdded'), 'success');
      setObjForm(EMPTY_OBJ_FORM);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const removeObj = useMutation({
    mutationFn: (id: string) => api.environments.removeObject(id),
    onSuccess: () => {
      toast(t('environments:objDeleted'), 'success');
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
      webName: String(p.name ?? ''),
      webScheme: p.scheme === 'https' ? 'https' : 'http',
    });
  };

  const envs = envsQ.data ?? [];

  return (
    <PageShell>
      <PageShellHeader>
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 self-center">
          <IconButton icon="chevronLeft" title={t('environments:backToProject')} onClick={() => navigate('/')} />
          <h1 className="min-w-0 truncate text-2xl font-medium tracking-tight md:text-3xl">
            {t('environments:title')}
          </h1>
        </div>
        <PageShellActions>
          <Button onClick={() => setEnvForm({ open: true, mode: 'create', id: null, name: '' })}>
            <Icon name="plus" size={14} />
            {t('environments:createEnv')}
          </Button>
        </PageShellActions>
        <PageShellDescription>
          {t('environments:description')}
        </PageShellDescription>
      </PageShellHeader>

      <PageShellContent>
        {envsQ.isLoading ? (
          <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
            <Icon name="loader" size={16} className="animate-spin" />
            <span style={{ marginLeft: 8 }}>{t('environments:loading')}</span>
          </div>
        ) : envsQ.isError ? (
          <div className="text-[13px]" style={{ color: 'var(--destructive)' }}>
            {t('common:loadFailed')}：{(envsQ.error as Error | null)?.message ?? t('common:unknownError')}
          </div>
        ) : envs.length === 0 ? (
          <EmptyState icon="database" title={t('environments:emptyTitle')} description={t('environments:emptyDescription')} />
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
                    {env.createdBy && (
                      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                        {t('environments:createdByWithName', { name: creatorName(env.createdBy) })}
                      </span>
                    )}
                  </div>
                  {env.isDefault && (
                    <span
                      className="text-[10px] font-semibold uppercase px-1.5 py-[1px] rounded"
                      style={{ background: 'var(--primary-soft)', color: 'var(--primary)', letterSpacing: '0.04em' }}
                    >
                      {t('environments:default')}
                    </span>
                  )}
                  <div className="flex-1" />
                  <div className="flex items-center gap-1">
                    <IconButton
                      icon="star"
                      title={env.isDefault ? t('environments:alreadyDefaultEnv') : t('environments:setDefaultEnv')}
                      onClick={() => setDefault.mutate(env.id)}
                      disabled={env.isDefault}
                    />
                    <IconButton icon="pencil" title={t('environments:editEnv')} onClick={() => setEnvForm({ open: true, mode: 'edit', id: env.id, name: env.name })} />
                    <IconButton
                      icon="trash"
                      title={t('environments:deleteEnv')}
                      tone="destructive"
                      onClick={() => setConfirmEnv({ env, caseCount: 0, planCount: 0 })}
                    />
                  </div>
                </div>
                <div className="px-3 py-2 flex flex-col">
                  {env.objects.length === 0 && (
                    <div className="text-[12px] py-1" style={{ color: 'var(--muted-foreground)' }}>
                      {t('environments:emptyObjects')}
                    </div>
                  )}
                  {env.objects.map((o) => (
                    <div
                      key={o.id}
                      className="flex items-center gap-3 py-1.5 hairline-top"
                      style={{ borderColor: 'var(--muted)' }}
                    >
                      <Icon
                        name={o.objectType === 'db' ? 'database' : o.objectType === 'login' ? 'user' : o.objectType === 'web' ? 'globe' : 'terminal'}
                        size={12}
                        style={{ color: 'var(--muted-foreground)', flexShrink: 0 }}
                      />
                      <span className="text-[12px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                        {o.objectType === 'db' ? t('environments:objTypes.db') : o.objectType === 'login' ? t('environments:objTypes.login') : o.objectType === 'web' ? t('environments:objTypes.web') : 'syslog'}
                        {o.label ? ` · ${o.label}` : ''}
                      </span>
                      {o.isDefault && (
                        <span
                          className="text-[10px] px-1.5 py-[1px] rounded"
                          style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
                        >
                          {t('environments:default')}
                        </span>
                      )}
                      <span className="text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>
                        {objectSummary(o) || t('environments:notFilled')}
                      </span>
                      {objectHasSecret(o) ? (
                        <span
                          className="text-[10px] px-1.5 py-[1px] rounded"
                          style={{
                            background: 'var(--success-soft, rgba(16, 185, 129, 0.12))',
                            color: 'var(--success, #16a34a)',
                          }}
                          title={t('environments:secretStoredTooltip')}
                        >
                          {t('environments:configured')}
                        </span>
                      ) : (
                        <span
                          className="text-[10px] px-1.5 py-[1px] rounded"
                          style={{
                            background: 'var(--warning-soft, rgba(234, 179, 8, 0.12))',
                            color: 'var(--warning, #ca8a04)',
                          }}
                          title={t('environments:noSecretTooltip')}
                        >
                          {t('environments:notConfigured')}
                        </span>
                      )}
                      <div className="flex-1" />
                      <div className="flex items-center gap-1">
                        <IconButton icon="pencil" title={t('environments:editObj')} onClick={() => openObjForm(env, o.objectType, o)} />
                        <IconButton
                          icon="trash"
                          title={t('environments:deleteObj')}
                          tone="destructive"
                          onClick={() => setConfirmObj({ id: o.id, label: `${o.objectType === 'db' ? t('environments:objTypes.db') : o.objectType === 'login' ? t('environments:objTypes.login') : o.objectType === 'web' ? t('environments:objTypes.web') : 'syslog'}${o.label ? ` · ${o.label}` : ''}` })}
                        />
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
                      {t('environments:objTypes.db')}
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
                      {t('environments:objTypes.login')}
                    </button>
                    <button
                      type="button"
                      onClick={() => openObjForm(env, 'web', null)}
                      className="flex items-center gap-1.5 text-[12px]"
                      style={{ background: 'transparent', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}
                    >
                      <Icon name="globe" size={12} />
                      {t('environments:objTypes.web')}
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
            <DialogTitle>{envForm.mode === 'create' ? t('environments:createEnv') : t('environments:editEnv')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input
              label={t('environments:form.nameLabel')}
              placeholder={t('environments:form.namePlaceholder')}
              value={envForm.name}
              onChange={(e) => setEnvForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top" style={{ borderColor: 'var(--border)' }}>
            <Button variant="ghost" onClick={() => setEnvForm(EMPTY_ENV_FORM)}>{t('common:cancel')}</Button>
            <Button disabled={!envForm.name.trim() || saveEnv.isPending} onClick={() => saveEnv.mutate()}>
              {saveEnv.isPending ? t('environments:saving') : t('common:save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 对象（DB / syslog）编辑弹窗 */}
      <Dialog open={objForm.open} onOpenChange={(open) => setObjForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(objForm.object ? 'environments:form.modeEdit' : 'environments:form.modeAdd')}{objForm.objectType === 'db' ? ` ${t('environments:objTypes.db')}` : objForm.objectType === 'login' ? ` ${t('environments:objTypes.login')}` : objForm.objectType === 'web' ? ` ${t('environments:objTypes.web')}` : ' syslog'} · {objForm.envName}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 px-5 py-4 overflow-y-auto flex flex-col gap-3">
            {objForm.objectType === 'db' ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('environments:form.dbTypeLabel')}</label>
                  <Segmented
                    value={objForm.dbType}
                    onChange={(v) => setObjForm((f) => ({ ...f, dbType: v }))}
                    options={[
                      { value: 'postgres', label: 'PostgreSQL' },
                      { value: 'mysql', label: 'MySQL' },
                    ]}
                  />
                </div>
                <Input label={t('environments:form.dbHost')} value={objForm.host} onChange={(e) => setObjForm((f) => ({ ...f, host: e.target.value }))} placeholder="db.example.com" />
                <Input label={t('environments:form.dbPort')} value={objForm.port} onChange={(e) => setObjForm((f) => ({ ...f, port: e.target.value }))} placeholder={objForm.dbType === 'mysql' ? '3306' : '5432'} />
                <Input label={t('environments:form.dbName')} value={objForm.dbName} onChange={(e) => setObjForm((f) => ({ ...f, dbName: e.target.value }))} />
                <Input label={t('environments:form.dbUser')} value={objForm.user} onChange={(e) => setObjForm((f) => ({ ...f, user: e.target.value }))} />
                <Input
                  label={t('environments:form.dbPassword')}
                  type="password"
                  value={objForm.password}
                  onChange={(e) => setObjForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder={objForm.object ? t('environments:form.leaveBlankModify') : t('environments:form.leaveBlankUnset')}
                />
              </>
            ) : objForm.objectType === 'login' ? (
              <>
                <Input
                  label={t('environments:form.loginUrl')}
                  value={objForm.loginUrl}
                  onChange={(e) => setObjForm((f) => ({ ...f, loginUrl: e.target.value }))}
                  placeholder={t('environments:form.loginUrlPlaceholder')}
                />
                <Input label={t('environments:form.userName')} value={objForm.user} onChange={(e) => setObjForm((f) => ({ ...f, user: e.target.value }))} />
                <Input
                  label={t('environments:form.password')}
                  type="password"
                  value={objForm.password}
                  onChange={(e) => setObjForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder={objForm.object ? t('environments:form.leaveBlankModify') : t('environments:form.leaveBlankUnset')}
                />
                <p className="text-[11px] m-0" style={{ color: 'var(--muted-foreground)' }}>
                  {t('environments:form.loginHelp')}
                </p>
              </>
            ) : objForm.objectType === 'web' ? (
              <>
                <Input
                  label={t('environments:form.webNameLabel')}
                  value={objForm.webName}
                  onChange={(e) => setObjForm((f) => ({ ...f, webName: e.target.value }))}
                  placeholder={t('environments:form.webNamePlaceholder')}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('environments:form.scheme')}</label>
                  <select
                    className="input-base"
                    value={objForm.webScheme}
                    onChange={(e) => setObjForm((f) => ({ ...f, webScheme: e.target.value as 'http' | 'https' }))}
                  >
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                </div>
                <Input
                  label={t('environments:form.host')}
                  value={objForm.host}
                  onChange={(e) => setObjForm((f) => ({ ...f, host: e.target.value }))}
                  placeholder={t('environments:form.hostPlaceholder')}
                />
                <Input
                  label={t('environments:form.port')}
                  value={objForm.port}
                  onChange={(e) => setObjForm((f) => ({ ...f, port: e.target.value }))}
                  placeholder={t('environments:form.portPlaceholder')}
                />
                <p className="text-[11px] m-0" style={{ color: 'var(--muted-foreground)' }}>
                  {t('environments:form.webHelp')}
                </p>
              </>
            ) : (
              <>
                <Input label={t('environments:form.syslogHost')} value={objForm.host} onChange={(e) => setObjForm((f) => ({ ...f, host: e.target.value }))} placeholder="logs.example.com" />
                <Input label={t('environments:form.syslogUser')} value={objForm.user} onChange={(e) => setObjForm((f) => ({ ...f, user: e.target.value }))} />
                <Input label={t('environments:form.sshPort')} value={objForm.sshPort} onChange={(e) => setObjForm((f) => ({ ...f, sshPort: e.target.value }))} placeholder="22" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('environments:form.authTypeLabel')}</label>
                  <Segmented
                    value={objForm.syslogAuth}
                    onChange={(v) => setObjForm((f) => ({ ...f, syslogAuth: v }))}
                    options={[
                      { value: 'key', label: t('environments:form.sshPrivateKey') },
                      { value: 'password', label: t('environments:form.password') },
                    ]}
                  />
                </div>
                {objForm.syslogAuth === 'password' ? (
                  <Input
                    label={t('environments:form.sshPassword')}
                    type="password"
                    value={objForm.password}
                    onChange={(e) => setObjForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder={objForm.object ? t('environments:form.leaveBlankModify') : t('environments:form.leaveBlankUnset')}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('environments:form.sshPrivateKeyPem')}</label>
                    <textarea
                      className="input-base"
                      rows={6}
                      value={objForm.privateKey}
                      onChange={(e) => setObjForm((f) => ({ ...f, privateKey: e.target.value }))}
                      placeholder={objForm.object ? t('environments:form.leaveBlankModify') : t('environments:form.firstAddFill')}
                    />
                  </div>
                )}
                <Input label={t('environments:form.syslogFilePath')} value={objForm.filePath} onChange={(e) => setObjForm((f) => ({ ...f, filePath: e.target.value }))} placeholder="/var/log/syslog" />
              </>
            )}
          </div>
          <div className="flex items-center gap-2 px-5 py-3 hairline-top shrink-0" style={{ borderColor: 'var(--border)' }}>
            {objForm.objectType !== 'login' && objForm.objectType !== 'web' && (
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
                  {testConn.isPending ? t('environments:testing') : t('common:testConnection')}
                </Button>
                {testConn.isPending && (
                  <span className="text-[12px] min-w-0 break-words" style={{ color: 'var(--muted-foreground)' }}>{t('environments:connecting')}</span>
                )}
                {testConn.isSuccess && testConn.data.ok && (
                  <span className="text-[12px] min-w-0 break-words" style={{ color: 'var(--success)' }}>{t('common:connected')} · {testConn.data.latencyMs}ms</span>
                )}
                {testConn.isSuccess && !testConn.data.ok && (
                  <span className="text-[12px] min-w-0 break-words" style={{ color: 'var(--destructive)' }}>{t('common:testConnectionFailed')}：{testConn.data.error}</span>
                )}
              </>
            )}
            <div className="flex-1" />
            <Button variant="ghost" className="shrink-0" onClick={() => setObjForm(EMPTY_OBJ_FORM)} disabled={saveObj.isPending}>{t('common:cancel')}</Button>
            <Button className="shrink-0" disabled={saveObj.isPending} onClick={() => saveObj.mutate()}>
              {saveObj.isPending ? t('environments:saving') : objForm.object ? t('common:save') : t('environments:form.modeAdd')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除环境确认:前端一律先弹 modal,再发请求;后端 requiresConfirm 作为双保险保留。 */}
      <Dialog open={!!confirmEnv} onOpenChange={(open) => { if (!open) setConfirmEnv(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('environments:deleteEnv')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('environments:deleteConfirmPrefix', { name: confirmEnv?.env.name })}{confirmEnv && (confirmEnv.caseCount > 0 || confirmEnv.planCount > 0)
              ? t('environments:deleteConfirmReferenced', { caseCount: confirmEnv.caseCount, planCount: confirmEnv.planCount })
              : t('environments:deleteConfirmUnreferenced')}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top" style={{ borderColor: 'var(--border)' }}>
            <Button variant="ghost" onClick={() => setConfirmEnv(null)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
              disabled={removeEnv.isPending}
              onClick={() => confirmEnv && removeEnv.mutate({ id: confirmEnv.env.id, confirm: true })}
            >
              {removeEnv.isPending ? t('environments:deleting') : t('environments:confirmDelete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    {/* 删除对象确认弹窗 —— 不论引用计数,先弹再发请求,避免误点。 */}
      <Dialog open={!!confirmObj} onOpenChange={(open) => { if (!open) setConfirmObj(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('environments:deleteObj')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('environments:objDeleteConfirm', { label: confirmObj?.label })}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top" style={{ borderColor: 'var(--border)' }}>
            <Button variant="ghost" onClick={() => setConfirmObj(null)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
              disabled={removeObj.isPending}
              onClick={() => {
                if (!confirmObj) return;
                removeObj.mutate(confirmObj.id);
                setConfirmObj(null);
              }}
            >
              {removeObj.isPending ? t('environments:deleting') : t('environments:confirmDelete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
