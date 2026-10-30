import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../i18n';
import { api, type AssistantMcpServer } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Toggle from '../ui/Toggle';
import IconButton from '../ui/IconButton';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';
import SkillsSection from './skills/SkillsSection';
import FeedbackSection from './FeedbackSection';

/** MCP_EXPOSURES 与服务端 mcp.js 同源白名单（oauth 服务端不支持）。 */
const EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden'] as const;

// ---------- MCP ----------

interface McpForm {
  open: boolean;
  id: string | null;
  name: string;
  kind: 'stdio' | 'http';
  command: string;
  args: string;
  url: string;
  exposure: (typeof EXPOSURES)[number];
  enabled: boolean;
}
const EMPTY_MCP: McpForm = {
  open: false, id: null, name: '', kind: 'stdio', command: '', args: '', url: '',
  exposure: 'codemode', enabled: true,
};

function McpServersSection() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['assistant-mcp-servers'] });
  const listQ = useQuery({ queryKey: ['assistant-mcp-servers'], queryFn: api.assistant.mcpServers.list });
  const [form, setForm] = useState<McpForm>(EMPTY_MCP);
  const [deleting, setDeleting] = useState<AssistantMcpServer | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        kind: form.kind,
        exposure: form.exposure,
        enabled: form.enabled,
        ...(form.kind === 'stdio'
          ? { command: form.command.trim(), args: form.args.split('\n').map((s) => s.trim()).filter(Boolean) }
          : { url: form.url.trim() }),
      };
      return form.id
        ? api.assistant.mcpServers.patch(form.id, body)
        : api.assistant.mcpServers.create(body);
    },
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      setForm(EMPTY_MCP);
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.assistant.mcpServers.remove(id),
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      setDeleting(null);
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.assistant.mcpServers.patch(id, { enabled }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const rows = listQ.data ?? [];

  return (
    <div className="bg-card border rounded-[var(--radius-sm)]">
      <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
        <Icon name="plug" size={14} style={{ color: 'var(--primary)' }} />
        <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:mcpTitle')}
        </h3>
        <Button size="sm" onClick={() => setForm({ ...EMPTY_MCP, open: true })}>
          <Icon name="plus" size={12} />
          {t('settings:mcpCreate')}
        </Button>
      </div>
      <div className="px-4 pt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:mcpIntro')}
      </div>
      <div className="p-2">
        {listQ.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
            {t('common:loading')}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="plug" title={t('settings:mcpNone')} compact />
        ) : (
          rows.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-2 py-2">
              <span className="text-[12px] font-medium min-w-0 truncate" style={{ color: 'var(--foreground)' }}>{s.name}</span>
              <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                {s.kind}
              </span>
              <span className="text-[11px] truncate flex-1 text-right" style={{ color: 'var(--muted-foreground)' }}>
                {s.kind === 'stdio' ? s.command : s.url}
              </span>
              <Toggle checked={s.enabled} onChange={(v) => toggle.mutate({ id: s.id, enabled: v })} />
              <IconButton
                icon="pencil"
                title={t('settings:mcpEdit')}
                onClick={() => setForm({
                  open: true, id: s.id, name: s.name, kind: s.kind,
                  command: s.command ?? '', args: (s.args ?? []).join('\n'), url: s.url ?? '',
                  exposure: s.exposure as (typeof EXPOSURES)[number],
                  enabled: s.enabled,
                })}
              />
              <IconButton icon="trash" tone="destructive" title={t('common:delete')} onClick={() => setDeleting(s)} />
            </div>
          ))
        )}
      </div>

      <Dialog open={form.open} onOpenChange={(open) => setForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form.id ? t('settings:mcpEdit') : t('settings:mcpCreate')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input
              label={t('settings:mcpName')}
              value={form.name}
              placeholder={t('settings:mcpNamePlaceholder')}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('settings:mcpKind')}</label>
              <select
                className="input-base"
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as 'stdio' | 'http' }))}
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
              </select>
            </div>
            {form.kind === 'stdio' ? (
              <>
                <Input
                  label={t('settings:mcpCommand')}
                  value={form.command}
                  placeholder={t('settings:mcpCommandPlaceholder')}
                  onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('settings:mcpArgs')}</label>
                  <textarea
                    className="input-base"
                    rows={3}
                    value={form.args}
                    onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  />
                </div>
              </>
            ) : (
              <Input
                label={t('settings:mcpUrl')}
                value={form.url}
                placeholder={t('settings:mcpUrlPlaceholder')}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('settings:mcpExposure')}</label>
              <select
                className="input-base"
                value={form.exposure}
                onChange={(e) => setForm((f) => ({ ...f, exposure: e.target.value as (typeof EXPOSURES)[number] }))}
              >
                {EXPOSURES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Toggle checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
              <span style={{ fontSize: 12, color: 'var(--foreground)' }}>{t('settings:mcpEnabled')}</span>
            </div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top sticky bottom-0 bg-popover rounded-b-lg" style={{ borderColor: 'var(--border)' }}>
            <Button variant="ghost" onClick={() => setForm(EMPTY_MCP)}>{t('common:cancel')}</Button>
            <Button disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? t('common:saving') : t('common:save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('settings:mcpDeleteConfirm', { name: deleting?.name })}</DialogTitle></DialogHeader>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setDeleting(null)}>{t('common:cancel')}</Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              {t('common:delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AssistantPanel() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div>
        <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:panelAssistant')}
        </h3>
        <p className="text-[12px] mb-4" style={{ color: 'var(--muted-foreground)' }}>
          {t('settings:assistantIntro')}
        </p>
      </div>
      <McpServersSection />
      <SkillsSection />
      <FeedbackSection />
    </div>
  );
}