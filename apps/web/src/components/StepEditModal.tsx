import { useState, useEffect, type CSSProperties } from 'react';
import type { StepClip } from '../stores/stepClipboard';
import { api } from '../api/client';
import { formatBytes, shortDateTime } from '../lib/format';

interface Props {
  initial: StepClip;
  /** 用例中已定义的变量名（extract 步骤产出），用于 fill 值的引用提示 */
  availableVars?: string[];
  /** 当前 case id，用于附件上传接口 */
  caseId?: string;
  onSave: (next: StepClip) => void;
  onClose: () => void;
}

type ValueMode = 'fixed' | 'randomString' | 'randomNumber' | 'timestamp' | 'prefixTimestamp';

/** 步骤编辑弹窗：名称/等待时间 + 按 action.kind 分派的值编辑。 */
export default function StepEditModal({ initial, availableVars = [], caseId, onSave, onClose }: Props) {
  const action = initial.action as Record<string, unknown>;
  const kind = action.kind as string;

  const [name, setName] = useState(initial.name ?? '');
  const [delayMs, setDelayMs] = useState(initial.delayMs ? String(initial.delayMs) : '');

  // fill 敏感值
  const [sensitive, setSensitive] = useState(!!(action as { sensitive?: boolean }).sensitive);
  const [pwdDraft, setPwdDraft] = useState('');

  // upload
  const [fileId, setFileId] = useState<string | undefined>((action as { fileId?: string }).fileId);
  const [attachments, setAttachments] = useState<
    Array<{ id: string; originalName: string; size: number; mime: string | null; sha256: string; createdAt: string }>
  >([]);

  // fill/select 值编辑
  const rawValue = (action.value ?? '') as string | Record<string, unknown>;
  const isGenerator = typeof rawValue === 'object';
  const [valueMode, setValueMode] = useState<ValueMode>(
    isGenerator ? ((rawValue as { mode: string }).mode as ValueMode) : 'fixed',
  );
  const [fixedValue, setFixedValue] = useState(isGenerator ? '' : (rawValue as string));
  const [genLength, setGenLength] = useState(isGenerator ? String((rawValue as { length?: number }).length ?? 12) : '12');
  const [genMin, setGenMin] = useState(isGenerator ? String((rawValue as { min?: number }).min ?? 0) : '0');
  const [genMax, setGenMax] = useState(isGenerator ? String((rawValue as { max?: number }).max ?? 999999) : '999999');
  const [genPrefix, setGenPrefix] = useState(isGenerator ? String((rawValue as { prefix?: string }).prefix ?? '') : '');

  // assertText/assertJson
  const [equalsText, setEqualsText] = useState(
    kind === 'assertJson' ? JSON.stringify(action.equals ?? null, null, 2) : String(action.equals ?? ''),
  );
  // extract
  const [varName, setVarName] = useState(String(action.varName ?? ''));
  // aiStep
  const [instruction, setInstruction] = useState(String(action.instruction ?? ''));
  // navigate
  const [url, setUrl] = useState(String(action.url ?? ''));
  // waitFor
  const [timeoutMs, setTimeoutMs] = useState(String(action.timeoutMs ?? ''));
  // check
  const [checked, setChecked] = useState(action.checked !== false);

  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (kind !== 'upload' || !caseId) return;
    let cancelled = false;
    api.attachments
      .list(caseId)
      .then((rows) => {
        if (!cancelled) setAttachments(rows);
      })
      .catch(() => {
        /* non-fatal; reuse list optional */
      });
    return () => {
      cancelled = true;
    };
  }, [kind, caseId]);

  const buildValue = (): string | Record<string, unknown> => {
    switch (valueMode) {
      case 'fixed':
        return fixedValue;
      case 'randomString':
        return { mode: 'randomString', length: Number(genLength) || 12 };
      case 'randomNumber':
        return { mode: 'randomNumber', min: Number(genMin) || 0, max: Number(genMax) || 999999 };
      case 'timestamp':
        return { mode: 'timestamp' };
      case 'prefixTimestamp':
        return { mode: 'prefixTimestamp', prefix: genPrefix };
    }
  };

  const handleSave = () => {
    const next: Record<string, unknown> = { ...action };
    if (kind === 'fill' || kind === 'select') next.value = buildValue();
    if (kind === 'fill') {
      if (sensitive) {
        if (!pwdDraft) {
          setError('已加密 — 修改时请输入新密码');
          return;
        }
        next.value = pwdDraft;
        next.sensitive = true;
      } else {
        delete next.sensitive;
      }
    }
    if (kind === 'upload') {
      if (!fileId) {
        setError('请先绑定回放文件');
        return;
      }
      next.fileId = fileId;
    }
    if (kind === 'assertText') next.equals = equalsText;
    if (kind === 'assertJson') {
      try {
        next.equals = JSON.parse(equalsText);
      } catch {
        setError('期望值不是合法 JSON');
        return;
      }
    }
    if (kind === 'extract') {
      if (!varName.trim()) {
        setError('请输入变量名');
        return;
      }
      next.varName = varName.trim();
    }
    if (kind === 'aiStep') {
      if (!instruction.trim()) {
        setError('请输入指令');
        return;
      }
      next.instruction = instruction.trim();
      next.compiled = action.compiled ?? null;
    }
    if (kind === 'navigate') next.url = url;
    if (kind === 'waitFor') {
      if (timeoutMs) next.timeoutMs = Number(timeoutMs);
      else delete next.timeoutMs;
    }
    if (kind === 'check') next.checked = checked;
    onSave({
      action: next,
      source: initial.source,
      name: name.trim() || undefined,
      delayMs: delayMs ? Number(delayMs) : undefined,
    });
  };

  const inputStyle: CSSProperties = {
    width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid var(--color-glass-border)',
    borderRadius: 6, background: 'var(--color-background-subtle)', color: 'var(--color-foreground)',
    boxSizing: 'border-box', marginTop: 4,
  };
  const labelStyle: CSSProperties = { fontSize: 11, color: 'var(--color-foreground-muted)' };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)', zIndex: 50 }}
      onClick={onClose}
    >
      <div
        className="glass-card rounded-[12px] p-5 w-[420px] max-h-[80vh] overflow-y-auto"
        style={{ background: 'var(--color-background)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--color-foreground)' }}>
          编辑步骤 <span className="font-mono text-[11px]">({kind})</span>
        </h2>

        <div className="flex flex-col gap-3">
          <label style={labelStyle}>
            步骤名称
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="可选" />
          </label>
          <label style={labelStyle}>
            执行前等待 (ms)
            <input style={inputStyle} value={delayMs} onChange={(e) => setDelayMs(e.target.value)} placeholder="0" inputMode="numeric" />
          </label>

          {(kind === 'fill' || kind === 'select') && (
            <div className="flex flex-col gap-2">
              {kind === 'fill' && (
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={sensitive}
                    onChange={(e) => setSensitive(e.target.checked)}
                  />
                  敏感值（密码，加密保存，明文不显示）
                </label>
              )}
              {kind === 'fill' && sensitive && (
                <input
                  type="password"
                  style={inputStyle}
                  placeholder="输入新密码（修改时填写；留空表示保留原值）"
                  value={pwdDraft}
                  onChange={(e) => setPwdDraft(e.target.value)}
                />
              )}
              {!sensitive && (
                <>
                  <span style={labelStyle}>值</span>
                  <div className="flex gap-1 flex-wrap">
                    {(['fixed', 'randomString', 'randomNumber', 'timestamp', 'prefixTimestamp'] as ValueMode[]).map((m) => (
                      <button
                        key={m}
                        onClick={() => setValueMode(m)}
                        style={{
                          fontSize: 11, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
                          border: '1px solid var(--color-glass-border)',
                          background: valueMode === m ? 'var(--color-accent)' : 'transparent',
                          color: valueMode === m ? '#fff' : 'var(--color-foreground-secondary)',
                        }}
                      >
                        {{ fixed: '固定值', randomString: '随机字符串', randomNumber: '随机数字', timestamp: '时间戳', prefixTimestamp: '前缀+时间戳' }[m]}
                      </button>
                    ))}
                  </div>
                  {valueMode === 'fixed' && (
                    <>
                      <input style={inputStyle} value={fixedValue} onChange={(e) => setFixedValue(e.target.value)} placeholder="支持 {{变量名}} 引用" list="available-vars" />
                      <datalist id="available-vars">
                        {availableVars.map((v) => (
                          <option key={v} value={`{{${v}}}`} />
                        ))}
                      </datalist>
                    </>
                  )}
                  {valueMode === 'randomString' && (
                    <label style={labelStyle}>长度<input style={inputStyle} value={genLength} onChange={(e) => setGenLength(e.target.value)} inputMode="numeric" /></label>
                  )}
                  {valueMode === 'randomNumber' && (
                    <div className="flex gap-2">
                      <label style={{ ...labelStyle, flex: 1 }}>最小<input style={inputStyle} value={genMin} onChange={(e) => setGenMin(e.target.value)} inputMode="numeric" /></label>
                      <label style={{ ...labelStyle, flex: 1 }}>最大<input style={inputStyle} value={genMax} onChange={(e) => setGenMax(e.target.value)} inputMode="numeric" /></label>
                    </div>
                  )}
                  {valueMode === 'prefixTimestamp' && (
                    <input style={inputStyle} value={genPrefix} onChange={(e) => setGenPrefix(e.target.value)} placeholder="前缀，如 测试-" />
                  )}
                </>
              )}
            </div>
          )}

          {kind === 'assertText' && (
            <label style={labelStyle}>
              期望文本
              <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={3} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            </label>
          )}
          {kind === 'assertJson' && (
            <label style={labelStyle}>
              期望 JSON（整段深比较）
              <textarea style={{ ...inputStyle, fontFamily: 'monospace' }} rows={6} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            </label>
          )}
          {kind === 'extract' && (
            <label style={labelStyle}>
              变量名
              <input style={inputStyle} value={varName} onChange={(e) => setVarName(e.target.value)} />
            </label>
          )}
          {kind === 'aiStep' && (
            <label style={labelStyle}>
              自然语言指令（保存后自动编译）
              <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
            </label>
          )}
          {kind === 'navigate' && (
            <label style={labelStyle}>
              URL
              <input style={inputStyle} value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
          )}
          {kind === 'waitFor' && (
            <label style={labelStyle}>
              超时 (ms，留空默认 5000)
              <input style={inputStyle} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} inputMode="numeric" />
            </label>
          )}
          {kind === 'check' && (
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              勾选（取消勾选则为取消勾选操作）
            </label>
          )}
          {kind === 'upload' && (
            <div className="flex flex-col gap-2">
              <span style={labelStyle}>绑定回放文件（按 project 隔离，≤ 10 MB）</span>
              <input
                type="file"
                style={inputStyle}
                onChange={async (e) => {
                  if (!caseId) return;
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 10 * 1024 * 1024) {
                    setError('文件超过 10MB 上限');
                    return;
                  }
                  try {
                    const r = await api.attachments.upload(caseId, f);
                    setFileId(r.id);
                    setError('');
                    api.attachments
                      .list(caseId)
                      .then(setAttachments)
                      .catch(() => {});
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              />
              {attachments.length > 0 && (
                <>
                  <span style={labelStyle}>—— 或从本 project 已上传文件选择 ——</span>
                  <ul
                    style={{
                      maxHeight: 160,
                      overflowY: 'auto',
                      border: '1px solid var(--color-glass-border)',
                      borderRadius: 6,
                      padding: 0,
                      margin: 0,
                      listStyle: 'none',
                    }}
                  >
                    {attachments.map((a) => (
                      <li
                        key={a.id}
                        onClick={() => setFileId(a.id)}
                        style={{
                          padding: '6px 8px',
                          cursor: 'pointer',
                          background: fileId === a.id ? 'var(--color-accent)' : 'transparent',
                          color: fileId === a.id ? '#fff' : 'var(--color-foreground-secondary)',
                          fontSize: 11,
                          display: 'flex',
                          gap: 8,
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          borderBottom: '1px solid var(--color-glass-border)',
                        }}
                      >
                        <span className="truncate" style={{ flex: 1 }}>{a.originalName}</span>
                        <span style={{ fontFamily: 'monospace', opacity: 0.7, fontSize: 10 }}>
                          {a.sha256.slice(0, 8)}… · {formatBytes(a.size)} · {shortDateTime(a.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {fileId && (
                <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                  已绑定 fileId: <code>{fileId.slice(0, 8)}…</code>
                  <button
                    onClick={() => setFileId(undefined)}
                    style={{
                      marginLeft: 8,
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--color-accent)',
                      cursor: 'pointer',
                      fontSize: 11,
                    }}
                  >
                    更换
                  </button>
                </p>
              )}
            </div>
          )}

          {error && <p className="text-[12px]" style={{ color: 'var(--color-destructive)' }}>{error}</p>}

          <div className="flex gap-2 justify-end mt-2">
            <button onClick={onClose} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-secondary)', cursor: 'pointer' }}>
              取消
            </button>
            <button onClick={handleSave} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--color-accent)', color: '#fff', cursor: 'pointer' }}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}