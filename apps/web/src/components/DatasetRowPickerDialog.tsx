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
  /** 当前已选（启用行下标，0 基）。[] = 全部启用行（打开即全选）。 */
  value: number[];
  /** 确认回传：勾满全部启用行 → []；部分勾选 → 升序下标；未勾任何行时确认禁用。 */
  onConfirm: (indexes: number[]) => void;
  /** 计划级专用：传了才显示「跟随用例」按钮——清计划级覆盖（置 null），执行回落用例级配置。 */
  onFollowCase?: () => void;
}

/**
 * 数据集行选择弹窗（统一多选，不分单行/多行模式）：只渲染「启用行」，
 * 编号用启用行下标 + 1（与执行器同一编号空间）。只在打开时拉数据集（页面加载零额外请求）；
 * 敏感格显示 ••••••。
 */
export default function DatasetRowPickerDialog({
  open,
  onOpenChange,
  projectId,
  datasetId,
  value,
  onConfirm,
  onFollowCase,
}: DatasetRowPickerDialogProps) {
  const { t } = useTranslation();
  /** 用户交互后的选择；null = 尚未交互，按 value 派生（[] = 全选）。每次打开重置。 */
  const [pickedOverride, setPickedOverride] = useState<number[] | null>(null);

  useEffect(() => {
    if (open) setPickedOverride(null);
  }, [open]);

  const { data, isLoading } = useQuery({
    queryKey: ['dataset', datasetId],
    queryFn: () => api.datasets.get(projectId!, datasetId!),
    enabled: open && !!datasetId && !!projectId,
  });

  // 启用行（剔除 disabled），编号 = 启用行下标 + 1
  const enabledRows = (data?.rows ?? [])
    .map((r, i) => ({ r, enabledIndex: i }))
    .filter(({ r }) => !r.disabled);
  const enabledIndexes = enabledRows.map((_, i) => i);

  // 未交互时按 value 派生：[] = 全部启用行；非空 = 子集
  const picked = pickedOverride ?? (value.length === 0 ? enabledIndexes : value);

  const toggle = (idx: number) => {
    setPickedOverride(picked.includes(idx) ? picked.filter((x) => x !== idx) : [...picked, idx]);
  };

  const toggleAll = () => {
    setPickedOverride(picked.length === enabledIndexes.length ? [] : [...enabledIndexes]);
  };

  const confirm = () => {
    // 勾满全部启用行 → 存 []（语义=全部行）；部分勾选 → 升序下标
    const all = picked.length === enabledIndexes.length;
    onConfirm(all ? [] : [...picked].sort((a, b) => a - b));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('cases:datasetRowScope')}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:datasetRowLoading')}</p>
        ) : enabledRows.length === 0 ? (
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:datasetRowEmpty')}</p>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto">
            {/* table-fixed：勾选/序号列固定，数据列均分剩余宽度——auto 布局下长描述列会被挤成 1 字宽竖条 */}
            <table className="w-full table-fixed">
              <thead>
                <tr>
                  <th className="px-2 py-1.5 w-[36px]">
                    <input
                      type="checkbox"
                      checked={picked.length === enabledIndexes.length && enabledIndexes.length > 0}
                      onChange={toggleAll}
                      title={t('cases:datasetRowSelectAll')}
                      style={{ accentColor: 'var(--primary)' }}
                    />
                  </th>
                  <th className="px-2 py-1.5 w-[36px] text-left text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                    #
                  </th>
                  {data?.columns.map((c) => (
                    <th key={c.name} className="px-2 py-1.5 text-left text-[11px] break-words" style={{ color: 'var(--muted-foreground)' }}>
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
                      <td className="px-2 py-1.5 text-center align-top">
                        <input
                          type="checkbox"
                          checked={picked.includes(enabledIndex)}
                          onChange={() => toggle(enabledIndex)}
                          title={t('cases:datasetRowSelect', { index: enabledIndex + 1 })}
                          style={{ accentColor: 'var(--primary)' }}
                        />
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[11px] align-top" style={{ color: 'var(--muted-foreground)' }}>
                        {enabledIndex + 1}
                      </td>
                      {data?.columns.map((c) => {
                        const cell = r.cells[c.name];
                        const masked = isMasked(cell);
                        return (
                          <td key={c.name} className="px-2 py-1.5 font-mono text-[11px] break-words align-top">
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
          {onFollowCase && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                onFollowCase();
                onOpenChange(false);
              }}
            >
              {t('plans:followCase')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common:cancel')}</Button>
          <Button onClick={confirm} disabled={picked.length === 0}>{t('common:confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
