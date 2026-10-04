import { forwardRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Input as ShadcnInput } from './shadcn/input';

// size 与原生 <input size:number> 属性冲突，Omit 后重声明为尺寸档位
interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
  /** md = 32px 标准档（默认，表单/弹窗，对齐 CRM h-8）；sm = 28px 紧凑档（工具栏/筛选行/行内编辑） */
  size?: 'md' | 'sm';
  /** 左侧图标（搜索等），绝对定位在输入框内左侧 */
  leadingIcon?: ReactNode;
  /** 右侧图标（密码 eye 等），绝对定位在输入框内右侧 */
  trailingIcon?: ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, size = 'md', leadingIcon, trailingIcon, className = '', style, ...props }, ref) => {
    // 内核为 CRM shadcn Input（h-8 + border-input + focus ring）；sm 叠加 h-7 覆盖高度
    const inputElement = (
      <ShadcnInput
        ref={ref}
        style={style}
        aria-invalid={error ? true : undefined}
        className={cn(size === 'sm' && 'h-7 text-xs', className)}
        {...props}
      />
    );
    return (
      <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {label && (
          <label className="text-xs font-medium text-[var(--muted-foreground)]">
            {label}
          </label>
        )}
        {leadingIcon || trailingIcon ? (
          <div className="input-wrap">
            {leadingIcon && <span className="input-icon">{leadingIcon}</span>}
            {inputElement}
            {trailingIcon && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center text-[var(--muted-foreground)]">
                {trailingIcon}
              </span>
            )}
          </div>
        ) : (
          inputElement
        )}
        {error && (
          <span className="text-[11px] text-[var(--destructive)]">{error}</span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export default Input;
