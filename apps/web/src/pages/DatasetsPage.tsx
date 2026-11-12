import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Creator, type DatasetMaskedCell, type DatasetSaveBody, type DatasetSummary } from '../api/client';
import Icon from '../components/Icon';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import { useUIStore } from '../stores/ui';
import { fullDateTime } from '../lib/format';
import { creatorName } from '../lib/creatorName';

type Masked = DatasetMaskedCell;
type DraftCell = string | Masked;
interface DraftRow { disabled: boolean; cells: Record<string, DraftCell> }
interface DraftColumn { name: string; sensitive: boolean; renamedFrom?: string }
interface Draft {
  id?: string;
  name: string;
  description: string;
  columns: DraftColumn[];
  rows: DraftRow[];
  createdBy?: Creator | null;
}

const emptyDraft: Draft = { name: '', description: '', columns: [{ name: 'col1', sensitive: false }], rows: [{ disabled: false, cells: {} }] };

const isMasked = (v: unknown): v is Masked => typeof v === 'object' && v !== null && (v as Masked).__masked === true;

export default function DatasetsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const { t } = useTranslation();
  const { data: list, isLoading } = useQuery({
    queryKey: ['datasets', projectId],
    queryFn: () => api.datasets.list(projectId!),
    enabled: !!projectId,
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DatasetSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadDetail = useMutation({
    mutationFn: (id: string) => api.datasets.get(projectId!, id),
    onSuccess: (d) => {
      setDraft({
        id: d.id,
        name: d.name,
        description: d.description ?? '',
        columns: d.columns.map((c) => ({ name: c.name, sensitive: c.sensitive })),
        rows: d.rows.map((r) => ({ disabled: r.disabled, cells: { ...r.cells } })),
        createdBy: d.createdBy ?? null,
      });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const renames: Record<string, string> = {};
      for (const c of d.columns) {
        if (c.renamedFrom && c.renamedFrom !== c.name) renames[c.renamedFrom] = c.name;
      }
      const body: DatasetSaveBody = {
        name: d.name,
        description: d.description.trim() || null,
        columns: d.columns.map((c) => ({ name: c.name, sensitive: c.sensitive })),
        rows: d.rows.map((r) => ({ disabled: r.disabled, cells: { ...r.cells } })),
        // Rename declaration: when editing an existing dataset, tells the server to re-key the old column ciphertext to the new name (a new dataset has no old ciphertext, so it can be omitted)
        ...(d.id && Object.keys(renames).length > 0 ? { renames } : {}),
      };
      return d.id ? api.datasets.update(projectId!, d.id, body) : api.datasets.create(projectId!, body);
    },
    onSuccess: () => {
      toast(t('datasets:saved'), 'success');
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['datasets', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const remove = useMutation({
    mutationFn: async (target: DatasetSummary) => api.datasets.remove(projectId!, target.id, { confirm: true }),
    onSuccess: (_r, target) => {
      toast(t('datasets:deletedWithName', { name: target.name }), 'success');
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['datasets', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // ---- Editor operations (all local draft changes, one PUT at save time) ----
  const mutate = (fn: (d: Draft) => Draft) => setDraft((prev) => (prev ? fn(prev) : prev));

  const renameColumn = (i: number, name: string) => mutate((d) => {
    const old = d.columns[i]!.name;
    // Reject a rename-to-duplicate for the whole step (column name untouched): a colliding save is already blocked by saveBlocked; if a mid-state were allowed,
    // re-keying cells would overwrite the values of the same-named old column (a sensitive column would effectively lose its ciphertext in the draft, unrecoverable even at save).
    if (name && d.columns.some((c, j) => j !== i && c.name === name)) return d;
    const columns = [...d.columns];
    // renamedFrom remembers the original server-side column name from this editing session (chains through consecutive renames); at save time renames are generated from it,
    // letting the server re-key the old column ciphertext to the new name — otherwise renaming a sensitive column would silently lose its ciphertext.
    columns[i] = { ...columns[i]!, name, renamedFrom: d.columns[i]!.renamedFrom ?? old };
    const rows = d.rows.map((r) => {
      if (!(old in r.cells)) return r;
      const cells: Record<string, DraftCell> = {};
      for (const [k, v] of Object.entries(r.cells)) {
        if (k !== old) cells[k] = v;
      }
      cells[name] = r.cells[old]!;
      return { ...r, cells };
    });
    return { ...d, columns, rows };
  });

  const toggleSensitive = (i: number) => mutate((d) => {
    // Clear the placeholder when toggling sensitive ↔ non-sensitive (the server-side prev rule cannot handle the mid-state of a local draft)
    const col = d.columns[i]!;
    const columns = [...d.columns];
    columns[i] = { ...col, sensitive: !col.sensitive };
    const rows = d.rows.map((r) => {
      if (!(col.name in r.cells)) return r;
      return { ...r, cells: { ...r.cells, [col.name]: '' } };
    });
    return { ...d, columns, rows };
  });

  const removeColumn = (i: number) => mutate((d) => {
    const col = d.columns[i]!;
    return {
      ...d,
      columns: d.columns.filter((_, j) => j !== i),
      rows: d.rows.map((r) => {
        const { [col.name]: _v, ...rest } = r.cells;
        return { ...r, cells: rest };
      }),
    };
  });

  const addColumn = () => mutate((d) => {
    let n = d.columns.length + 1;
    while (d.columns.some((c) => c.name === `col${n}`)) n++;
    return { ...d, columns: [...d.columns, { name: `col${n}`, sensitive: false }] };
  });

  const addRow = () => mutate((d) => ({ ...d, rows: [...d.rows, { disabled: false, cells: {} }] }));
  const removeRow = (i: number) => mutate((d) => ({ ...d, rows: d.rows.filter((_, j) => j !== i) }));
  const setCell = (ri: number, colName: string, value: DraftCell) => mutate((d) => {
    const rows = [...d.rows];
    rows[ri] = { ...rows[ri]!, cells: { ...rows[ri]!.cells, [colName]: value } };
    return { ...d, rows };
  });

  /** Download import template: when editing an existing dataset, pass the current column names to the backend so the template header equals the dataset's current columns. */
  const downloadTemplate = async () => {
    try {
      const blob = await api.datasets.downloadTemplate(
        projectId!,
        draft!.columns.map((c) => c.name.trim()).filter(Boolean),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dataset-template.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(localizeApiError(e as Error), 'error');
    }
  };

  // Excel import: server parses the xlsx → same-named columns are reused (sensitive flag kept), new columns are non-sensitive, rows are appended to the draft; only persisted at save.
  const doImport = useMutation({
    mutationFn: (file: File) => api.datasets.importFile(projectId!, file),
    onSuccess: (payload) => {
      mutate((d) => {
        const columns = [...d.columns];
        for (const c of payload.columns) {
          if (!columns.some((x) => x.name === c.name)) columns.push({ name: c.name, sensitive: false });
        }
        const rows = [...d.rows, ...payload.rows.map((r) => ({ disabled: false, cells: { ...r.cells } }))];
        return { ...d, columns, rows };
      });
      toast(t('datasets:importedRows', { count: payload.rows.length }), 'success');
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const saveBlocked = useMemo(() => {
    if (!draft) return true;
    if (!draft.name.trim()) return true;
    const names = draft.columns.map((c) => c.name.trim());
    return names.some((n) => !n) || new Set(names).size !== names.length;
  }, [draft]);

  if (!projectId) return null;

  // ---- List view ----
  if (!draft) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            <Icon name="chevronLeft" size={12} />
            {t('datasets:backToProjects')}
          </Button>
          <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
          <h1 className="text-[16px] font-semibold" style={{ color: 'var(--foreground)' }}>{t('datasets:title')}</h1>
          <div className="flex-1" />
          <Button onClick={() => setDraft({ ...emptyDraft, rows: [{ disabled: false, cells: {} }] })}>
            <Icon name="plus" size={12} />
            {t('datasets:createDataset')}
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          <div className="bg-card border rounded-[var(--radius-md)] overflow-hidden">
            {isLoading ? (
              <div className="flex items-center justify-center py-10" style={{ color: 'var(--muted-foreground)' }}>
                <Icon name="loader" size={16} className="animate-spin" />
              </div>
            ) : (list ?? []).length === 0 ? (
              <EmptyState
                icon="table"
                title={t('datasets:emptyTitle')}
                description={t('datasets:emptyDescription')}
              />
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="hairline-bottom" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                    <th className="text-left font-medium px-4 py-2">{t('datasets:colName')}</th>
                    <th className="text-left font-medium px-4 py-2">{t('datasets:colCreator')}</th>
                    <th className="text-left font-medium px-4 py-2">{t('datasets:colColumns')}</th>
                    <th className="text-left font-medium px-4 py-2">{t('datasets:colRows')}</th>
                    <th className="text-left font-medium px-4 py-2">{t('datasets:colUpdatedAt')}</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(list ?? []).map((d) => (
                    <tr key={d.id} className="hairline-bottom">
                      <td className="px-4 py-2.5" style={{ color: 'var(--foreground)' }}>
                        <button className="press text-left" onClick={() => loadDetail.mutate(d.id)}>{d.name}</button>
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted-foreground)' }}>
                        {creatorName(d.createdBy)}
                      </td>
                      <td className="px-4 py-2.5 font-mono" style={{ color: 'var(--muted-foreground)' }}>
                        {d.columns.map((c) => c.name + (c.sensitive ? '🔒' : '')).join(', ')}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted-foreground)' }}>
                        {d.enabledRowCount}/{d.rowCount}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted-foreground)' }}>{fullDateTime(d.updatedAt)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(d)}>
                          <Icon name="trash" size={12} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent style={{ maxWidth: 420 }}>
            <DialogHeader><DialogTitle>{t('datasets:delete.title')}</DialogTitle></DialogHeader>
            <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('datasets:delete.confirmPrefix', { name: confirmDelete?.name })}{confirmDelete ? t('datasets:delete.rowsAlsoDeleted', { count: confirmDelete.enabledRowCount }) : ''}
              {t('datasets:delete.unbindSuffix')}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>{t('common:cancel')}</Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => confirmDelete && remove.mutate(confirmDelete)}>
                {remove.isPending ? t('datasets:deleting') : t('datasets:confirmDelete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ---- Editor view ----
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
          <Icon name="chevronLeft" size={12} />
          {t('datasets:backToList')}
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {draft.id ? t('datasets:editDataset') : t('datasets:createDataset')}
        </h1>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={downloadTemplate}>
          <Icon name="download" size={12} />
          {t('datasets:downloadTemplate')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={doImport.isPending}
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="upload" size={12} />
          {doImport.isPending ? t('datasets:importing') : t('datasets:importExcel')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) doImport.mutate(f);
            e.target.value = '';
          }}
        />
        <Button onClick={() => save.mutate(draft)} disabled={saveBlocked || save.isPending}>
          {save.isPending ? t('datasets:saving') : t('common:save')}
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-6">
        <div className="flex flex-col gap-4 max-w-[960px]">
          <div className="flex gap-3">
            <Input label={t('datasets:nameLabel')} value={draft.name} onChange={(e) => mutate((d) => ({ ...d, name: e.target.value }))} className="flex-1" />
            <Input label={t('datasets:descLabel')} value={draft.description} onChange={(e) => mutate((d) => ({ ...d, description: e.target.value }))} className="flex-1" />
          </div>
          {draft.createdBy && (
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('datasets:createdByWithName', { name: creatorName(draft.createdBy) })}
            </p>
          )}
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('datasets:editorHint', { col: '{{列名}}' })}
          </p>

          <div className="bg-card border rounded-[var(--radius-md)] overflow-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ background: 'var(--muted)' }}>
                  <th className="px-3 py-2 w-[70px]">
                    <span className="text-[10px] font-medium" style={{ color: 'var(--muted-foreground)' }}>{t('datasets:colDisabled')}</span>
                  </th>
                  <th className="px-2 py-2 w-[36px]">
                    <span className="text-[10px] font-medium" style={{ color: 'var(--muted-foreground)' }}>#</span>
                  </th>
                  {draft.columns.map((c, ci) => (
                    <th key={ci} className="px-2 py-2 min-w-[160px]">
                      <div className="flex items-center gap-1">
                        <input
                          className="input-base input-sm font-mono"
                          value={c.name}
                          onChange={(e) => renameColumn(ci, e.target.value)}
                        />
                        <label className="flex items-center gap-0.5 text-[10px] cursor-pointer shrink-0" style={{ color: 'var(--muted-foreground)' }} title={t('datasets:sensitiveColTitle')}>
                          <input
                            type="checkbox"
                            checked={c.sensitive}
                            onChange={() => toggleSensitive(ci)}
                            style={{ accentColor: 'var(--primary)' }}
                          />
                          {t('datasets:sensitive')}
                        </label>
                        <button
                          className="press shrink-0"
                          title={t('datasets:deleteColumnTitle')}
                          onClick={() => removeColumn(ci)}
                          disabled={draft.columns.length <= 1}
                          style={{ color: 'var(--destructive)' }}
                        >
                          <Icon name="close" size={10} />
                        </button>
                      </div>
                    </th>
                  ))}
                  <th className="px-2 py-2 w-[40px]">
                    <button className="press" title={t('datasets:addColumnTitle')} onClick={addColumn} style={{ color: 'var(--primary)' }}>
                      <Icon name="plus" size={12} />
                    </button>
                  </th>
                  <th className="px-2 py-2 w-[36px]" />
                </tr>
              </thead>
              <tbody>
                {draft.rows.map((row, ri) => (
                  <tr key={ri} className="hairline-bottom">
                    <td className="px-3 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={row.disabled}
                        onChange={(e) => mutate((d) => {
                          const rows = [...d.rows];
                          rows[ri] = { ...rows[ri]!, disabled: e.target.checked };
                          return { ...d, rows };
                        })}
                        title={t('datasets:disabledRowTitle')}
                        style={{ accentColor: 'var(--warning)' }}
                      />
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{ri + 1}</td>
                    {draft.columns.map((c) => {
                      const cell = row.cells[c.name];
                      return (
                        <td key={c.name} className="px-2 py-1.5">
                          {c.sensitive ? (
                            <input
                              type="password"
                              className="input-base input-sm w-full font-mono"
                              value={isMasked(cell) ? '' : (cell ?? '')}
                              placeholder={isMasked(cell) ? t('datasets:maskedPlaceholder') : ''}
                              onChange={(e) => setCell(ri, c.name, e.target.value)}
                              autoComplete="new-password"
                            />
                          ) : (
                            <input
                              type="text"
                              className="input-base input-sm w-full font-mono"
                              value={typeof cell === 'string' ? cell : ''}
                              onChange={(e) => setCell(ri, c.name, e.target.value)}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td />
                    <td className="px-2 py-1.5 text-center">
                      <button className="press" title={t('datasets:deleteRowTitle')} onClick={() => removeRow(ri)} style={{ color: 'var(--destructive)' }}>
                        <Icon name="close" size={10} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 py-2">
              <Button variant="ghost" size="sm" onClick={addRow}>
                <Icon name="plus" size={12} />
                {t('datasets:addRow')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
