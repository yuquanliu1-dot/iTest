import type { ReactNode } from 'react';

interface FieldLabelProps {
  /** Optional `htmlFor` — when provided, renders as a <label>; otherwise <span>. */
  htmlFor?: string;
  children: ReactNode;
}

/** Compact form-label primitive — 12px medium, muted color.
 *  Use htmlFor to attach to an input; omit for inline hints. */
export default function FieldLabel({ htmlFor, children }: FieldLabelProps) {
  const style = { fontSize: 12, fontWeight: 500, color: 'var(--color-foreground-secondary)' };
  if (htmlFor) return <label htmlFor={htmlFor} style={style}>{children}</label>;
  return <span style={style}>{children}</span>;
}
