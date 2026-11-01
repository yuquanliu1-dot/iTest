import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../i18n';
import { api, type PromptModule, type PromptModuleVersion } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';

const GROUPS: Array<PromptModule['group']> = ['main', 'tool', 'skill'];
const GROUP_KEY: Record<PromptModule['group'], string> = {
  main: 'promptGroupMain', tool: 'promptGroupTool', skill: 'promptGroupSkill',
};

function sourceBadgeKey(t: ReturnType<typeof useTranslation>['t'], m: PromptModule): string {
  if (m.isDefault) return t(`settings:promptSourceDefault`);
  const map: Record<string, string> = {
    manual_edit: 'promptSourceManual', rollback: 'promptSourceRollback',
    baseline: 'promptSourceBaseline', solidify_apply: 'promptSourceSolidify',
  };
  return t(`settings:${map[m.source ?? ''] ?? 'promptSourceManual'}`);
}

/** 设置页「系统提示词」：模块分组列表 + 编辑抽屉（skill 只读）+ 版本历史抽屉（回滚/恢复默认）。 */
export default function PromptModulesSection() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const listQ = useQuery({ queryKey: ['prompt-modules'], queryFn: () => api.assistant.promptModules.list() });
  const [editing, setEditing] = useState<PromptModule | null>(null);
  const [draft, setDraft] = useState('');
  const [versionsOf, setVersionsOf] = useState<PromptModule | null>(null);
  const [pickedSeq, setPickedSeq] = useState<number | null>(null);

  const versionsQ = useQuery({
    queryKey: ['prompt-module-versions', versionsOf?.key],
    queryFn: () => api.assistant.promptModules.versions(versionsOf!.key),
    enabled: !!versionsOf,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['prompt-modules'] });
    qc.invalidateQueries({ queryKey: ['prompt-module-versions', versionsOf?.key] });
  };

  const save = useMutation({
    mutationFn: (args: { key: string; body: { value?: string | null; fromSeq?: number } }) =>
      api.assistant.promptModules.setValue(args.key, args.body),
    onSuccess: () => { toast(t('settings:promptSaved'), 'success'); setEditing(null); invalidate(); },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const modules = listQ.data ?? [];
  const versions = versionsQ.data ?? [];
  const picked = versions.find((v) => v.seq === pickedSeq) ?? null;
  const isSkill = editing?.group === 'skill';

  return (
    <div className="bg-card border rounded-[var(--radius-sm)]">
      <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
        <Icon name="terminal" size={14} style={{ color: 'var(--primary)' }} />
        <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:promptTitle')}
        </h3>
      </div>
      <div className="px-4 pt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:promptIntro')}
      </div>
      <div className="p-2">
        {listQ.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
            {t('common:loading')}
          </div>
        ) : modules.length === 0 ? (
          <EmptyState icon="terminal" title={t('settings:promptNoModules')} compact />
        ) : (
          GROUPS.map((g) => {
            const rows = modules.filter((m) => m.group === g);
            if (rows.length === 0) return null;
            return (
              <div key={g} className="mb-2">
                <div className="px-2 pt-2 pb-1 text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                  {t(`settings:${GROUP_KEY[g]}`)}
                </div>
                {rows.map((m) => (
                  <div key={m.key} className="flex items-center gap-3 px-2 py-2">
                    <div className="flex flex-col min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-medium truncate" style={{ color: 'var(--foreground)' }}>{m.label}</span>
                        <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                          {sourceBadgeKey(t, m)}
                        </span>
                      </div>
                      <span className="text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>{m.key}</span>
                    </div>
                    <Button
                      variant="ghost"
                      onClick={() => { setEditing(m); setDraft(m.text); }}
                    >
                      {t(m.group === 'skill' ? 'settings:promptView' : 'settings:promptEdit')}
                    </Button>
                    <Button variant="ghost" onClick={() => { setVersionsOf(m); setPickedSeq(null); }}>
                      {t('settings:promptVersions')}
                    </Button>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* 编辑/查看抽屉：skill 组只读 + 回磁盘回滚提示；代码默认组可恢复默认（写 NULL 行） */}
      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `${editing.label}（${editing.key}）` : ''}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-3 flex flex-col gap-2">
            {isSkill && (
              <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:promptSkillReadonlyHint')}
              </div>
            )}
            <textarea
              className="input-base font-mono text-[12px]"
              style={{ minHeight: 240, resize: 'vertical' }}
              value={draft}
              readOnly={isSkill}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            {!isSkill && (
              <Button
                variant="ghost"
                disabled={save.isPending || editing?.isDefault}
                title={editing?.isDefault ? t('settings:promptValuePlaceholder') : undefined}
                onClick={() => editing && window.confirm(t('settings:promptRestoreDefaultConfirm'))
                  && save.mutate({ key: editing.key, body: { value: null } })}
              >
                {t('settings:promptRestoreDefault')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(null)}>{t('common:close')}</Button>
            {!isSkill && (
              <Button
                variant="primary"
                disabled={save.isPending}
                onClick={() => editing && save.mutate({ key: editing.key, body: { value: draft } })}
              >
                {t('common:save')}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 版本历史抽屉：选中行与当前值并排对照（全文 diff）；回滚=fromSeq（skill 组同时写回磁盘） */}
      <Dialog open={!!versionsOf} onOpenChange={(open) => { if (!open) setVersionsOf(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{versionsOf ? `${versionsOf.label} · ${t('settings:promptVersions')}` : ''}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-3 flex flex-col gap-3">
            <div className="max-h-56 overflow-y-auto flex flex-col gap-1">
              {versions.length === 0 ? (
                <div className="text-[12px] py-2" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:promptValuePlaceholder')}
                </div>
              ) : versions.map((v: PromptModuleVersion) => (
                <button
                  key={v.seq}
                  type="button"
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-left"
                  style={{ background: pickedSeq === v.seq ? 'var(--primary-soft)' : 'transparent' }}
                  onClick={() => setPickedSeq(v.seq)}
                >
                  <span className="text-[11px] font-mono" style={{ color: 'var(--foreground)' }}>
                    {t('settings:promptVersionLabel', { seq: v.seq })}
                  </span>
                  <span className="text-[10px] px-1.5 py-[1px] rounded" style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {sourceBadgeKey(t, { source: v.source, isDefault: v.value == null } as PromptModule)}
                  </span>
                  <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
            {picked && (
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                    {t('settings:promptCurrentLabel', { name: versionsOf?.label ?? '' })}
                  </div>
                  <pre className="m-0 p-2 rounded text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto"
                    style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {versionsOf?.text || t('settings:promptValuePlaceholder')}
                  </pre>
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                    {t('settings:promptVersionLabel', { seq: picked.seq })}
                  </div>
                  <pre className="m-0 p-2 rounded text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto"
                    style={{ background: 'var(--muted)', color: 'var(--foreground)' }}>
                    {picked.value ?? t('settings:promptValuePlaceholder')}
                  </pre>
                </div>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setVersionsOf(null)}>{t('common:close')}</Button>
            <Button
              variant="primary"
              disabled={!picked || picked.value == null || save.isPending}
              onClick={() => versionsOf && picked && window.confirm(t('settings:promptRollbackConfirm', { seq: picked.seq }))
                && save.mutate({ key: versionsOf.key, body: { fromSeq: picked.seq } })}
            >
              {t('settings:promptRollback')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
