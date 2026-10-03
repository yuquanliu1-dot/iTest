import type { ReactNode, CSSProperties } from 'react';

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'style' | 'children'> {
  /** Visible label rendered above the select. */
  label?: string;
  /** Optional element rendered inside the trailing slot (e.g. chevron icon). */
  trailing?: ReactNode;
  /** Optional element rendered inside the leading slot (e.g. icon). */
  leading?: ReactNode;
  style?: CSSProperties;
  /** Children — usually <option> elements. */
  children: ReactNode;
}

/** Compact native <select> wrapper matching the toolbar filter pattern
 *  used in GroupsPage / Reports. Use inside toolbars; for forms use
 *  <select className="input-base"> directly. */
export default function Select({ label, trailing, leading, style, className = '', children, ...rest }: SelectProps) {
  return (
    <label className={`inline-flex flex-col gap-1 ${className}`} style={style}>
      {label && (
        <span className="text-[11px] font-medium" style={{ color: 'var(--color-foreground-muted)' }}>
          {label}
        </span>
      )}
      <span
        className="input-wrap inline-flex items-center"
        style={{
          height: 30,
          padding: '0 8px',
          border: '1px solid var(--color-border)',
          background: 'var(--color-background-elevated)',
          color: 'var(--color-foreground)',
          borderRadius: 'var(--radius-sm)',
          minWidth: 140,
        }}
      >
        {leading && (
          <span className="input-icon" style={{ position: 'static', transform: 'none', marginRight: 4 }}>
            {leading}
          </span>
        )}
        <select
          {...rest}
          className="bg-transparent outline-none w-full text-[12px]"
          style={{
            color: 'var(--color-foreground)',
            background: 'transparent',
            border: 'none',
            height: '100%',
            padding: 0,
          }}
        >
          {children}
        </select>
        {trailing && (
          <span style={{ marginLeft: 4, color: 'var(--color-foreground-muted)', display: 'inline-flex' }}>
            {trailing}
          </span>
        )}
      </span>
    </label>
  );
}
