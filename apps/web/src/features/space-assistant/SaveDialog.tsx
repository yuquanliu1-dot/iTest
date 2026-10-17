import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/Modal';
import Button from '../../components/ui/Button';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: Array<{ id: string; name: string }>;
  saving: boolean;
  /** 概览：每 Tab 选中数（让用户在选择分组时看到要保存的内容）。 */
  partitioned: { case: unknown[]; case_op: unknown[]; scenario: unknown[]; environment: unknown[]; plan: unknown[]; dataset: unknown[] };
  selection: Set<string>;
  /** 用户点保存：传入选中的目标 groupId；空串 = "暂存到不指定"（仅 environment/scenario 适用）。 */
  onSave: (groupId: string) => void;
  /** 当前 Tab 标签，仅做展示。 */
  kindLabel: string;
}

const LAST_GROUP_KEY = 'space-assistant-last-group';

/**
 * 暂存对象落库对话框：选目标分组 → 调用 /stage/save。
 * 选中条目包含用例/计划时必选 group；纯 environment/scenario 时允许空（落库到项目下默认）。
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
  // 只有用例在保存时需要 groupId（落 groups 关系）。其他对象走 project/version 默认落点：
  //   - scenario → requirement；environment → project 下默认；plan → version + project；dataset → project
  // 计划历史上传过 groupId 是误用，service 端 createPlan 不读也不存，分组选择是 UI 噪音。
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
