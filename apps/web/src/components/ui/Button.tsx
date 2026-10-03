import { forwardRef } from 'react';

type ButtonVariant = 'primary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'var(--color-accent)',
    color: 'var(--color-accent-foreground)',
    border: 'none',
    fontWeight: 500,
  },
  ghost: {
    background: 'transparent',
    color: 'var(--color-foreground-secondary)',
    border: '1px solid var(--color-border-subtle)',
    fontWeight: 500,
  },
  danger: {
    background: 'transparent',
    color: 'var(--color-destructive)',
    border: `1px solid var(--color-destructive)`,
    fontWeight: 500,
  },
};

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: { fontSize: 11, padding: '4px 12px', height: 26 },
  md: { fontSize: 13, padding: '6px 16px', height: 32 },
  lg: { fontSize: 14, padding: '8px 20px', height: 36 },
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', style, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        data-variant={variant}
        className={`press ${className}`}
        disabled={disabled}
        style={{
          ...variantStyles[variant],
          ...sizeStyles[size],
          borderRadius: 'var(--radius-md)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition:
            'background 0.18s ease, transform 0.12s ease, opacity 0.15s ease, box-shadow 0.22s ease, border-color 0.18s ease, color 0.18s ease',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          boxSizing: 'border-box',
          ...style,
        }}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';

export default Button;
