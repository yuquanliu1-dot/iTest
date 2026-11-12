import { forwardRef } from 'react';
import { Button as ShadcnButton } from './shadcn/button';

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'destructive';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

// iTest semantics → CRM shadcn variants: primary→default (solid primary), ghost→outline (outlined secondary), danger/destructive→destructive (solid danger)
const variantMap = {
  primary: 'default',
  ghost: 'outline',
  danger: 'destructive',
  destructive: 'destructive',
} as const;

// Sizes aligned with CRM: sm→h-7(28) / md→default(h-8, 32) / lg→h-9(36)
const sizeMap = {
  sm: 'sm',
  md: 'default',
  lg: 'lg',
} as const;

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, style, ...props }, ref) => (
    <ShadcnButton
      ref={ref}
      variant={variantMap[variant]}
      size={sizeMap[size]}
      className={className}
      style={style}
      {...props}
    />
  )
);

Button.displayName = 'Button';

export default Button;
