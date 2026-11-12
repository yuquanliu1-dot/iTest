import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/Modal';
import Button from '../../components/ui/Button';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: Array<{ id: string; name: string }>;
  saving: boolean;
  /** Overview: selected count per tab (lets the user see what will be saved while picking a group). */
  partitioned: { case: unknown[]; case_op: unknown[]; scenario: unknown[]; environment: unknown[]; plan: unknown[]; dataset: unknown[] };
  selection: Set<string>;
  /** User clicks save: receives the selected target groupId; empty string = "stage without a group" (only applies to environment/scenario). */
  onSave: (groupId: string) => void;
  /** Current tab label, display only. */
  kindLabel: string;
}

const LAST_GROUP_KEY = 'space-assistant-last-group';

/**
 * Staged-objects persistence dialog: pick the target group → call /stage/save.
 * When the selection includes cases/plans a group is required; pure environment/scenario may be empty (persists to the project default).
 */
export default function SaveDialog({ open, onOpenChange, groups, saving, partitioned, selection, onSave, kindLabel }: Props) {
  const { t } = useTranslation();
  const initial = (() => {
    try {
      return localStorage.getItem(LAST_GROUP_KEY) ?? '';
    } catch {
      return '';
    }
  })();
  const [groupId, setGroupId] = useState(initial);
  const selectedCounts = {
    case: partitioned.case.filter((x) => selection.has(`case:${(x as { localId: string }).localId}`)).length,
    case_op: partitioned.case_op.filter((x) => selection.has(`case_op:${(x as { localId: string }).localId}`)).length,
    scenario: partitioned.scenario.filter((x) => selection.has(`scenario:${(x as { localId: string }).localId}`)).length,
    environment: partitioned.environment.filter((x) =>
      selection.has(`environment:${(x as { localId: string }).localId}`),
    ).length,
    plan: partitioned.plan.filter((x) => selection.has(`plan:${(x as { localId: string }).localId}`)).length,
    dataset: partitioned.dataset.filter((x) =>
      selection.has(`dataset:${(x as { localId: string }).localId}`),
    ).length,
  };
  // Only cases need a groupId at save time (lands in the groups relation). Other objects use the project/version default landing spots:
  //   - scenario → requirement; environment → project default; plan → version + project; dataset → project
  // Plans historically carrying a groupId was a misuse; the service-side createPlan neither reads nor stores it, so the group picker is UI noise.
  const needGroup = selectedCounts.case > 0;
  const totalSelected =
    selectedCounts.case +
    selectedCounts.case_op +
    selectedCounts.scenario +
    selectedCounts.environment +
    selectedCounts.plan +
    selectedCounts.dataset;
  const canSubmit = totalSelected > 0 && (!needGroup || !!groupId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('assistant:saveDialog.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('assistant:saveDialog.currentTab', { kind: kindLabel, count: totalSelected })}
            {selectedCounts.case > 0 && t('assistant:saveDialog.countCase', { count: selectedCounts.case })}
            {selectedCounts.case_op > 0 && t('assistant:saveDialog.countCaseOp', { count: selectedCounts.case_op })}
            {selectedCounts.scenario > 0 && t('assistant:saveDialog.countScenario', { count: selectedCounts.scenario })}
            {selectedCounts.environment > 0 && t('assistant:saveDialog.countEnvironment', { count: selectedCounts.environment })}
            {selectedCounts.plan > 0 && t('assistant:saveDialog.countPlan', { count: selectedCounts.plan })}
            {selectedCounts.dataset > 0 && t('assistant:saveDialog.countDataset', { count: selectedCounts.dataset })}
          </div>
          {needGroup ? (
            <div className="flex flex-col gap-1">
              <label className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                {t('assistant:saveDialog.needGroup')}
              </label>
              <select
                className="input-base"
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value);
                  try {
                    localStorage.setItem(LAST_GROUP_KEY, e.target.value);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                <option value="">{t('assistant:saveDialog.chooseGroup')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('assistant:saveDialog.noGroupHint')}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </Button>
          <Button disabled={!canSubmit || saving} onClick={() => onSave(groupId)}>
            {saving ? t('common:saving') : t('assistant:saveDialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
