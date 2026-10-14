import { useMemo, useState } from 'react';
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
  const { data: list, isLoading } = useQuery({
    queryKey: ['datasets', projectId],
    queryFn: () => api.datasets.list(projectId!),
    enabled: !!projectId,
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DatasetSummary | null>(null);
  const [tsvOpen, setTsvOpen] = useState(false);
  const [tsvText, setTsvText] = useState('');

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
    onError: (e: Error) => toast(e.message, 'error'),
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
        // 改名声明：编辑已有数据集时让服务端把旧列密文 re-key 到新列名（新建无旧密文，可省略）
        ...(d.id && Object.keys(renames).length > 0 ? { renames } : {}),
      };
      return d.id ? api.datasets.update(projectId!, d.id, body) : api.datasets.create(projectId!, body);
    },
    onSuccess: () => {
      toast('已保存', 'success');
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['datasets', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const remove = useMutation({
    mutationFn: async (target: DatasetSummary) => api.datasets.remove(projectId!, target.id, { confirm: true }),
    onSuccess: (_r, target) => {
      toast(`已删除数据集（${target.name}）`, 'success');
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: ['datasets', projectId] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // ---- 编辑器操作（全部是本地 draft 变更，保存时一次性 PUT） ----
  const mutate = (fn: (d: Draft) => Draft) => setDraft((prev) => (prev ? fn(prev) : prev));

  const renameColumn = (i: number, name: string) => mutate((d) => {
    const old = d.columns[i]!.name;
    // 重名改名整步拒绝（连列名都不改）：撞名保存本就被 saveBlocked 拦住，若允许中间态，
    // cells 重键会把同名旧列的值覆盖掉（敏感列等于在 draft 里丢密文，保存也救不回）。
    if (name && d.columns.some((c, j) => j !== i && c.name === name)) return d;
    const columns = [...d.columns];
    // renamedFrom 记住本次编辑会话里最初的服务端列名（连续改名链式穿透），保存时据此生成 renames，
    // 让服务端把旧列密文 re-key 到新列名 —— 否则敏感列改名会静默丢失密文。
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
    // 敏感↔非敏感切换时清掉占位符（语义交给服务端 prev 规则处理不了本地 draft 的中间态）
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

  /** TSV 粘贴：首行是表头（列名），其余为数据行；已有同名列复用，新列按非敏感创建。 */
  const applyTsv = () => {
    const lines = tsvText.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) {
      toast('至少需要表头 + 1 行数据', 'error');
      return;
    }
    const headers = lines[0]!.split('\t').map((h) => h.trim());
    mutate((d) => {
      const columns = [...d.columns];
      for (const h of headers) {
        if (h && !columns.some((c) => c.name === h)) columns.push({ name: h, sensitive: false });
      }
      const rows = [...d.rows];
      for (const line of lines.slice(1)) {
        const cells: Record<string, DraftCell> = {};
        line.split('\t').forEach((v, i) => {
          if (headers[i]) cells[headers[i]!] = v;
        });
        rows.push({ disabled: false, cells });
      }
      return { ...d, columns, rows };
    });
    setTsvOpen(false);
    setTsvText('');
    toast(`已导入 ${lines.length - 1} 行`, 'success');
  };

  const saveBlocked = useMemo(() => {
    if (!draft) return true;
    if (!draft.name.trim()) return true;
    const names = draft.columns.map((c) => c.name.trim());
    return names.some((n) => !n) || new Set(names).size !== names.length;
  }, [draft]);

  if (!projectId) return null;

  // ---- 列表视图 ----
  if (!draft) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            <Icon name="chevronLeft" size={12} />
            项目列表
          </Button>
          <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
          <h1 className="text-[16px] font-semibold" style={{ color: 'var(--foreground)' }}>数据集</h1>
          <div className="flex-1" />
          <Button onClick={() => setDraft({ ...emptyDraft, rows: [{ disabled: false, cells: {} }] })}>
            <Icon name="plus" size={12} />
            新建数据集
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
                title="暂无数据集"
                description="新建数据集后，在用例执行设置里绑定即可实现数据驱动回放（N 行 = N 次回放）。"
              />
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="hairline-bottom" style={{ background: 'var(--muted)', color: 'var(--muted-foreground)' }}>
                    <th className="text-left font-medium px-4 py-2">名称</th>
                    <th className="text-left font-medium px-4 py-2">创建人</th>
                    <th className="text-left font-medium px-4 py-2">列</th>
                    <th className="text-left font-medium px-4 py-2">行（启用/总数）</th>
                    <th className="text-left font-medium px-4 py-2">更新时间</th>
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
            <DialogHeader><DialogTitle>删除数据集</DialogTitle></DialogHeader>
            <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
              确认删除「{confirmDelete?.name}」？{confirmDelete ? `${confirmDelete.enabledRowCount} 个启用行将一并删除` : ''}
              ，绑定该数据集的用例将自动解绑（回放退回单次执行）。
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>取消</Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => confirmDelete && remove.mutate(confirmDelete)}>
                {remove.isPending ? '删除中...' : '确认删除'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // ---- 编辑器视图 ----
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
          <Icon name="chevronLeft" size={12} />
          返回列表
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <h1 className="text-[16px] font-semibold" style={{ color: 'var(--foreground)' }}>
          {draft.id ? '编辑数据集' : '新建数据集'}
        </h1>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setTsvOpen(true)}>
          <Icon name="upload" size={12} />
          从 Excel 粘贴
        </Button>
        <Button onClick={() => save.mutate(draft)} disabled={saveBlocked || save.isPending}>
          {save.isPending ? '保存中...' : '保存'}
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-6">
        <div className="flex flex-col gap-4 max-w-[960px]">
          <div className="flex gap-3">
            <Input label="名称" value={draft.name} onChange={(e) => mutate((d) => ({ ...d, name: e.target.value }))} className="flex-1" />
            <Input label="描述（可选）" value={draft.description} onChange={(e) => mutate((d) => ({ ...d, description: e.target.value }))} className="flex-1" />
          </div>
          {draft.createdBy && (
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              创建人 {creatorName(draft.createdBy)}
            </p>
          )}
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            列名即回放变量名（{'{{列名}}'}），须字母/下划线开头。敏感列加密存储，报告与详情中显示为掩码。禁用行回放时跳过。
          </p>

          <div className="bg-card border rounded-[var(--radius-md)] overflow-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ background: 'var(--muted)' }}>
                  <th className="px-3 py-2 w-[70px]">
                    <span className="text-[10px] font-medium" style={{ color: 'var(--muted-foreground)' }}>禁用</span>
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
                        <label className="flex items-center gap-0.5 text-[10px] cursor-pointer shrink-0" style={{ color: 'var(--muted-foreground)' }} title="敏感列加密存储">
                          <input
                            type="checkbox"
                            checked={c.sensitive}
                            onChange={() => toggleSensitive(ci)}
                            style={{ accentColor: 'var(--primary)' }}
                          />
                          敏感
                        </label>
                        <button
                          className="press shrink-0"
                          title="删除该列"
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
                    <button className="press" title="加列" onClick={addColumn} style={{ color: 'var(--primary)' }}>
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
                        title="禁用后回放跳过该行"
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
                              placeholder={isMasked(cell) ? '••••••（未修改）' : ''}
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
                      <button className="press" title="删除该行" onClick={() => removeRow(ri)} style={{ color: 'var(--destructive)' }}>
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
                加行
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={tsvOpen} onOpenChange={setTsvOpen}>
        <DialogContent style={{ maxWidth: 560 }}>
          <DialogHeader><DialogTitle>从 Excel 粘贴（TSV）</DialogTitle></DialogHeader>
          <p className="text-[12px] mb-2" style={{ color: 'var(--muted-foreground)' }}>
            在 Excel/表格里复制区域后粘贴到这里：首行是列名，其余每行一条数据。同名列自动复用，新列默认非敏感。
          </p>
          <textarea
            className="input-base input-sm w-full"
            rows={8}
            style={{ fontFamily: 'monospace' }}
            placeholder={'username\tpassword\nalice\tpw1'}
            value={tsvText}
            onChange={(e) => setTsvText(e.target.value)}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setTsvOpen(false)}>取消</Button>
            <Button size="sm" onClick={applyTsv}>导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
