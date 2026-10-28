import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/Modal';
import { Button } from './ui/shadcn/button';

const isMasked = (v: unknown): v is { __masked: true } =>
  typeof v === 'object' && v !== null && (v as { __masked?: boolean }).__masked === true;

interface DatasetRowPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | undefined;
  datasetId: string | null;
  /** 'one' = 单选（选一行即替换）；'many' = 多选。 */
  mode: 'one' | 'many';
  /** 当前已选（启用行下标，0 基）。 */
  value: number[];
  onConfirm: (indexes: number[]) => void;
}

/**
 * 数据集行选择弹窗：只渲染「启用行」，编号用启用行下标 + 1（与执行器同一编号空间）。
 * 只在打开时拉数据集（页面加载零额外请求）；敏感格显示 ••••••。
 */
export default function DatasetRowPickerDialog({
  open,
  onOpenChange,
  projectId,
  datasetId,
  mode,
  value,
  onConfirm,
}: DatasetRowPickerDialogProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<number[]>(value);

  // 打开时重置为当前值并拉数据集详情
  useEffect(() => {
    if (!open) return;
    setPicked(value);
  }, [open, value]);

  const { data, isLoading } = useQuery({
    queryKey: ['dataset', datasetId],
    queryFn: () => api.datasets.get(projectId!, datasetId!),
    enabled: open && !!datasetId && !!projectId,
  });

  // 启用行（剔除 disabled），编号 = 启用行下标 + 1
  const enabledRows = (data?.rows ?? [])
    .map((r, i) => ({ r, enabledIndex: i }))
    .filter(({ r }) => !r.disabled);
  // 启用行下标 = 剔除禁用行后的重新编号
  const enabledIndexes = enabledRows.map((_, i) => i);

  const toggle = (idx: number) => {
    if (mode === 'one') {
      setPicked([idx]);
      return;
    }
    setPicked((prev) => (prev.includes(idx) ? prev.filter((x) => x !== idx) : [...prev, idx]));
  };

  const toggleAll = () => {
    if (mode === 'one') return;
    setPicked((prev) => (prev.length === enabledIndexes.length ? [] : [...enabledIndexes]));
  };

  const confirm = () => {
    onConfirm([...picked].sort((a, b) => a - b));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('cases:datasetRowScope')}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:datasetRowLoading')}</p>
        ) : enabledRows.length === 0 ? (
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:datasetRowEmpty')}</p>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="px-2 py-1.5 w-[36px]">
                    {mode === 'many' && (
                      <input
                        type="checkbox"
                        checked={picked.length === enabledIndexes.length && enabledIndexes.length > 0}
                        onChange={toggleAll}
                        title={t('cases:datasetRowSelectAll')}
                        style={{ accentColor: 'var(--primary)' }}
                      />
                    )}
                  </th>
                  <th className="px-2 py-1.5 text-left text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    #
                  </th>
                  {data?.columns.map((c) => (
                    <th key={c.name} className="px-2 py-1.5 text-left text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {enabledRows.map(({ r }, displayIdx) => {
                  // 执行器用的下标空间：剔除禁用行后重新编号
                  const enabledIndex = displayIdx;
                  return (
                    <tr key={displayIdx} className="hairline-bottom">
                      <td className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={picked.includes(enabledIndex)}
                          onChange={() => toggle(enabledIndex)}
                          title={t('cases:datasetRowSelect', { index: enabledIndex + 1 })}
                          style={{ accentColor: 'var(--primary)' }}
                        />
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                        {enabledIndex + 1}
                      </td>
                      {data?.columns.map((c) => {
                        const cell = r.cells[c.name];
                        const masked = isMasked(cell);
                        return (
                          <td key={c.name} className="px-2 py-1.5 font-mono text-[11px]">
                            {masked ? (
                              <span style={{ color: 'var(--muted-foreground)' }} title={t('cases:datasetRowMasked')}>
                                ••••••
                              </span>
                            ) : (
                              (cell ?? '')
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common:cancel')}</Button>
          <Button onClick={confirm} disabled={picked.length === 0}>{t('common:confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
