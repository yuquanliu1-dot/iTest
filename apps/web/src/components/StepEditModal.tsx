import { useEffect, useState, type CSSProperties } from 'react';
import type { StepClip } from '../stores/stepClipboard';
import { api } from '../api/client';
import { formatBytes, shortDateTime, stepKindLabel } from '../lib/format';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/Modal';
import Button from './ui/Button';
import Input from './ui/Input';
import Segmented from './ui/Segmented';
import Icon from './Icon';

interface Props {
  initial: StepClip;
  /** 用例中已定义的变量名（extract 步骤产出），用于 fill 值的引用提示 */
  availableVars?: string[];
  /** 当前 case id，用于附件上传接口 */
  caseId?: string;
  onSave: (next: StepClip) => void;
  onClose: () => void;
}

type ValueMode = 'fixed' | 'randomString' | 'randomNumber' | 'timestamp' | 'prefixTimestamp' | 'composite';
type DateFormat = 'YYYYMMDD' | 'YYYY-MM-DD' | 'YYYY/MM/DD';

interface CompositeDraft {
  mode: 'composite';
  fragments: Array<
    | { mode: 'fixed'; value: string }
    | { mode: 'date'; format: DateFormat }
    | { mode: 'randomNumber'; min: string; max: string; length: string }
    | { mode: 'randomString'; length: string }
    | { mode: 'timestamp' }
  >;
}

const VALUE_MODE_LABELS: Record<ValueMode, string> = {
  fixed: '固定值',
  randomString: '随机字符串',
  randomNumber: '随机数字',
  timestamp: '时间戳',
  prefixTimestamp: '前缀 + 时间戳',
  composite: '组合值',
};

const FRAGMENT_MODE_OPTIONS: Array<{ value: CompositeDraft['fragments'][number]['mode']; label: string }> = [
  { value: 'fixed', label: '固定值' },
  { value: 'date', label: '日期' },
  { value: 'randomNumber', label: '随机数字' },
  { value: 'randomString', label: '随机字符串' },
  { value: 'timestamp', label: '时间戳' },
];

/** 与服务端 aiStepSplit.splitByNumber 保持同一行匹配规则：`1. ` 需空格、`1、` 可无空格。 */
function countNumberedSegments(text: string): number {
  const re = /^[ \t]*\d+(?:\.[ \t]+|、[ \t]*)(.+)$/;
  return text.split(/\r?\n/).filter((line) => re.test(line)).length;
}

const fieldStyle: CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 13,
  border: '1px solid var(--color-glass-border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-background-subtle)',
  color: 'var(--color-foreground)',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s ease, background 0.15s ease',
  outline: 'none',
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--color-foreground-muted)',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
};

