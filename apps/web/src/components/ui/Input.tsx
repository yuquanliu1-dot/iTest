import { forwardRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

// size 与原生 <input size:number> 属性冲突，Omit 后重声明为尺寸档位
interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
  /** md = 44px 标准档（默认，表单/弹窗）；sm = 36px 紧凑档（工具栏/筛选行/行内编辑） */
  size?: 'md' | 'sm';
  /** 左侧图标（搜索等），绝对定位在输入框内左侧 */
  leadingIcon?: ReactNode;
  /** 右侧图标（密码 eye 等），绝对定位在输入框内右侧 */
  trailingIcon?: ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, size = 'md', leadingIcon, trailingIcon, className = '', style, ...props }, ref) => {
    // 样式单一来源：index.css 的 .input-base/.input-sm 语义类
    const inputElement = (
      <input
        ref={ref}
        style={style}
        aria-invalid={error ? true : undefined}
        className={cn(
          'input-base',
          size === 'sm' && 'input-sm',
          leadingIcon && 'input-with-leading',
          trailingIcon && 'input-with-trailing',
          className,
        )}
        {...props}
      />
    );
    return (
      <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {label && (
          <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' }}>
            {label}
          </label>
        )}
        {leadingIcon || trailingIcon ? (
          <div className="input-wrap">
            {leadingIcon && <span className="input-icon">{leadingIcon}</span>}
            {inputElement}
            {trailingIcon && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center text-[var(--color-foreground-muted)]">
                {trailingIcon}
              </span>
            )}
          </div>
        ) : (
          inputElement
        )}
        {error && (
          <span style={{ fontSize: 11, color: 'var(--color-destructive)' }}>{error}</span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export default Input;
