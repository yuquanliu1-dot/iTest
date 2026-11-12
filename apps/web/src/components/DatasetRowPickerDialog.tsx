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
  /** Currently selected (enabled-row indexes, 0-based). [] = all enabled rows (all selected on open). */
  value: number[];
  /** Confirmed callback: all enabled rows checked → []; partial selection → ascending indexes; confirm disabled when nothing is checked. */
  onConfirm: (indexes: number[]) => void;
  /** Plan-level only: the "follow case" button shows only when passed — clears the plan-level override (sets null) so execution falls back to case-level config. */
  onFollowCase?: () => void;
}

/**
 * Dataset row selection dialog (unified multi-select, no single-row/multi-row modes): renders only "enabled rows",
 * numbered by enabled-row index + 1 (same numbering space as the executor). Fetches the dataset only when opened (zero extra requests on page load);
 * sensitive cells show ••••••.
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
  /** Selection after user interaction; null = not yet interacted, derived from value ([] = all selected). Reset on each open. */
  const [pickedOverride, setPickedOverride] = useState<number[] | null>(null);

  useEffect(() => {
    if (open) setPickedOverride(null);
  }, [open]);

  const { data, isLoading } = useQuery({
    queryKey: ['dataset', datasetId],
    queryFn: () => api.datasets.get(projectId!, datasetId!),
    enabled: open && !!datasetId && !!projectId,
  });

  // Enabled rows (disabled ones removed); number = enabled-row index + 1
  const enabledRows = (data?.rows ?? [])
    .map((r, i) => ({ r, enabledIndex: i }))
    .filter(({ r }) => !r.disabled);
  const enabledIndexes = enabledRows.map((_, i) => i);

  // Derived from value before interaction: [] = all enabled rows; non-empty = subset
  const picked = pickedOverride ?? (value.length === 0 ? enabledIndexes : value);

  const toggle = (idx: number) => {
    setPickedOverride(picked.includes(idx) ? picked.filter((x) => x !== idx) : [...picked, idx]);
  };

  const toggleAll = () => {
    setPickedOverride(picked.length === enabledIndexes.length ? [] : [...enabledIndexes]);
  };

  const confirm = () => {
    // All enabled rows checked → store [] (semantics = all rows); partial selection → ascending indexes
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
            {/* table-fixed: checkbox/# columns fixed, data columns share the remaining width evenly — under auto layout a long description column gets squeezed into a 1-char-wide vertical strip */}
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
                  // The executor's index space: renumbered after removing disabled rows
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
