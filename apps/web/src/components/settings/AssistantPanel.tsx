import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../i18n';
import { api, type AssistantMcpServer, type AssistantSkill, type AssistantSkillScript } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Toggle from '../ui/Toggle';
import IconButton from '../ui/IconButton';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';

/** slug 校验与后端 skillsStore.isSafeSkillName 一致（skills loader 兼容：仅小写字母/数字/连字符，
 *  不以 - 开头/结尾，无连续 --，≤64）。 */
function isSafeSkillName(name: string): boolean {
  return (
    /^[a-z0-9-]+$/.test(name)
    && name.length <= 64
    && !name.startsWith('-')
    && !name.endsWith('-')
    && !name.includes('--')
  );
}

/** MCP_EXPOSURES 与服务端 mcp.js 同源白名单（oauth 服务端不支持）。 */
const EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden'] as const;

/** 按文件名扩展名推断 runtime 与 read_skill/run_skill_script 的推断同源。 */
function runtimeOfFilename(filename: string): AssistantSkillScript['runtime'] {
  if (filename.endsWith('.js')) return 'node';
  if (filename.endsWith('.py')) return 'python3';
  if (filename.endsWith('.sh')) return 'bash';
  return 'sh';
}

/** 文件读取：读不进 text 的脚本（超大/二进制）直接拒绝，不静默降级。 */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsText(file);
  });
}

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
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top" style={{ borderColor: 'var(--border)' }}>
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

// ---------- Skills ----------

interface SkillForm {
  open: boolean;
  id: string | null;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  scripts: AssistantSkillScript[];
}
const EMPTY_SKILL: SkillForm = {
  open: false, id: null, name: '', description: '', body: '', enabled: true, scripts: [],
};

