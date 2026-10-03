import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Environment } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';

interface Props {
  open: boolean;
  projectId: string;
  versionId: string;
  versionName: string;
  onClose: () => void;
}

/** syslog 配置弹窗：syslog 字段独立编辑。
 *  该版本没有 env 时 → 「创建环境」入口（默认名 "default"）；否则 → 表单直编。 */
export default function VersionSyslogConfigDialog({ open, projectId, versionId, versionName, onClose }: Props) {
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const envsQ = useQuery({
    queryKey: ['environments', projectId, versionId],
    queryFn: () => api.environments.list(projectId, { versionId }),
    enabled: open && !!projectId && !!versionId,
  });
  const env: Environment | undefined = envsQ.data?.[0];

  const [name, setName] = useState('default');
  const [syslogHost, setSyslogHost] = useState('');
  const [syslogUser, setSyslogUser] = useState('');
  const [syslogSshPort, setSyslogSshPort] = useState('22');
  const [syslogKey, setSyslogKey] = useState('');
  const [syslogFilePath, setSyslogFilePath] = useState('');

  useEffect(() => {
    if (!open) return;
    if (!env) {
      setName('default');
      setSyslogHost('');
      setSyslogUser('');
      setSyslogSshPort('22');
      setSyslogKey('');
      setSyslogFilePath('');
      return;
    }
    setName(env.name);
    setSyslogHost(env.syslogHost ?? '');
    setSyslogUser(env.syslogUser ?? '');
    setSyslogSshPort(env.syslogSshPort != null ? String(env.syslogSshPort) : '22');
    setSyslogFilePath(env.syslogFilePath ?? '');
    setSyslogKey('');
  }, [open, env?.id]);

  const create = useMutation({
    mutationFn: () =>
      api.environments.create(projectId, {
        name: name.trim() || 'default',
        versionId,
        syslogHost: syslogHost.trim() || undefined,
        syslogUser: syslogUser.trim() || undefined,
        syslogSshPort: syslogSshPort.trim() ? Number(syslogSshPort) : undefined,
        syslogKey: syslogKey || undefined,
        syslogFilePath: syslogFilePath.trim() || undefined,
      }),
    onSuccess: () => {
      toast('环境已创建', 'success');
      qc.invalidateQueries({ queryKey: ['environments', projectId] });
      qc.invalidateQueries({ queryKey: ['versions', projectId] });
      onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const save = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof api.environments.patch>[1] = {
        name: name.trim() || env?.name || 'default',
        syslogHost: syslogHost.trim() || undefined,
        syslogUser: syslogUser.trim() || undefined,
        syslogSshPort: syslogSshPort.trim() ? Number(syslogSshPort) : undefined,
        syslogFilePath: syslogFilePath.trim() || undefined,
      };
      if (syslogKey) body.syslogKey = syslogKey;
      return api.environments.patch(env!.id, body);
    },
    onSuccess: () => {
      toast('syslog 配置已保存', 'success');
      qc.invalidateQueries({ queryKey: ['environments', projectId] });
      onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const submitting = create.isPending || save.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>syslog 配置 · {versionName}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 px-5 py-4 overflow-y-auto flex flex-col gap-3">
          {envsQ.isLoading ? (
            <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
              <Icon name="loader" size={14} className="animate-spin" />
              加载中…
            </div>
          ) : (
            <>
              <Input label="环境名" value={name} onChange={(e) => setName(e.target.value)} placeholder={env ? undefined : 'default'} />
              <Input label="syslog 主机" value={syslogHost} onChange={(e) => setSyslogHost(e.target.value)} placeholder="logs.example.com" />
              <Input label="syslog 用户" value={syslogUser} onChange={(e) => setSyslogUser(e.target.value)} />
              <Input label="SSH 端口" value={syslogSshPort} onChange={(e) => setSyslogSshPort(e.target.value)} placeholder="22" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>
                  SSH 私钥（PEM）
                </label>
                <textarea
                  className="input-base"
                  rows={6}
                  value={syslogKey}
                  onChange={(e) => setSyslogKey(e.target.value)}
                  placeholder={env ? '留空表示不修改' : '首次创建时填写'}
                />
              </div>
              <Input label="syslog 文件路径" value={syslogFilePath} onChange={(e) => setSyslogFilePath(e.target.value)} placeholder="/var/log/syslog" />
            </>
          )}
        </div>
        <div
          className="flex justify-end gap-2 px-5 py-3 hairline-top shrink-0"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <Button variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          {!envsQ.isLoading && (
            <Button
              disabled={submitting || !name.trim()}
              onClick={() => (env ? save.mutate() : create.mutate())}
            >
              {submitting ? '保存中...' : env ? '保存' : '创建'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}