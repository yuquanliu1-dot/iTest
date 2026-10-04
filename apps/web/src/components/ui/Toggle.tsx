import { Switch } from './shadcn/switch';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}

// 内核为 CRM shadcn Switch（32x18 主色滑块），保留 iTest 的 checked/onChange/label API
export default function Toggle({ checked, onChange, disabled = false, label }: ToggleProps) {
  return (
    <label
      className="inline-flex cursor-pointer items-center gap-2 select-none data-disabled:cursor-not-allowed data-disabled:opacity-50"
      data-disabled={disabled ? '' : undefined}
    >
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v)}
      />
      {label && <span className="text-[13px] text-[var(--foreground)]">{label}</span>}
    </label>
  );
}
