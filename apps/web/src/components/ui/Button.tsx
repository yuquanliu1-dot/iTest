import { forwardRef } from 'react';
import { Button as ShadcnButton } from './shadcn/button';

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'destructive';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

// iTest 语义 → CRM shadcn 变体：primary→default(实心主色)、ghost→outline(描边次操作)、danger/destructive→destructive(实心危险)
const variantMap = {
  primary: 'default',
  ghost: 'outline',
  danger: 'destructive',
  destructive: 'destructive',
} as const;

// 尺寸对齐 CRM：sm→h-7(28) / md→default(h-8, 32) / lg→h-9(36)
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
