import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../i18n';
import { api, type LlmChannelView } from '../../api/client';
import { useUIStore } from '../../stores/ui';
import Icon from '../Icon';
import Button from '../ui/Button';
import Input from '../ui/Input';
import IconButton from '../ui/IconButton';
import EmptyState from '../ui/EmptyState';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';

const PROVIDERS = ['openai', 'anthropic', 'google'];

/** Kept in sync with the server-side fallback defaults in apps/api/src/agent/llm-client.ts. */
const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-2.0-flash',
};

/** Local channel draft: empty apiKey means keep the server's stored value (the server merges and preserves by id). */
interface ChannelDraft {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  maxTokens: string;
  apiKey: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  isNew: boolean;
}

function toDraft(c: LlmChannelView): ChannelDraft {
  return {
    id: c.id,
    name: c.name,
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl ?? '',
    maxTokens: c.maxTokens != null ? String(c.maxTokens) : '',
    apiKey: '',
    apiKeyMasked: c.apiKeyMasked,
    hasApiKey: c.hasApiKey,
    isNew: false,
  };
}

function newDraft(): ChannelDraft {
  return {
    id: crypto.randomUUID(),
    name: '',
    provider: 'openai',
    model: '',
    baseUrl: '',
    maxTokens: '',
    apiKey: '',
    apiKeyMasked: '',
    hasApiKey: false,
    isNew: true,
  };
}

/** Probe request body: existing channels omit apiKey (the server resolves the real value by channelId); new channels use the key from the form. */
function probeBody(d: ChannelDraft) {
  return d.apiKey.trim()
    ? { provider: d.provider, apiKey: d.apiKey.trim(), model: d.model.trim(), baseUrl: d.baseUrl.trim() }
    : { channelId: d.id, provider: d.provider, model: d.model.trim(), baseUrl: d.baseUrl.trim() };
}

/** maxTokens validation: empty = unlimited; must be a positive integer (matches the server's zod positive, otherwise PUT always 400s). */
function maxTokensInvalid(v: string): boolean {
  const s = v.trim();
  return s !== '' && (!/^\d+$/.test(s) || Number(s) < 1);
}

/** Save payload: channel list + default/vision assignment (shared by the edit dialog save and the panel-bottom save). */
interface ChannelsPayload {
  channels: ChannelDraft[];
  defaultChannelId: string;
  visionChannelId: string | null;
}

