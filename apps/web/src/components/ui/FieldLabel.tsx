import type { HTMLAttributes, ReactNode } from 'react';

interface FieldLabelProps extends HTMLAttributes<HTMLSpanElement> {
  /** Optional `htmlFor` — when provided, renders as a <label>; otherwise <span>. */
  htmlFor?: string;
  children: ReactNode;
}

/** Compact form-label primitive — 12px medium, muted color.
 *  Use htmlFor to attach to an input; omit for inline hints. */
export default function FieldLabel({ htmlFor, children, ...rest }: FieldLabelProps) {
  const style = { fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' };
  if (htmlFor) return <label htmlFor={htmlFor} style={style}>{children}</label>;
  return <span style={style} {...rest}>{children}</span>;
}
