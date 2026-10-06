import { useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/Modal';
import Button from '../../components/ui/Button';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: Array<{ id: string; name: string }>;
  saving: boolean;
  /** 概览：每 Tab 选中数（让用户在选择分组时看到要保存的内容）。 */
  partitioned: { case: unknown[]; case_op: unknown[]; scenario: unknown[]; environment: unknown[]; plan: unknown[] };
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
  };
  const needGroup = selectedCounts.case + selectedCounts.plan > 0;
  const totalSelected =
    selectedCounts.case +
    selectedCounts.case_op +
    selectedCounts.scenario +
    selectedCounts.environment +
    selectedCounts.plan;
  const canSubmit = totalSelected > 0 && (!needGroup || !!groupId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>保存暂存对象</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            当前 Tab：{kindLabel}。选中 {totalSelected} 项
            {selectedCounts.case > 0 && ` · 用例 ${selectedCounts.case}`}
            {selectedCounts.case_op > 0 && ` · 修改 ${selectedCounts.case_op}`}
            {selectedCounts.scenario > 0 && ` · 场景 ${selectedCounts.scenario}`}
            {selectedCounts.environment > 0 && ` · 环境 ${selectedCounts.environment}`}
            {selectedCounts.plan > 0 && ` · 计划 ${selectedCounts.plan}`}
          </div>
          {needGroup ? (
            <div className="flex flex-col gap-1">
              <label className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                目标分组（用例 / 计划必选）
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
                <option value="">选择分组…</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
              仅保存环境/场景，落库时按项目默认位置放置，无需选分组。
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!canSubmit || saving} onClick={() => onSave(groupId)}>
            {saving ? '保存中…' : '保存所选'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
