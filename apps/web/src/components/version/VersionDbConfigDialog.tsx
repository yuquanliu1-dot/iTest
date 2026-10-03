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

/** 数据库配置弹窗：DB 字段独立编辑。
 *  该版本没有 env 时 → 「创建环境」入口（默认名 "default"）；否则 → 表单直编。 */
export default function VersionDbConfigDialog({ open, projectId, versionId, versionName, onClose }: Props) {
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const envsQ = useQuery({
    queryKey: ['environments', projectId, versionId],
    queryFn: () => api.environments.list(projectId, { versionId }),
    enabled: open && !!projectId && !!versionId,
  });
  const env: Environment | undefined = envsQ.data?.[0];

  const [name, setName] = useState('default');
  const [dbHost, setDbHost] = useState('');
  const [dbPort, setDbPort] = useState('');
  const [dbName, setDbName] = useState('');
  const [dbUser, setDbUser] = useState('');
  const [dbPassword, setDbPassword] = useState('');

  // 切换版本 / 首次拿到 env 时，把表单同步到现有记录
  useEffect(() => {
    if (!open) return;
    if (!env) {
      setName('default');
      setDbHost('');
      setDbPort('');
      setDbName('');
      setDbUser('');
      setDbPassword('');
      return;
    }
    setName(env.name);
    setDbHost(env.dbHost ?? '');
    setDbPort(env.dbPort != null ? String(env.dbPort) : '');
    setDbName(env.dbName ?? '');
    setDbUser(env.dbUser ?? '');
    setDbPassword('');
  }, [open, env?.id]);

  const create = useMutation({
    mutationFn: () =>
      api.environments.create(projectId, {
        name: name.trim() || 'default',
        versionId,
        dbHost: dbHost.trim() || undefined,
        dbPort: dbPort.trim() ? Number(dbPort) : undefined,
        dbName: dbName.trim() || undefined,
        dbUser: dbUser.trim() || undefined,
        dbPassword: dbPassword || undefined,
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
        dbHost: dbHost.trim() || undefined,
        dbPort: dbPort.trim() ? Number(dbPort) : undefined,
        dbName: dbName.trim() || undefined,
        dbUser: dbUser.trim() || undefined,
      };
      if (dbPassword) body.dbPassword = dbPassword;
      return api.environments.patch(env!.id, body);
    },
    onSuccess: () => {
      toast('数据库配置已保存', 'success');
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
          <DialogTitle>数据库配置 · {versionName}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 px-5 py-4 overflow-y-auto flex flex-col gap-3">
          {envsQ.isLoading ? (
            <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
              <Icon name="loader" size={14} className="animate-spin" />
              加载中…
            </div>
          ) : !env ? (
            <>
              <div className="text-[12px]" style={{ color: 'var(--color-foreground-muted)' }}>
                该版本尚未配置测试环境。点击下方「创建」即会同时创建环境与填写数据库字段。
              </div>
              <Input label="环境名" value={name} onChange={(e) => setName(e.target.value)} placeholder="default" />
              <Input label="数据库主机" value={dbHost} onChange={(e) => setDbHost(e.target.value)} placeholder="db.example.com" />
              <Input label="数据库端口" value={dbPort} onChange={(e) => setDbPort(e.target.value)} placeholder="3306" />
              <Input label="数据库名" value={dbName} onChange={(e) => setDbName(e.target.value)} />
              <Input label="数据库用户" value={dbUser} onChange={(e) => setDbUser(e.target.value)} />
              <Input label="数据库密码" type="password" value={dbPassword} onChange={(e) => setDbPassword(e.target.value)} placeholder="留空表示不设置" />
            </>
          ) : (
            <>
              <Input label="环境名" value={name} onChange={(e) => setName(e.target.value)} />
              <Input label="数据库主机" value={dbHost} onChange={(e) => setDbHost(e.target.value)} placeholder="db.example.com" />
              <Input label="数据库端口" value={dbPort} onChange={(e) => setDbPort(e.target.value)} placeholder="3306" />
              <Input label="数据库名" value={dbName} onChange={(e) => setDbName(e.target.value)} />
              <Input label="数据库用户" value={dbUser} onChange={(e) => setDbUser(e.target.value)} />
              <Input label="数据库密码" type="password" value={dbPassword} onChange={(e) => setDbPassword(e.target.value)} placeholder="留空表示不修改" />
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