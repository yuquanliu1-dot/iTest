import { forwardRef } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'danger';
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
    boxShadow: 'var(--shadow-accent)',
  },
  secondary: {
    background: 'transparent',
    color: 'var(--color-accent)',
    border: '1px solid var(--color-accent)',
    fontWeight: 500,
  },
  plain: {
    background: 'transparent',
    color: 'var(--color-foreground-muted)',
    border: 'none',
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
        className={className}
        disabled={disabled}
        style={{
          ...variantStyles[variant],
          ...sizeStyles[size],
          borderRadius: 'var(--radius-md)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background 0.15s ease, transform 0.1s ease, opacity 0.15s ease',
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
