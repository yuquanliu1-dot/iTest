import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

const Dialog = DialogPrimitive.Root;
const DialogClose = DialogPrimitive.Close;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      className={cn(
        // 遮罩 rgba(0,0,0,0.3)。backdrop-filter 仅允许出现在 .glass-* 工具类里
        'fixed inset-0 z-[1100] bg-black/30 dialog-overlay',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // z-index 阶梯：Dialog 1100 < Toast 9999
        'fixed left-1/2 top-1/2 z-[1100] w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
        'flex max-h-[90vh] flex-col overflow-hidden',
        'border bg-[var(--color-surface-overlay)] border-[var(--color-border)]',
        'rounded-[var(--radius-md)] shadow-[var(--shadow-modal)] dialog-content',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-60 transition-opacity hover:opacity-100 focus:outline-none">
        <X className="h-4 w-4" style={{ color: 'var(--color-foreground-secondary)' }} />
        <span className="sr-only">关闭</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 px-5 py-4 hairline-bottom text-left',
        className,
      )}
      style={{ borderColor: 'var(--color-border)' }}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end px-5 py-4 hairline-top',
        className,
      )}
      style={{ borderColor: 'var(--color-border)' }}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-[15px] font-semibold text-[var(--color-foreground)]', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export { Dialog, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle };
