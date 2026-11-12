/**
 * SkillFilesDialog: a single skill's file tree editor (tree on the left, content on the right).
 *
 * Essential difference from the old "SKILL.md body + flat script list" form: a skill is a real directory tree
 * (the official skill-creator has five kinds: agents/ references/ assets/ eval-viewer/ scripts/),
 * which the old flat form simply cannot hold.
 *
 * Three hard constraints (all from the server, not invented here):
 *  - **No creating directories**: uploads can only land in [existing] directories; the directory structure comes from import.
 *  - All paths are addressed by skill id; the server resolves the directory name from the DB row — the client doesn't pass it, and shouldn't.
 *  - Server disk is the source of truth for content: saving writes a single file, never overwrites the directory wholesale.
 */
import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localizeApiError } from '../../../i18n';
import { api, type AssistantSkill } from '../../../api/client';
import { useUIStore } from '../../../stores/ui';
import Icon from '../../Icon';
import Button from '../../ui/Button';
import IconButton from '../../ui/IconButton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/Modal';
import { buildTree, uploadDirOf, type SkillTreeNode } from './skillTree';

/** Reading text: binary / oversized files that fail to read into text are rejected outright — no silent fallback. */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsText(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function NodeRow({
  node, depth, selectedPath, onSelect,
}: {
  node: SkillTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (n: SkillTreeNode) => void;
}) {
  const active = node.path === selectedPath;
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(node)}
        className="flex items-center gap-1.5 w-full text-left rounded px-1.5 py-1 text-[12px] min-w-0"
        style={{
          paddingLeft: 6 + depth * 12,
          color: active ? 'var(--primary)' : node.kind === 'dir' ? 'var(--foreground)' : 'var(--muted-foreground)',
          background: active ? 'var(--primary-soft)' : 'transparent',
          fontWeight: node.kind === 'dir' ? 500 : 400,
        }}
      >
        <Icon name={node.kind === 'dir' ? 'folder' : 'file'} size={12} className="shrink-0" />
        <span className="truncate">{node.name}</span>
        {node.kind === 'file' && (
          <span className="ml-auto text-[10px] shrink-0" style={{ color: 'var(--muted-foreground)' }}>
            {formatBytes(node.size)}
          </span>
        )}
      </button>
      {node.kind === 'dir' && node.children.map((c) => (
        <NodeRow key={c.path} node={c} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
    </>
  );
}

export default function SkillFilesDialog({
  skill, onClose,
}: {
  skill: AssistantSkill;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<SkillTreeNode | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const skillId = skill.id;
  const treeKey = ['assistant-skill-tree', skillId];
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: treeKey });
    void qc.invalidateQueries({ queryKey: ['assistant-skills'] });
  };

  const treeQ = useQuery({
    queryKey: treeKey,
    queryFn: () => api.assistant.skills.tree(skillId!),
    enabled: !!skillId,
  });

  // Fetch the body only when a file is selected; not for directories (the server only allows reading files).
  const fileQ = useQuery({
    queryKey: ['assistant-skill-file', skillId, selected?.path],
    queryFn: () => api.assistant.skills.readFile(skillId!, selected!.path),
    enabled: !!skillId && !!selected && selected.kind === 'file',
  });

  const save = useMutation({
    mutationFn: (path: string) => api.assistant.skills.writeFile(skillId!, path, draft),
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      setDraft('');
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const del = useMutation({
    mutationFn: (path: string) => api.assistant.skills.deleteFile(skillId!, path),
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      setConfirmDelete(false);
      setSelected(null);
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const upload = useMutation({
    mutationFn: (files: Array<{ path: string; content: string }>) =>
      api.assistant.skills.uploadFiles(skillId!, uploadDirOf(selected), files),
    onSuccess: () => {
      toast(t('settings:saved'), 'success');
      invalidate();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const payload: Array<{ path: string; content: string }> = [];
    for (const f of Array.from(files)) {
      try {
        payload.push({ path: f.name, content: await readFileAsText(f) });
      } catch {
        toast(`${f.name} ${t('settings:skillUploadFail')}`, 'error');
      }
    }
    if (payload.length > 0) upload.mutate(payload);
    if (fileInput.current) fileInput.current.value = '';
  };

  const tree = buildTree(treeQ.data ?? []);
  const isFile = selected?.kind === 'file';
  const dirty = isFile && draft !== '' && draft !== (fileQ.data?.content ?? '');

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      {/* DialogContent's base style carries sm:max-w-lg; writing only max-w-3xl gets overridden by the sm variant (512px),
          so the sm: breakpoint must be overridden explicitly. The file tree editor needs tree-left + content-right side by side, width proportional to the viewport;
          height locks at 85vh and grid rows squeeze the content area into the remaining space — otherwise a fixed minHeight pushes the footer
          close bar out of the viewport (the dialog scrolls on its own and the user never sees save/close). */}
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] sm:max-w-[min(1200px,calc(100vw-2rem))] sm:h-[85vh] sm:grid-rows-[auto_minmax(0,1fr)_auto] sm:overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('settings:skillFiles', { name: skill.name })}</DialogTitle>
        </DialogHeader>

        <div className="flex gap-3 px-5 py-1 min-h-0">
          {/* Left: file tree (height follows the dialog content row, scrolls itself) */}
          <div
            className="w-56 shrink-0 overflow-auto border rounded p-1 flex flex-col min-h-0"
            style={{ borderColor: 'var(--border)' }}
          >
            <div className="flex items-center gap-1 mb-1 px-1">
              <span className="text-[11px] font-semibold flex-1" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:skillFilesIntro')}
              </span>
              <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => onPick(e.target.files)} />
              <IconButton
                icon="upload"
                title={t('settings:skillUploadInto', { dir: uploadDirOf(selected) || '/' })}
                onClick={() => fileInput.current?.click()}
              />
            </div>
            {treeQ.isLoading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                <Icon name="loader" size={12} className="animate-spin" />
                {t('common:loading')}
              </div>
            ) : tree.length === 0 ? (
              <div className="px-2 py-3 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('settings:skillFileEmpty')}
              </div>
            ) : (
              tree.map((node) => (
                <NodeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  selectedPath={selected?.path ?? null}
                  onSelect={(n) => {
                    setConfirmDelete(false);
                    setDraft('');
                    setSelected(n);
                  }}
                />
              ))
            )}
            <p className="text-[10px] mt-2 px-1 m-0" style={{ color: 'var(--muted-foreground)' }}>
              {t('settings:skillUploadHint')}
            </p>
          </div>

          {/* Right: file content */}
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            {!selected ? (
              <div
                className="flex-1 flex items-center justify-center text-[12px] rounded border"
                style={{ borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}
              >
                {t('settings:skillFileSelectFirst')}
              </div>
            ) : !isFile ? (
              <div
                className="flex-1 flex flex-col gap-2 rounded border p-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>{selected.path}</div>
                <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                  {t('settings:skillFileIsDir')}
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium flex-1 truncate" style={{ color: 'var(--foreground)' }}>
                    {selected.path}
                    {selected.runtime && (
                      <span className="ml-2 text-[10px] px-1.5 py-[1px] rounded" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                        {selected.runtime}
                      </span>
                    )}
                  </span>
                  {fileQ.data?.truncated && (
                    <span className="text-[10px]" style={{ color: 'var(--destructive)' }}>
                      {t('settings:skillFileTruncated')}
                    </span>
                  )}
                  <IconButton
                    icon="trash"
                    tone="destructive"
                    title={t('settings:skillFileDeleteConfirm', { name: selected.name })}
                    onClick={() => setConfirmDelete(true)}
                  />
                </div>
                <textarea
                  className="input-base flex-1 min-h-[280px]"
                  style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
                  value={draft !== '' ? draft : (fileQ.data?.content ?? '')}
                  disabled={fileQ.isLoading}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!dirty}
                    onClick={() => setDraft('')}
                  >
                    {t('common:cancel')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!dirty || save.isPending}
                    onClick={() => save.mutate(selected.path)}
                  >
                    {save.isPending ? t('common:saving') : t('settings:skillFileSave')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Delete confirmation: deleting a single file is irreversible, and parent directories are not deleted recursively */}
        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('settings:skillFileDeleteConfirm', { name: selected?.name })}</DialogTitle>
            </DialogHeader>
            <div className="flex justify-end gap-2 px-5 py-4">
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('common:cancel')}</Button>
              <Button
                variant="danger"
                disabled={del.isPending}
                onClick={() => selected && del.mutate(selected.path)}
              >
                {t('common:delete')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <div className="flex justify-end gap-2 px-5 py-4 hairline-top" style={{ borderColor: 'var(--border)' }}>
          <Button variant="ghost" onClick={onClose}>{t('common:close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