function SkillsSection() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['assistant-skills'] });
  const listQ = useQuery({ queryKey: ['assistant-skills'], queryFn: api.assistant.skills.list });
  const [form, setForm] = useState<SkillForm>(EMPTY_SKILL);
  const [deleting, setDeleting] = useState<AssistantSkill | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        description: form.description.trim(),
        body: form.body.trim(),
        scripts: form.scripts,
        enabled: form.enabled,
      };
      return form.id
        ? api.assistant.skills.patch(form.id, body)
        : api.assistant.skills.create(body);
    },
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      setForm(EMPTY_SKILL);
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.assistant.skills.remove(id),
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      setDeleting(null);
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.assistant.skills.patch(id, { enabled }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // 文件上传：读文本后按文件名校验安全文件名并推断 runtime。
  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added: AssistantSkillScript[] = [];
    for (const f of Array.from(files)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(f.name) || f.name.startsWith('.')) {
        toast(`${t('settings:skillScriptFilename')} 非法：${f.name}`, 'error');
        continue;
      }
      try {
        added.push({ filename: f.name, runtime: runtimeOfFilename(f.name), content: await readFileAsText(f) });
      } catch {
        toast(`${f.name} ${t('settings:skillUploadFail')}`, 'error');
      }
    }
    setForm((f) => ({ ...f, scripts: [...f.scripts, ...added] }));
    if (fileInput.current) fileInput.current.value = '';
  };

  const rows = listQ.data ?? [];

  const saveEnabled = form.name.trim() && isSafeSkillName(form.name.trim()) && form.description.trim() && form.body.trim();

  return (
    <div className="bg-card border rounded-[var(--radius-sm)]">
      <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
        <Icon name="terminal" size={14} style={{ color: 'var(--primary)' }} />
        <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:skillsTitle')}
        </h3>
        <Button size="sm" onClick={() => setForm({ ...EMPTY_SKILL, open: true })}>
          <Icon name="plus" size={12} />
          {t('settings:skillsCreate')}
        </Button>
      </div>
      <div className="px-4 pt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        {t('settings:skillsIntro')}
      </div>
      <div className="p-2">
        {listQ.isLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            <Icon name="loader" size={14} className="animate-spin" />
            {t('common:loading')}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="terminal" title={t('settings:skillNone')} compact />
        ) : (
          rows.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-2 py-2">
              <span className="text-[12px] font-medium min-w-0 truncate" style={{ color: 'var(--foreground)' }}>{s.name}</span>
              <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                {t('settings:skillScriptCount', { count: s.scripts.length })}
              </span>
              <span className="text-[11px] truncate flex-1 text-right" style={{ color: 'var(--muted-foreground)' }}>{s.description}</span>
              <Toggle checked={s.enabled} onChange={(v) => toggle.mutate({ id: s.id, enabled: v })} />
              <IconButton
                icon="pencil"
                title={t('settings:skillsEdit')}
                onClick={() => setForm({
                  open: true, id: s.id, name: s.name, description: s.description,
                  body: s.body, enabled: s.enabled, scripts: s.scripts,
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
            <DialogTitle>{form.id ? t('settings:skillsEdit') : t('settings:skillsCreate')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="flex flex-col gap-1">
              <Input
                label={t('settings:skillName')}
                value={form.name}
                placeholder={t('settings:skillNamePlaceholder')}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              {form.name.trim() && !isSafeSkillName(form.name.trim()) && (
                <span className="text-[11px]" style={{ color: 'var(--destructive)' }}>{t('settings:skillNameInvalid')}</span>
              )}
            </div>
            <Input
              label={t('settings:skillDescription')}
              value={form.description}
              placeholder={t('settings:skillDescriptionPlaceholder')}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('settings:skillBody')}</label>
              <textarea
                className="input-base"
                rows={6}
                value={form.body}
                placeholder={t('settings:skillBodyPlaceholder')}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              />
            </div>
            <div className="flex items-center gap-2">
              <Toggle checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
              <span style={{ fontSize: 12, color: 'var(--foreground)' }}>{t('settings:skillEnabled')}</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold flex-1" style={{ color: 'var(--foreground)' }}>{t('settings:skillScripts')}</span>
              <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => onPickFiles(e.target.files)} />
              <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>
                <Icon name="upload" size={12} />
                {t('settings:skillScriptUpload')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setForm((f) => ({ ...f, scripts: [...f.scripts, { filename: '', runtime: 'node', content: '' }] }))}
              >
                <Icon name="plus" size={12} />
                {t('settings:skillScriptAdd')}
              </Button>
            </div>
            <p className="text-[11px] m-0" style={{ color: 'var(--muted-foreground)' }}>
              {t('settings:skillScriptUploadHint')}
            </p>
            {form.scripts.map((s, i) => (
              <div key={i} className="border rounded p-2 flex flex-col gap-2" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2">
                  <input
                    className="input-base"
                    style={{ flex: 1, minWidth: 0 }}
                    value={s.filename}
                    placeholder={t('settings:skillScriptFilename')}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        scripts: f.scripts.map((s, j) => (j === i ? { ...s, filename: e.target.value } : s)),
                      }))
                    }
                  />
                  <select
                    className="input-base shrink-0"
                    value={s.runtime}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        scripts: f.scripts.map((s, j) =>
                          j === i ? { ...s, runtime: e.target.value as AssistantSkillScript['runtime'] } : s,
                        ),
                      }))
                    }
                  >
                    {(['node', 'python3', 'bash', 'sh'] as const).map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <IconButton
                    icon="trash"
                    tone="destructive"
                    title={t('common:delete')}
                    onClick={() => setForm((f) => ({ ...f, scripts: f.scripts.filter((_, j) => j !== i) }))}
                  />
                </div>
                <textarea
                  className="input-base"
                  rows={4}
                  value={s.content}
                  placeholder={t('settings:skillScriptContent')}
                  style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      scripts: f.scripts.map((s, j) => (j === i ? { ...s, content: e.target.value } : s)),
                    }))
                  }
                />
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top" style={{ borderColor: 'var(--border)' }}>
            <Button variant="ghost" onClick={() => setForm(EMPTY_SKILL)}>{t('common:cancel')}</Button>
            <Button disabled={!saveEnabled || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? t('common:saving') : t('common:save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('settings:skillDeleteConfirm', { name: deleting?.name })}</DialogTitle></DialogHeader>
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
    </div>
  );
}