export default function LlmChannelsPanel() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();

  const viewQ = useQuery({ queryKey: ['settings-llm'], queryFn: api.settings.llm });

  const [channels, setChannels] = useState<ChannelDraft[]>([]);
  const [defaultId, setDefaultId] = useState('');
  const [visionId, setVisionId] = useState('');
  const [form, setForm] = useState<{ open: boolean; draft: ChannelDraft | null }>({ open: false, draft: null });
  const [deleting, setDeleting] = useState<ChannelDraft | null>(null);

  // Server data → local drafts (invalidate re-syncs after a successful save; the masked apiKey is never backfilled as plaintext)
  useEffect(() => {
    if (!viewQ.data) return;
    setChannels(viewQ.data.channels.map(toDraft));
    setDefaultId(viewQ.data.defaultChannelId);
    setVisionId(viewQ.data.visionChannelId ?? '');
  }, [viewQ.data]);

  const save = useMutation({
    mutationFn: (p: ChannelsPayload) =>
      api.settings.putLlm({
        defaultChannelId: p.defaultChannelId,
        visionChannelId: p.visionChannelId,
        channels: p.channels.map((c) => ({
          id: c.id,
          name: c.name.trim(),
          provider: c.provider,
          model: c.model.trim(),
          ...(c.baseUrl.trim() ? { baseUrl: c.baseUrl.trim() } : {}),
          ...(c.maxTokens.trim() ? { maxTokens: Number(c.maxTokens.trim()) } : {}),
          ...(c.apiKey.trim() ? { apiKey: c.apiKey.trim() } : {}),
        })),
      }),
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      qc.invalidateQueries({ queryKey: ['settings-llm'] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // Row-level test connection: the result goes through a toast
  const rowTest = useMutation({
    mutationFn: (d: ChannelDraft) => api.settings.testConnection(probeBody(d)),
    onSuccess: (r) => {
      if (r.ok) toast(t('settings:testOk', { latencyMs: r.latencyMs ?? 0 }), 'success');
      else toast(t('settings:testFail', { error: r.error ?? '' }), 'error');
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // Test connection inside the edit dialog: the result shows in place
  const formTest = useMutation({
    mutationFn: (d: ChannelDraft) => api.settings.testConnection(probeBody(d)),
  });

  const openCreate = () => setForm({ open: true, draft: newDraft() });
  const openEdit = (c: ChannelDraft) => setForm({ open: true, draft: { ...c } });

  // Dialog save = persist immediately: previously it only mutated the local draft list without a request; after a refresh everything reverted, and the renamed list made users believe it had saved.
  // The local list syncs only after the PUT succeeds (on failure the list keeps its old values and never shows unpersisted changes).
  const applyForm = () => {
    const d = form.draft;
    if (!d) return;
    if (!d.name.trim() || !d.model.trim()) return;
    if (d.isNew && !d.apiKey.trim()) return;
    if (maxTokensInvalid(d.maxTokens)) return;
    const next = channels.some((c) => c.id === d.id)
      ? channels.map((c) => (c.id === d.id ? d : c))
      : [...channels, d];
    const nextDefaultId = defaultId || d.id;
    setForm({ open: false, draft: null });
    save.mutate(
      { channels: next, defaultChannelId: nextDefaultId, visionChannelId: visionId || null },
      {
        onSuccess: () => {
          setChannels(next);
          setDefaultId(nextDefaultId);
        },
      },
    );
  };

  const removeDraft = (d: ChannelDraft) => {
    setChannels((prev) => prev.filter((c) => c.id !== d.id));
    setDeleting(null);
  };

  const requestDelete = (c: ChannelDraft) => {
    if (c.id === defaultId) {
      toast(t('settings:channelRemoveDefaultError'), 'error');
      return;
    }
    if (c.id === visionId) {
      toast(t('settings:channelRemoveVisionError'), 'error');
      return;
    }
    setDeleting(c);
  };

  const anyMaxTokensInvalid = channels.some((c) => maxTokensInvalid(c.maxTokens));

  const draft = form.draft;

  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <div>
        <h3 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--foreground)' }}>
          {t('settings:llmProvider')}
        </h3>
        <p className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('settings:llmIntro')}
        </p>
      </div>

      {/* Default / vision channel assignment */}
      <div className="bg-card border rounded-[var(--radius-sm)] p-3 flex flex-col gap-3">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>
            {t('settings:defaultChannelLabel')}
          </label>
          <select
            className="input-base"
            value={defaultId}
            disabled={channels.length === 0}
            onChange={(e) => setDefaultId(e.target.value)}
          >
            {channels.length === 0 && <option value="">{t('settings:channelNone')}</option>}
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('settings:defaultChannelHelp')}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>
            {t('settings:visionChannelLabel')}
          </label>
          <select
            className="input-base"
            value={visionId}
            disabled={channels.length === 0}
            onChange={(e) => setVisionId(e.target.value)}
          >
            <option value="">{t('settings:visionFollowDefault')}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('settings:visionChannelHelp')}
          </p>
        </div>
      </div>

      {/* Channel list */}
      <div className="bg-card border rounded-[var(--radius-sm)]">
        <div className="flex items-center gap-2 px-4 py-3 hairline-bottom" style={{ borderColor: 'var(--border)' }}>
          <Icon name="beaker" size={14} style={{ color: 'var(--primary)' }} />
          <h3 className="text-[14px] font-semibold m-0 flex-1" style={{ color: 'var(--foreground)' }}>
            {t('settings:channelListTitle')}
          </h3>
          <Button size="sm" onClick={openCreate}>
            <Icon name="plus" size={12} />
            {t('settings:channelAdd')}
          </Button>
        </div>
        <div className="p-2">
          {viewQ.isLoading ? (
            <div className="flex items-center gap-2 px-2 py-4 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              <Icon name="loader" size={14} className="animate-spin" />
              {t('common:loading')}
            </div>
          ) : channels.length === 0 ? (
            <EmptyState icon="beaker" title={t('settings:channelNone')} compact />
          ) : (
            channels.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-2 py-2">
                <span className="text-[12px] font-medium min-w-0 truncate" style={{ color: 'var(--foreground)' }}>
                  {c.name}
                </span>
                {c.id === defaultId && (
                  <span
                    className="text-[10px] px-1.5 py-[1px] rounded shrink-0"
                    style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
                  >
                    {t('settings:channelDefaultBadge')}
                  </span>
                )}
                {c.id === visionId && (
                  <span
                    className="text-[10px] px-1.5 py-[1px] rounded shrink-0"
                    style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}
                  >
                    {t('settings:channelVisionBadge')}
                  </span>
                )}
                <span className="text-[11px] truncate flex-1 text-right" style={{ color: 'var(--muted-foreground)' }}>
                  {c.provider} · {c.model}
                </span>
                <IconButton
                  icon="activity"
                  title={t('settings:testConnection')}
                  onClick={() => rowTest.mutate(c)}
                />
                <IconButton icon="pencil" title={t('settings:channelEdit')} onClick={() => openEdit(c)} />
                <IconButton icon="trash" tone="destructive" title={t('common:delete')} onClick={() => requestDelete(c)} />
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          disabled={save.isPending || channels.length === 0 || anyMaxTokensInvalid}
          onClick={() =>
            save.mutate({ channels, defaultChannelId: defaultId, visionChannelId: visionId || null })
          }
        >
          {save.isPending ? t('settings:saving') : t('common:save')}
        </Button>
        {anyMaxTokensInvalid && (
          <span className="text-[12px]" style={{ color: 'var(--destructive)' }}>
            {t('settings:maxTokensInvalid')}
          </span>
        )}
      </div>

      {/* Channel edit dialog */}
      <Dialog open={form.open} onOpenChange={(open) => setForm((f) => ({ ...f, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.isNew ? t('settings:channelAdd') : t('settings:channelEdit')}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="flex flex-col gap-3 px-5 py-4">
              <Input
                label={t('settings:channelName')}
                value={draft.name}
                placeholder={t('settings:channelNamePlaceholder')}
                onChange={(e) => setForm((f) => ({ ...f, draft: { ...draft, name: e.target.value } }))}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>
                  {t('settings:llmProvider')}
                </label>
                <select
                  className="input-base"
                  value={draft.provider}
                  onChange={(e) => setForm((f) => ({ ...f, draft: { ...draft, provider: e.target.value } }))}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Input
                  type="password"
                  label={t('settings:channelApiKey')}
                  placeholder="sk-..."
                  value={draft.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, draft: { ...draft, apiKey: e.target.value } }))}
                />
                <p className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                  {draft.hasApiKey
                    ? `${t('settings:channelApiKeySaved', { masked: draft.apiKeyMasked })} · ${t('settings:channelApiKeyKeep')}`
                    : t('settings:channelApiKeyKeep')}
                </p>
              </div>
              <div>
                <Input
                  label={t('settings:baseUrlLabel')}
                  placeholder={t('settings:baseUrlPlaceholder')}
                  value={draft.baseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, draft: { ...draft, baseUrl: e.target.value } }))}
                />
                <p className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:baseUrlHelp')}
                </p>
              </div>
              <div>
                <Input
                  label={t('settings:channelModelLabel')}
                  placeholder={t('settings:modelPlaceholder')}
                  value={draft.model}
                  onChange={(e) => setForm((f) => ({ ...f, draft: { ...draft, model: e.target.value } }))}
                />
                {DEFAULT_MODELS[draft.provider] && (
                  <p className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                    {t('settings:defaultModel', { model: DEFAULT_MODELS[draft.provider] })}
                  </p>
                )}
              </div>
              <div>
                <Input
                  label={t('settings:maxTokensLabel')}
                  placeholder={t('settings:maxTokensPlaceholder')}
                  type="number"
                  min={1}
                  value={draft.maxTokens}
                  onChange={(e) => setForm((f) => ({ ...f, draft: { ...draft, maxTokens: e.target.value } }))}
                />
                <p className="text-[11px] mt-1" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:maxTokensHelp')}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  disabled={formTest.isPending}
                  onClick={() => formTest.mutate(draft)}
                >
                  {formTest.isPending ? t('settings:testing') : t('settings:testConnection')}
                </Button>
                {formTest.isSuccess && formTest.data.ok && (
                  <span className="text-[12px]" style={{ color: 'var(--success)' }}>
                    {t('settings:testOk', { latencyMs: formTest.data.latencyMs ?? 0 })}
                  </span>
                )}
                {formTest.isSuccess && !formTest.data.ok && (
                  <span className="text-[12px]" style={{ color: 'var(--destructive)' }}>
                    {t('settings:testFail', { error: formTest.data.error ?? '' })}
                  </span>
                )}
              </div>
            </div>
          )}
          <div
            className="flex justify-end gap-2 px-5 py-4 hairline-top sticky bottom-0 bg-popover rounded-b-lg"
            style={{ borderColor: 'var(--border)' }}
          >
            <Button variant="ghost" onClick={() => setForm({ open: false, draft: null })}>
              {t('common:cancel')}
            </Button>
            <Button
              disabled={
                !draft ||
                !draft.name.trim() ||
                !draft.model.trim() ||
                (draft.isNew && !draft.apiKey.trim()) ||
                maxTokensInvalid(draft.maxTokens)
              }
              onClick={applyForm}
            >
              {t('common:save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings:channelDeleteConfirm', { name: deleting?.name })}</DialogTitle>
          </DialogHeader>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('common:cancel')}
            </Button>
            <Button variant="danger" onClick={() => deleting && removeDraft(deleting)}>
              {t('common:delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
