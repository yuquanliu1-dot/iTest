import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';
import { api, type ProjectVersion } from '../../api/client';

export interface RefFormState {
  open: boolean;
  projectId: string;
  version: ProjectVersion | null;
}

export const EMPTY_REF_FORM: RefFormState = { open: false, projectId: '', version: null };

/** 版本 ref 编辑弹窗：refKind 单选 + ref 下拉（按 kind 调 /refs）。
 *  ProjectsHome 与 VersionsSelectPage 共用此弹窗。 */
export default function RefEditDialog({
  state,
  onClose,
  onSubmit,
  saving,
}: {
  state: RefFormState;
  onClose: () => void;
  onSubmit: (ref: string | null, refKind: 'branch' | 'tag' | null) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const v = state.version;
  const [refKind, setRefKind] = useState<'branch' | 'tag' | null>(v?.refKind ?? 'branch');
  const [refValue, setRefValue] = useState<string>(v?.ref ?? '');
  const [refs, setRefs] = useState<string[]>([]);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [loadingRefs, setLoadingRefs] = useState(false);

  const loadRefs = async (kind: 'branch' | 'tag') => {
    if (!state.projectId) return;
    setLoadingRefs(true);
    setRefsError(null);
    try {
      const r = await api.versions.listRefs(state.projectId, kind);
      setRefs(r.refs);
      if (r.error) setRefsError(r.error);
    } catch (e) {
      setRefsError((e as Error).message);
    } finally {
      setLoadingRefs(false);
    }
  };

  return (
    <Dialog open={state.open} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('projects:refEdit.title', { name: v?.name ?? '' })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setRefKind('branch'); loadRefs('branch'); }}
              className="px-3 py-1 rounded text-[12px]"
              style={{
                background: refKind === 'branch' ? 'var(--primary-soft)' : 'var(--card)',
                color: refKind === 'branch' ? 'var(--primary)' : 'var(--foreground)',
                border: '1px solid var(--border)',
              }}
            >
              {t('projects:refEdit.branch')}
            </button>
            <button
              type="button"
              onClick={() => { setRefKind('tag'); loadRefs('tag'); }}
              className="px-3 py-1 rounded text-[12px]"
              style={{
                background: refKind === 'tag' ? 'var(--primary-soft)' : 'var(--card)',
                color: refKind === 'tag' ? 'var(--primary)' : 'var(--foreground)',
                border: '1px solid var(--border)',
              }}
            >
              {t('projects:refEdit.tag')}
            </button>
          </div>
          {refKind && (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium" style={{ color: 'var(--muted-foreground)' }}>
                {t('projects:refEdit.remoteLabel', { refKind })}
              </label>
              {loadingRefs ? (
                <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                  {t('common:loading')}
                </span>
              ) : refsError ? (
                <div className="flex flex-col gap-1">
                  <span className="text-[11px]" style={{ color: 'var(--destructive)' }}>
                    {refsError}
                  </span>
                  <Input
                    placeholder={t('projects:refEdit.manualPlaceholder')}
                    value={refValue}
                    onChange={(e) => setRefValue(e.target.value)}
                  />
                </div>
              ) : refs.length === 0 ? (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" onClick={() => loadRefs(refKind)}>{t('projects:refEdit.refetch')}</Button>
                  <Input
                    placeholder={t('projects:refEdit.manualPlaceholder')}
                    value={refValue}
                    onChange={(e) => setRefValue(e.target.value)}
                  />
                </div>
              ) : (
                <select
                  className="input-base"
                  value={refValue}
                  onChange={(e) => setRefValue(e.target.value)}
                >
                  <option value="">{t('projects:refEdit.none')}</option>
                  {refs.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              )}
            </div>
          )}
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="text-[11px]"
              style={{ background: 'transparent', border: 'none', color: 'var(--muted-foreground)', cursor: 'pointer' }}
              onClick={() => { setRefKind(null); setRefValue(''); }}
            >
              {t('projects:refEdit.clearRef')}
            </button>
          </div>
        </div>
        <div
          className="flex justify-end gap-2 px-5 py-4 hairline-top"
          style={{ borderColor: 'var(--border)' }}
        >
          <Button variant="ghost" onClick={onClose}>{t('common:cancel')}</Button>
          <Button
            disabled={saving || (refKind !== null && !refValue.trim())}
            onClick={() => onSubmit(refKind ? refValue.trim() : null, refKind)}
          >
            {saving ? t('cases:saving') : t('common:save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}