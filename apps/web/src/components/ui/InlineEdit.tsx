import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** 行内编辑文本：常态只渲染一段文字，点一下（或聚焦）变 input。
 *  Enter / blur 提交，Esc 还原。空串与未改动一律不提交（避免误触清空）。
 *  保存中禁用，失败时回到原值并把提示交给调用方的 onError。 */
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

  // 服务端值变化时（他人改名 / 保存返回）同步退出编辑态，避免下次打开显示旧草稿
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
      // 失败提示由调用方 onError 负责（mutation 已 toast），这里只复原草稿
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