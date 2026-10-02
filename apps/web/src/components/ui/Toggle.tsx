interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export default function Toggle({ checked, onChange, disabled = false, label }: ToggleProps) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        userSelect: 'none',
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
        className="press"
        style={{
          position: 'relative',
          width: 36,
          height: 20,
          borderRadius: 10,
          border: 'none',
          padding: 0,
          background: checked ? 'var(--color-accent)' : 'var(--color-glass-border-hover)',
          transition: 'background 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          outline: 'none',
          flexShrink: 0,
          boxShadow: checked ? '0 0 0 3px var(--color-accent-glow)' : 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'var(--color-background-elevated)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
            transition: 'transform 0.28s cubic-bezier(0.16, 1, 0.3, 1)',
            transform: checked ? 'translateX(16px)' : 'translateX(0)',
          }}
        />
      </button>
      {label && (
        <span style={{ fontSize: 13, color: 'var(--color-foreground)' }}>
          {label}
        </span>
      )}
    </label>
  );
}
