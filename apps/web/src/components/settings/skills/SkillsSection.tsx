/**
 * SkillsSection: global skill list + metadata editing + file tree entry.
 *
 * After the 2026-10-19 storage flip this component manages [metadata only]: the body and directory tree live on the server at
 * SKILLS_ROOT/<name>/, edited by SkillFilesDialog; this component no longer has body/scripts forms.
 *
 * create only produces a SKILL.md skeleton (empty shell); real content arrives via import_skill or the file tree editor —
 * the form states this explicitly, otherwise users finish creating and believe the skill is installed when new sessions actually see it empty.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../../i18n';
import { api, type AssistantSkill } from '../../../api/client';
import { useUIStore } from '../../../stores/ui';
import Icon from '../../Icon';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Toggle from '../../ui/Toggle';
import IconButton from '../../ui/IconButton';
import EmptyState from '../../ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/Modal';
import SkillFilesDialog from './SkillFilesDialog';

/** Slug validation mirrors the backend's isSafeSkillName: lowercase letters/digits/hyphens only, no leading/trailing -, no consecutive --, ≤64.
 *  The server still validates (assertSkillName); this is just earlier feedback. */
function isSafeSkillName(name: string): boolean {
  return (
    /^[a-z0-9-]+$/.test(name)
    && name.length <= 64
    && !name.startsWith('-')
    && !name.endsWith('-')
    && !name.includes('--')
  );
}

interface SkillForm {
  open: boolean;
  id: string | null;
  name: string;
  description: string;
  enabled: boolean;
}
const EMPTY_SKILL: SkillForm = {
  open: false, id: null, name: '', description: '', enabled: true,
};

export default function SkillsSection() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['assistant-skills'] });
  const listQ = useQuery({ queryKey: ['assistant-skills'], queryFn: api.assistant.skills.list });
  const [form, setForm] = useState<SkillForm>(EMPTY_SKILL);
  const [deleting, setDeleting] = useState<AssistantSkill | null>(null);
  const [filesFor, setFilesFor] = useState<AssistantSkill | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        description: form.description.trim(),
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
    // Orphan directories have id=null and can't reach the :id endpoint; the two paths merge into one mutation so callers needn't care.
    mutationFn: (s: AssistantSkill) =>
      s.id ? api.assistant.skills.remove(s.id) : api.assistant.skills.removeOrphan(s.name),
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

  const rows = listQ.data ?? [];
  const saveEnabled = !!form.name.trim()
    && isSafeSkillName(form.name.trim())
    && !!form.description.trim();

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
          rows.map((s) => {
            // Extract into a local const instead of `s.id &&` inline in JSX: the narrowed result can't be carried into the closure, TS still reports string|null.
            const id = s.unregistered ? null : s.id;
            return (
            <div key={s.id ?? s.name} className="flex items-center gap-3 px-2 py-2">
              <span className="text-[12px] font-medium min-w-0 truncate" style={{ color: 'var(--foreground)' }}>{s.name}</span>
              {s.unregistered ? (
                // Orphan directory: exists on disk, no DB row. Without a description it can't enter the catalog either,
                // so only delete is offered — never "adopt" here, otherwise metadata would be fabricated for directories with no provenance.
                <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--destructive)', color: 'var(--background)' }}>
                  {t('settings:skillUnregistered')}
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-[1px] rounded shrink-0" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                  {t('settings:skillFileCount', { count: s.fileCount })}
                </span>
              )}
              <span className="text-[11px] truncate flex-1 text-right" style={{ color: 'var(--muted-foreground)' }}>
                {s.description || t('settings:skillNoDescription')}
              </span>
              {id && (
                <>
                  <Toggle checked={s.enabled} onChange={(v) => toggle.mutate({ id, enabled: v })} />
                  <IconButton
                    icon="pencil"
                    title={t('settings:skillsEdit')}
                    onClick={() => setForm({
                      open: true, id, name: s.name,
                      description: s.description, enabled: s.enabled,
                    })}
                  />
                  <IconButton
                    icon="folder"
                    title={t('settings:skillManageFiles')}
                    onClick={() => setFilesFor(s)}
                  />
                </>
              )}
              <IconButton icon="trash" tone="destructive" title={t('common:delete')} onClick={() => setDeleting(s)} />
            </div>
            );
          })
        )}
      </div>

      {/* Metadata form: name/description/enabled only, no body */}
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
            <div className="flex items-center gap-2">
              <Toggle checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
              <span style={{ fontSize: 12, color: 'var(--foreground)' }}>{t('settings:skillEnabled')}</span>
            </div>
            <p className="text-[11px] m-0" style={{ color: 'var(--muted-foreground)' }}>
              {t('settings:skillCreateIsSkeleton')}
            </p>
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 hairline-top sticky bottom-0 bg-popover rounded-b-lg" style={{ borderColor: 'var(--border)' }}>
            <Button variant="ghost" onClick={() => setForm(EMPTY_SKILL)}>{t('common:cancel')}</Button>
            <Button disabled={!saveEnabled || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? t('common:saving') : t('common:save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* File tree editor */}
      {filesFor && <SkillFilesDialog skill={filesFor} onClose={() => setFilesFor(null)} />}

      <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('settings:skillDeleteConfirm', { name: deleting?.name })}</DialogTitle></DialogHeader>
          <p className="px-5 text-[12px] m-0" style={{ color: 'var(--muted-foreground)' }}>
            {t('settings:skillDeleteAlsoDir')}
          </p>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setDeleting(null)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting)}
            >
              {t('common:delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
