import { forwardRef, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Input as ShadcnInput } from './shadcn/input';

// size conflicts with the native <input size:number> attribute; Omit it and redeclare as size tiers
interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
  /** md = 32px standard tier (default, forms/dialogs, aligned with CRM h-8); sm = 28px compact tier (toolbars/filter rows/inline editing) */
  size?: 'md' | 'sm';
  /** Left icon (search etc.), absolutely positioned inside the input on the left */
  leadingIcon?: ReactNode;
  /** Right icon (password eye etc.), absolutely positioned inside the input on the right */
  trailingIcon?: ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, size = 'md', leadingIcon, trailingIcon, className = '', style, ...props }, ref) => {
    // Core is the CRM shadcn Input (h-8 + border-input + focus ring); sm layers h-7 on top to override height
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