const ghostBtnStyle: CSSProperties = {
  fontSize: 11,
  padding: '5px 10px',
  borderRadius: 6,
  border: '1px dashed var(--color-glass-border)',
  background: 'transparent',
  color: 'var(--color-foreground-muted)',
  cursor: 'pointer',
};

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

  // composite
  const isComposite = valueMode === 'composite';
  const [compositeDraft, setCompositeDraft] = useState<CompositeDraft>(() => {
    if (isGenerator && (rawValue as { mode?: string }).mode === 'composite') {
      const v = rawValue as { fragments: unknown[] };
      return {
        mode: 'composite',
        fragments: v.fragments.map((f: unknown) => {
          const o = f as { mode: string };
          if (o.mode === 'fixed') return { mode: 'fixed', value: (f as { value: string }).value };
          if (o.mode === 'date') return { mode: 'date', format: (f as { format: DateFormat }).format };
          if (o.mode === 'randomNumber') {
            const rn = f as { min?: number; max?: number; length?: number };
            return {
              mode: 'randomNumber',
              min: String(rn.min ?? 0),
              max: String(rn.max ?? 999999),
              length: rn.length != null ? String(rn.length) : '',
            };
          }
          if (o.mode === 'randomString') return { mode: 'randomString', length: String((f as { length?: number }).length ?? 12) };
          return { mode: 'timestamp' };
        }) as CompositeDraft['fragments'],
      };
    }
    return { mode: 'composite', fragments: [{ mode: 'fixed', value: '' }] };
  });

  const compositeLen = compositeDraft.fragments.reduce((sum, f) => {
    switch (f.mode) {
      case 'fixed': return sum + f.value.length;
      case 'date': return sum + f.format.length;
      case 'randomNumber': return sum + (f.length ? Number(f.length) : String(Number(f.max) || 999999).length);
      case 'randomString': return sum + Number(f.length || 12);
      case 'timestamp': return sum + 13;
    }
  }, 0);
  const compositeOver = compositeLen > 1024;

  // assertText/assertJson
  const [equalsText, setEqualsText] = useState(
    kind === 'assertJson' ? JSON.stringify(action.equals ?? null, null, 2) : String(action.equals ?? ''),
  );
  // assertText target/match
  const [assertTarget, setAssertTarget] = useState<'specifiedElement' | 'page' | 'errorMessage' | 'url'>(
    ((action as { target?: 'specifiedElement' | 'page' | 'errorMessage' | 'url' }).target) ?? 'specifiedElement',
  );
  const [assertMatch, setAssertMatch] = useState<'equals' | 'contains' | 'notContains' | 'regex'>(
    ((action as { match?: 'equals' | 'contains' | 'notContains' | 'regex' }).match) ?? 'equals',
  );
  // extract
  const [varName, setVarName] = useState(String(action.varName ?? ''));
  const [extractMode, setExtractMode] = useState<'completeValue' | 'smartExtract' | 'regex'>(
    ((action as { mode?: 'completeValue' | 'smartExtract' | 'regex' }).mode) ?? 'completeValue',
  );
  const [extractPattern, setExtractPattern] = useState(String((action as { pattern?: string }).pattern ?? ''));
  const [extractGroup, setExtractGroup] = useState(String((action as { group?: number }).group ?? '1'));
  const [extractDescription, setExtractDescription] = useState(String((action as { description?: string }).description ?? ''));
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState('');
  // aiStep
  const [instruction, setInstruction] = useState(String(action.instruction ?? ''));
  const [showBoundary, setShowBoundary] = useState(false);
  const splitPreview = countNumberedSegments(instruction);
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
      case 'composite':
        return { mode: 'composite', fragments: compositeDraft.fragments };
    }
  };

  const handleSave = () => {
    const next: Record<string, unknown> = { ...action };
    if (kind === 'fill' || kind === 'select') {
      if (valueMode === 'composite') {
        if (compositeOver) {
          setError('CompositeValue 总长度超过 1024');
          return;
        }
        next.value = {
          mode: 'composite',
          fragments: compositeDraft.fragments.map((f) => {
            if (f.mode === 'fixed') return { mode: 'fixed', value: f.value };
            if (f.mode === 'date') return { mode: 'date', format: f.format };
            if (f.mode === 'randomNumber') {
              const out: { mode: 'randomNumber'; min: number; max: number; length?: number } = {
                mode: 'randomNumber',
                min: Number(f.min) || 0,
                max: Number(f.max) || 999999,
              };
              if (f.length) out.length = Number(f.length);
              return out;
            }
            if (f.mode === 'randomString') return { mode: 'randomString', length: Number(f.length) || 12 };
            return { mode: 'timestamp' };
          }),
        };
      } else {
        next.value = buildValue();
      }
    }
    if (kind === 'fill') {
      if (sensitive) {
        if (!pwdDraft) {
          setError('已加密 - 修改时请输入新密码');
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
    if (kind === 'assertText') {
      next.equals = equalsText;
      next.target = assertTarget;
      next.match = assertMatch;
      if (assertTarget !== 'specifiedElement') next.locator = [];
    }
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
      next.mode = extractMode;
      if (extractMode === 'regex') {
        if (!extractPattern.trim()) {
          setError('正则匹配需要填写正则表达式');
          return;
        }
        next.pattern = extractPattern.trim();
        next.group = Number(extractGroup) >= 0 ? Number(extractGroup) : 0;
      } else if (extractMode === 'smartExtract') {
        if (!extractDescription.trim() && !extractPattern.trim()) {
          setError('智能抽取需要填写描述并生成正则');
          return;
        }
        if (extractDescription.trim()) next.description = extractDescription.trim();
        else delete next.description;
        // 已生成的 pattern/group 保留（回放按 regex 执行）；未生成则回放走 completeValue 兜底
        if (extractPattern.trim()) {
          next.pattern = extractPattern.trim();
          next.group = Number(extractGroup) >= 0 ? Number(extractGroup) : 0;
        } else {
          delete next.pattern;
          delete next.group;
        }
      } else {
        delete next.pattern;
        delete next.group;
        delete next.description;
      }
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

  const valueModeOptions: Array<{ value: ValueMode; label: string }> = (
    Object.entries(VALUE_MODE_LABELS) as Array<[ValueMode, string]>
  ).map(([value, label]) => ({ value, label }));

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              编辑步骤
              <span
                className="font-mono"
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--color-accent)',
                  background: 'var(--color-accent-light)',
                  padding: '2px 8px',
                  borderRadius: 999,
                  letterSpacing: '0.02em',
                }}
              >
                {stepKindLabel(kind)}
              </span>
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 py-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <label style={labelStyle}>
              步骤名称
              <input
                style={fieldStyle}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="可选"
              />
            </label>
            <label style={labelStyle}>
              执行前等待 (ms)
              <input
                style={fieldStyle}
                value={delayMs}
                onChange={(e) => setDelayMs(e.target.value)}
                placeholder="0"
                inputMode="numeric"
              />
            </label>
          </div>

          {(kind === 'fill' || kind === 'select') && (
            <div className="flex flex-col gap-3">
              {kind === 'fill' && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 12,
                    color: 'var(--color-foreground-secondary)',
                    padding: '8px 10px',
                    border: '1px solid var(--color-glass-border)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--color-background-subtle)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={sensitive}
                    onChange={(e) => setSensitive(e.target.checked)}
                  />
                  敏感值（密码，加密保存，明文不显示）
                </label>
              )}
              {kind === 'fill' && sensitive && (
                <Input
                  label="新密码"
                  type="password"
                  value={pwdDraft}
                  onChange={(e) => setPwdDraft(e.target.value)}
                  placeholder="修改时填写；留空表示保留原值"
                />
              )}
              {!sensitive && (
                <>
                  <div className="flex flex-col gap-2">
                    <span style={labelStyle}>值生成方式</span>
                    <Segmented<ValueMode>
                      options={valueModeOptions}
                      value={valueMode}
                      onChange={setValueMode}
                    />
                  </div>

                  {valueMode === 'fixed' && (
                    <div className="flex flex-col gap-1.5">
                      <Input
                        label="固定值"
                        value={fixedValue}
                        onChange={(e) => setFixedValue(e.target.value)}
                        placeholder="支持 {{变量名}} 引用"
                        list="available-vars"
                      />
                      <datalist id="available-vars">
                        {availableVars.map((v) => (
                          <option key={v} value={`{{${v}}}`} />
                        ))}
                      </datalist>
                      {availableVars.length > 0 && (
                        <p className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                          已识别变量：{availableVars.map((v) => `{{${v}}}`).join(', ')}
                        </p>
                      )}
                    </div>
                  )}
                  {valueMode === 'randomString' && (
                    <Input
                      label="长度"
                      value={genLength}
                      onChange={(e) => setGenLength(e.target.value)}
                      inputMode="numeric"
                    />
                  )}
                  {valueMode === 'randomNumber' && (
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="最小值"
                        value={genMin}
                        onChange={(e) => setGenMin(e.target.value)}
                        inputMode="numeric"
                      />
                      <Input
                        label="最大值"
                        value={genMax}
                        onChange={(e) => setGenMax(e.target.value)}
                        inputMode="numeric"
                      />
                    </div>
                  )}
                  {valueMode === 'prefixTimestamp' && (
                    <Input
                      label="前缀"
                      value={genPrefix}
                      onChange={(e) => setGenPrefix(e.target.value)}
                      placeholder="如 测试-"
                    />
                  )}
                  {valueMode === 'composite' && (
                    <div className="flex flex-col gap-2" data-stagger>
                      <span style={labelStyle}>片段</span>
                      {compositeDraft.fragments.map((f, idx) => (
                        <div
                          key={idx}
                          data-stagger-item
                          className="flex items-center gap-2 fade-in"
                          style={{
                            padding: '8px 10px',
                            border: '1px solid var(--color-glass-border)',
                            borderRadius: 'var(--radius-md)',
                            background: 'var(--color-background-subtle)',
                          }}
                        >
                          <select
                            style={{ ...fieldStyle, width: 124, padding: '6px 8px', fontSize: 12 }}
                            value={f.mode}
                            onChange={(e) => {
                              const mode = e.target.value as CompositeDraft['fragments'][number]['mode'];
                              const next = [...compositeDraft.fragments];
                              if (mode === 'fixed') next[idx] = { mode: 'fixed', value: '' };
                              else if (mode === 'date') next[idx] = { mode: 'date', format: 'YYYYMMDD' };
                              else if (mode === 'randomNumber') next[idx] = { mode: 'randomNumber', min: '0', max: '999999', length: '' };
                              else if (mode === 'randomString') next[idx] = { mode: 'randomString', length: '12' };
                              else next[idx] = { mode: 'timestamp' };
                              setCompositeDraft({ ...compositeDraft, fragments: next });
                            }}
                          >
                            {FRAGMENT_MODE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                          {f.mode === 'fixed' && (
                            <input
                              style={{ ...fieldStyle, flex: 1, padding: '6px 8px', fontSize: 12 }}
                              value={f.value}
                              onChange={(e) => {
                                const next = [...compositeDraft.fragments];
                                next[idx] = { mode: 'fixed', value: e.target.value };
                                setCompositeDraft({ ...compositeDraft, fragments: next });
                              }}
                            />
                          )}
                          {f.mode === 'date' && (
                            <select
                              style={{ ...fieldStyle, flex: 1, padding: '6px 8px', fontSize: 12 }}
                              value={f.format}
                              onChange={(e) => {
                                const next = [...compositeDraft.fragments];
                                next[idx] = { mode: 'date', format: e.target.value as DateFormat };
                                setCompositeDraft({ ...compositeDraft, fragments: next });
                              }}
                            >
                              <option value="YYYYMMDD">YYYYMMDD</option>
                              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                              <option value="YYYY/MM/DD">YYYY/MM/DD</option>
                            </select>
                          )}
                          {f.mode === 'randomNumber' && (
                            <>
                              <Input
                                className="w-[68px]"
                                size="sm"
                                placeholder="min"
                                inputMode="numeric"
                                value={f.min}
                                onChange={(e) => {
                                  const next = [...compositeDraft.fragments];
                                  next[idx] = { mode: 'randomNumber', min: e.target.value, max: f.max, length: f.length };
                                  setCompositeDraft({ ...compositeDraft, fragments: next });
                                }}
                              />
                              <Input
                                className="w-[68px]"
                                size="sm"
                                placeholder="max"
                                inputMode="numeric"
                                value={f.max}
                                onChange={(e) => {
                                  const next = [...compositeDraft.fragments];
                                  next[idx] = { mode: 'randomNumber', min: f.min, max: e.target.value, length: f.length };
                                  setCompositeDraft({ ...compositeDraft, fragments: next });
                                }}
                              />
                              <Input
                                className="w-[68px]"
                                size="sm"
                                placeholder="位数"
                                inputMode="numeric"
                                value={f.length}
                                onChange={(e) => {
                                  const next = [...compositeDraft.fragments];
                                  next[idx] = { mode: 'randomNumber', min: f.min, max: f.max, length: e.target.value };
                                  setCompositeDraft({ ...compositeDraft, fragments: next });
                                }}
                              />
                            </>
                          )}
                          {f.mode === 'randomString' && (
                            <Input
                              className="w-[96px]"
                              size="sm"
                              placeholder="长度"
                              inputMode="numeric"
                              value={f.length}
                              onChange={(e) => {
                                const next = [...compositeDraft.fragments];
                                next[idx] = { mode: 'randomString', length: e.target.value };
                                setCompositeDraft({ ...compositeDraft, fragments: next });
                              }}
                            />
                          )}
                          {f.mode === 'timestamp' && (
                            <span
                              style={{
                                ...labelStyle,
                                flex: 1,
                                fontWeight: 400,
                                color: 'var(--color-foreground-secondary)',
                                textTransform: 'none',
                                letterSpacing: 0,
                              }}
                            >
                              当前 ms 时间戳
                            </span>
                          )}
                          <button
                            type="button"
                            className="press"
                            onClick={() => {
                              const next = compositeDraft.fragments.filter((_, i) => i !== idx);
                              setCompositeDraft({ ...compositeDraft, fragments: next });
                            }}
                            aria-label={`删除片段 ${idx + 1}`}
                            style={{
                              background: 'transparent',
                              border: '1px solid var(--color-glass-border)',
                              cursor: 'pointer',
                              color: 'var(--color-destructive)',
                              padding: 0,
                              width: 24,
                              height: 24,
                              borderRadius: 5,
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              transition: 'background 0.15s ease, border-color 0.15s ease',
                            }}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        style={ghostBtnStyle}
                        className="press"
                        onClick={() => setCompositeDraft({ ...compositeDraft, fragments: [...compositeDraft.fragments, { mode: 'fixed', value: '' }] })}
                      >
                        + 添加片段
                      </button>
                      <p
                        className="text-[11px] font-mono"
                        style={{ color: compositeOver ? 'var(--color-destructive)' : 'var(--color-foreground-muted)' }}
                      >
                        当前长度估算：{compositeLen} / 1024{compositeOver ? ' · 超过上限' : ''}
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {kind === 'assertText' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label style={labelStyle}>
                  断言目标
                  <select
                    style={fieldStyle}
                    value={assertTarget}
                    onChange={(e) => setAssertTarget(e.target.value as typeof assertTarget)}
                  >
                    <option value="specifiedElement">指定元素（locator 必填）</option>
                    <option value="page">整页文本</option>
                    <option value="errorMessage">错误提示区</option>
                    <option value="url">当前 URL</option>
                  </select>
                </label>
                <label style={labelStyle}>
                  匹配方式
                  <select
                    style={fieldStyle}
                    value={assertMatch}
                    onChange={(e) => setAssertMatch(e.target.value as typeof assertMatch)}
                  >
                    <option value="equals">等于（trim）</option>
                    <option value="contains">包含</option>
                    <option value="notContains">不包含</option>
                    <option value="regex">正则匹配</option>
                  </select>
                </label>
              </div>
              <label style={labelStyle}>
                期望文本
                <textarea
                  style={{ ...fieldStyle, fontFamily: 'inherit', minHeight: 72 }}
                  rows={3}
                  value={equalsText}
                  onChange={(e) => setEqualsText(e.target.value)}
                />
              </label>
            </>
          )}
          {kind === 'assertJson' && (
            <label style={labelStyle}>
              期望 JSON（整段深比较）
              <textarea
                style={{ ...fieldStyle, fontFamily: 'var(--font-mono, monospace)', minHeight: 120 }}
                rows={6}
                value={equalsText}
                onChange={(e) => setEqualsText(e.target.value)}
              />
            </label>
          )}
          {kind === 'extract' && (
            <div className="flex flex-col gap-3">
              <Input
                label="变量名"
                value={varName}
                onChange={(e) => setVarName(e.target.value)}
              />
              <label style={labelStyle}>
                抽取方式
                <select
                  style={fieldStyle}
                  value={extractMode}
                  onChange={(e) => setExtractMode(e.target.value as typeof extractMode)}
                >
                  <option value="completeValue">完整值（元素文本 / input 值）</option>
                  <option value="smartExtract">智能抽取（按描述生成正则）</option>
                  <option value="regex">正则匹配</option>
                </select>
              </label>
              {extractMode === 'regex' && (
                <div className="grid grid-cols-[1fr,80px] gap-2">
                  <Input
                    label="正则"
                    value={extractPattern}
                    onChange={(e) => setExtractPattern(e.target.value)}
                    placeholder="如 ORD-\d+"
                    style={{ fontFamily: 'var(--font-mono, monospace)' }}
                  />
                  <Input
                    label="捕获组"
                    value={extractGroup}
                    onChange={(e) => setExtractGroup(e.target.value)}
                    inputMode="numeric"
                    placeholder="0"
                  />
                </div>
              )}
              {extractMode === 'smartExtract' && (
                <div className="flex flex-col gap-2">
                  <label style={labelStyle}>
                    抽取描述（自然语言）
                    <textarea
                      style={{ ...fieldStyle, fontFamily: 'inherit', minHeight: 56 }}
                      rows={2}
                      value={extractDescription}
                      onChange={(e) => setExtractDescription(e.target.value)}
                      placeholder="如：提取订单号"
                    />
                  </label>
                  <div>
                    <button
                      type="button"
                      style={ghostBtnStyle}
                      className="press"
                      disabled={compiling}
                      onClick={async () => {
                        if (!caseId) {
                          setCompileErr('缺少 caseId，无法编译');
                          return;
                        }
                        const sampleText = window.prompt('请粘贴一段包含目标片段的样本文本', '');
                        if (!sampleText) return;
                        setCompiling(true);
                        setCompileErr('');
                        try {
                          const r = await api.cases.compileExtract(caseId, { description: extractDescription.trim(), sampleText });
                          if (r.pattern) {
                            setExtractPattern(r.pattern);
                            setExtractGroup(String(r.group ?? 0));
                          } else {
                            setCompileErr(r.error ?? '编译失败');
                          }
                        } catch (err) {
                          setCompileErr((err as Error).message);
                        } finally {
                          setCompiling(false);
                        }
                      }}
                    >
                      {compiling ? '编译中…' : '生成正则'}
                    </button>
                  </div>
                  {compileErr && (
                    <p className="text-[11px]" style={{ color: 'var(--color-destructive)' }}>{compileErr}</p>
                  )}
                  {extractPattern && (
                    <p className="text-[11px] font-mono" style={{ color: 'var(--color-foreground-muted)' }}>
                      已生成正则：{extractPattern}（捕获组 {extractGroup}，保存后回放按正则执行）
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          {kind === 'aiStep' && (
            <div className="flex flex-col gap-2">
              <label style={labelStyle}>
                自然语言指令（保存后自动编译）
                <textarea
                  style={{ ...fieldStyle, fontFamily: 'inherit', minHeight: 88 }}
                  rows={3}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="可用 #cssSelector 引用页面元素，例: 识别图片 #captchaImg 并输入到 #captchaInput"
                />
              </label>
              {splitPreview >= 2 && (
                <p
                  className="text-[11px]"
                  style={{
                    color: 'var(--color-accent)',
                    background: 'var(--color-accent-light)',
                    padding: '6px 10px',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  检测到 {splitPreview} 条编号，保存时将自动拆为 {splitPreview} 条独立智能步骤
                </p>
              )}
              <div>
                <button
                  type="button"
                  style={ghostBtnStyle}
                  className="press"
                  onClick={() => setShowBoundary((v) => !v)}
                >
                  {showBoundary ? '收起使用边界' : '查看使用边界'}
                </button>
              </div>
              {showBoundary && (
                <div
                  className="text-[11px] flex flex-col gap-1 fade-in"
                  style={{
                    color: 'var(--color-foreground-secondary)',
                    background: 'var(--color-background-subtle)',
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-glass-border)',
                  }}
                >
                  <p>智能步骤适合复杂页面、动态选择、第一条结果等场景。</p>
                  <p>不建议用于登录、支付、删除审批等高风险路径，也不用于发布准入的关键确定性步骤。</p>
                  <p>强对抗验证码（滑块、点选、行为验证）不适用；仅适合测试环境中的简单图片验证码。</p>
                  <p>关键结果请使用文本断言 / JSON 断言，不要把验证全部塞进智能步骤。</p>
                </div>
              )}
            </div>
          )}
          {kind === 'navigate' && (
            <Input
              label="URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
          {kind === 'waitFor' && (
            <Input
              label="超时 (ms，留空默认 5000)"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              inputMode="numeric"
            />
          )}
          {kind === 'check' && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontSize: 12,
                color: 'var(--color-foreground-secondary)',
                padding: '8px 10px',
                border: '1px solid var(--color-glass-border)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-background-subtle)',
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              勾选（取消勾选则为取消勾选操作）
            </label>
          )}
          {kind === 'upload' && (
            <div className="flex flex-col gap-3">
              <label style={labelStyle}>
                绑定回放文件（按 project 隔离，≤ 10 MB）
                <input
                  type="file"
                  style={fieldStyle}
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
              </label>
              {attachments.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span style={labelStyle}>从已上传文件中选择</span>
                  <ul
                    data-stagger
                    style={{
                      maxHeight: 180,
                      overflowY: 'auto',
                      border: '1px solid var(--color-glass-border)',
                      borderRadius: 'var(--radius-md)',
                      padding: 4,
                      margin: 0,
                      listStyle: 'none',
                      background: 'var(--color-background-subtle)',
                    }}
                  >
                    {attachments.map((a) => {
                      const selected = fileId === a.id;
                      return (
                        <li
                          key={a.id}
                          data-stagger-item
                          onClick={() => setFileId(a.id)}
                          className="press"
                          style={{
                            padding: '8px 10px',
                            cursor: 'pointer',
                            background: selected ? 'var(--color-accent-light)' : 'transparent',
                            color: selected ? 'var(--color-accent)' : 'var(--color-foreground-secondary)',
                            fontSize: 12,
                            display: 'flex',
                            gap: 8,
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            borderRadius: 'var(--radius-sm)',
                            transition: 'background 0.15s ease, color 0.15s ease',
                          }}
                        >
                          <span className="truncate" style={{ flex: 1 }}>{a.originalName}</span>
                          <span style={{ fontFamily: 'var(--font-mono, monospace)', opacity: 0.75, fontSize: 10 }}>
                            {a.sha256.slice(0, 8)}… · {formatBytes(a.size)} · {shortDateTime(a.createdAt)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {fileId && (
                <p
                  className="text-[11px] flex items-center gap-2"
                  style={{ color: 'var(--color-foreground-muted)' }}
                >
                  已绑定 fileId: <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>{fileId.slice(0, 8)}…</code>
                  <button
                    type="button"
                    onClick={() => setFileId(undefined)}
                    className="press"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--color-accent)',
                      cursor: 'pointer',
                      fontSize: 11,
                      padding: 0,
                    }}
                  >
                    更换
                  </button>
                </p>
              )}
            </div>
          )}

          {error && (
            <p
              className="text-[12px]"
              style={{
                color: 'var(--color-destructive-text)',
                background: 'var(--color-destructive-light)',
                padding: '6px 10px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-destructive-border)',
              }}
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="plain" onClick={onClose}>取消</Button>
          <Button onClick={handleSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
