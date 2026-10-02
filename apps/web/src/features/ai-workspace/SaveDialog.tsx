import { useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/Modal';
import Button from '../../components/ui/Button';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: Array<{ id: string; name: string }>;
  onSave: (groupId: string) => void;
  saving: boolean;
}

const LAST_GROUP_KEY = 'ai-workspace-last-group';

export default function SaveDialog({ open, onOpenChange, groups, onSave, saving }: Props) {
  const initial = (() => {
    try {
      return localStorage.getItem(LAST_GROUP_KEY) ?? '';
    } catch {
      return '';
    }
  })();
  const [groupId, setGroupId] = useState(initial);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>选择目标分组</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-5 py-4">
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
        <DialogFooter>
          <Button variant="plain" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!groupId || saving} onClick={() => onSave(groupId)}>
            {saving ? '保存中…' : '保存所选'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}