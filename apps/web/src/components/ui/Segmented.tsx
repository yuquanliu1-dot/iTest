import { ToggleGroup, ToggleGroupItem } from './shadcn/toggle-group';
import Icon, { type IconName } from '../Icon';

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  title?: string;
}

interface SegmentedProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * Segmented control: shadcn toggle-group single-select core (spacing=0 joined outline styling).
 * CRM aligned; the call-site API (options/value/onChange) is unchanged.
 */
export default function Segmented<T extends string>({ options, value, onChange }: SegmentedProps<T>) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      value={value}
      onValueChange={(v) => {
        // A single-select toggle-group returns '' when the selection is cleared; ignore to keep the controlled value
        if (v) onChange(v as T);
      }}
    >
      {options.map((opt) => (
        <ToggleGroupItem key={opt.value} value={opt.value} disabled={opt.disabled} title={opt.title}>
          {opt.icon && <Icon name={opt.icon} size={12} />}
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
