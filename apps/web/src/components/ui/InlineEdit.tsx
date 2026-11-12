import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Inline text editing: normally renders a piece of text; a click (or focus) turns it into an input.
 *  Enter / blur commits, Esc reverts. Empty strings and unchanged values are never committed (avoids accidental clearing).
 *  Disabled while saving; on failure reverts to the original value and leaves the notice to the caller's onError. */
export default function InlineEdit({
  value,
  onSave,
  disabled,
  placeholder,
  className,
  inputClassName,
  style,
  ariaLabel,
  maxLength = 200,
}: {
  value: string;
  onSave: (next: string) => unknown;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
  maxLength?: number;
}) {
  const { t } = useTranslation();
  const placeholderText = placeholder ?? t('common:unnamed');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // When the server value changes (someone else renames / a save returns), exit editing in sync so the next open doesn't show a stale draft
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (saving) return;
    if (!next || next === value) {
      setDraft(value);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
    } catch {
      // Failure notice is the caller's onError responsibility (the mutation already toasts); here we only restore the draft
      setDraft(value);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled || saving}
        onClick={() => setEditing(true)}
        title={t('common:clickToEdit')}
        aria-label={ariaLabel}
        className={`text-left truncate disabled:cursor-default ${className ?? ''}`}
        style={{ ...style, cursor: disabled || saving ? 'default' : 'text' }}
      >
        {value || placeholderText}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      autoFocus
      value={draft}
      maxLength={maxLength}
      disabled={saving}
      aria-label={ariaLabel}
      placeholder={placeholderText}
      className={`input-base input-sm ${inputClassName ?? ''}`}
      style={style}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
        e.stopPropagation();
      }}
    />
  );
}