/**
 * SkillFilesDialog：单个技能的文件树编辑器（左树右文）。
 *
 * 与旧「SKILL.md 正文 + 平级脚本列表」表单的本质差别：技能是一个真实的目录树
 * （官方 skill-creator 有 agents/ references/ assets/ eval-viewer/ scripts/ 五类），
 * 旧的扁平表单根本装不下它们。
 *
 * 三条硬约束（都来自服务端，不是这里发明的）：
 *  - **不提供新建目录**：上传只能落进【已存在】的目录，目录结构来自 import。
 *  - 所有路径以 skill id 定位，服务端从 DB 行解析目录名，客户端不传也不该传。
 *  - 内容以服务端磁盘为真源：保存只写单个文件，不整体覆盖目录。
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

/** 读文本：二进制/超大文件读不进 text 直接拒绝，不静默降级。 */
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

  // 选中文件才拉正文；选中目录不拉（服务端只允许读文件）。
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
      {/* DialogContent 基础样式带 sm:max-w-lg，只写 max-w-3xl 会被 sm 变体盖掉（512px），
          必须显式覆盖 sm: 断点。文件树编辑器要左树+右文并排，按视口比例给宽；
          高度锁 85vh 并用 grid 行把内容区压进剩余空间——否则固定 minHeight 会把底部
          关闭栏挤出视口（弹窗自身滚动，用户看不到保存/关闭）。 */}
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] sm:max-w-[min(1200px,calc(100vw-2rem))] sm:h-[85vh] sm:grid-rows-[auto_minmax(0,1fr)_auto] sm:overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('settings:skillFiles', { name: skill.name })}</DialogTitle>
        </DialogHeader>

        <div className="flex gap-3 px-5 py-1 min-h-0">
          {/* 左：文件树（高度跟随弹窗内容行，自身滚动） */}
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

          {/* 右：文件内容 */}
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

        {/* 删除确认：删单个文件是不可逆的，且父目录不递归删 */}
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
