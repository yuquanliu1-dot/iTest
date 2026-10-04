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
 * 分段控件：shadcn toggle-group 单选内核（spacing=0 连体 outline 样式）。
 * CRM 对齐；调用点 API（options/value/onChange）不变。
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
        // 单选 toggle-group 清空选中时返回 ''，忽略以保持受控值
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
