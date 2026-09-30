import Icon, { type IconName } from '../Icon';

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

interface SegmentedProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** macOS/iDO 分段控件：样式单一来源 index.css 的 .segmented-control */
export default function Segmented<T extends string>({ options, value, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented-control" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          className={opt.value === value ? 'active' : undefined}
          onClick={() => onChange(opt.value)}
          style={{ gap: opt.icon ? 6 : undefined }}
        >
          {opt.icon && <Icon name={opt.icon} size={12} />}
          {opt.label}
        </button>
      ))}
    </div>
  );
}
