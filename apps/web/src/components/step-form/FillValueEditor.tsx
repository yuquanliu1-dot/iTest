import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Segmented from '../ui/Segmented';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';

type ValueMode = 'fixed' | 'randomString' | 'randomNumber' | 'timestamp' | 'prefixTimestamp' | 'composite';
type DateFormat = 'YYYYMMDD' | 'YYYY-MM-DD' | 'YYYY/MM/DD';

interface FragmentDraft {
  mode: 'fixed' | 'date' | 'randomNumber' | 'randomString' | 'timestamp';
  value?: string;
  format?: DateFormat;
  min?: string;
  max?: string;
  length?: string;
}

interface Props {
  value: unknown;
  onChange: (next: unknown) => void;
  availableVars?: string[];
  datasetVars?: string[];
}

const MODE_OPTIONS: Array<{ value: ValueMode; key: string }> = [
  { value: 'fixed', key: 'cases:fillModeFixed' },
  { value: 'randomString', key: 'cases:fillModeRandomString' },
  { value: 'randomNumber', key: 'cases:fillModeRandomNumber' },
  { value: 'timestamp', key: 'cases:fillModeTimestamp' },
  { value: 'prefixTimestamp', key: 'cases:fillModePrefixTimestamp' },
  { value: 'composite', key: 'cases:fillModeComposite' },
];

function draftFromValue(v: unknown): FragmentDraft[] {
  if (v && typeof v === 'object' && (v as { mode?: string }).mode === 'composite') {
    return ((v as { fragments: unknown[] }).fragments ?? []).map((f: unknown) => {
      const o = f as Record<string, unknown>;
      if (o.mode === 'fixed') return { mode: 'fixed' as const, value: String(o.value ?? '') };
      if (o.mode === 'date') return { mode: 'date' as const, format: (o.format as DateFormat) ?? 'YYYYMMDD' };
      if (o.mode === 'randomNumber')
        return { mode: 'randomNumber' as const, min: String(o.min ?? 0), max: String(o.max ?? 999999), length: o.length != null ? String(o.length) : '' };
      if (o.mode === 'randomString') return { mode: 'randomString' as const, length: String(o.length ?? 12) };
      return { mode: 'timestamp' as const };
    });
  }
  return [{ mode: 'fixed', value: '' }];
}

/**
 * fill/select 值编辑器：固定值 / 生成器 / 组合片段。受控组件，draft 只在内部做输入缓冲。
 * 内部 state 仅在挂载时从 value 初始化一次，不响应后续 value prop 变化——
 * 当 value 身份变化（切换步骤/类型）时父组件必须通过 key 重挂载本组件。
 */
export default function FillValueEditor({ value, onChange, availableVars = [], datasetVars = [] }: Props) {
  const { t } = useTranslation();
  const extractOnly = availableVars.filter((v) => !datasetVars.includes(v));
  const isObj = typeof value === 'object' && value !== null;
  const objMode = isObj ? ((value as { mode?: string }).mode as ValueMode | undefined) : undefined;
  const initialMode: ValueMode = objMode ?? 'fixed';
  const [mode, setMode] = useState<ValueMode>(initialMode);
  const [fixed, setFixed] = useState(isObj ? '' : String(value ?? ''));
  const [genLength, setGenLength] = useState(isObj ? String((value as { length?: number }).length ?? 12) : '12');
  const [genMin, setGenMin] = useState(isObj ? String((value as { min?: number }).min ?? 0) : '0');
  const [genMax, setGenMax] = useState(isObj ? String((value as { max?: number }).max ?? 999999) : '999999');
  const [genPrefix, setGenPrefix] = useState(isObj ? String((value as { prefix?: string }).prefix ?? '') : '');
  const [fragments, setFragments] = useState<FragmentDraft[]>(() => draftFromValue(value));

  /** 片段 → 存储 shape（与 StepEditModal handleSave 的映射一致） */
  const buildFragment = (f: FragmentDraft): Record<string, unknown> => {
    if (f.mode === 'fixed') return { mode: 'fixed', value: f.value ?? '' };
    if (f.mode === 'date') return { mode: 'date', format: f.format ?? 'YYYYMMDD' };
    if (f.mode === 'randomNumber') {
      const out: Record<string, unknown> = { mode: 'randomNumber', min: Number(f.min) || 0, max: Number(f.max) || 999999 };
      if (f.length) out.length = Number(f.length);
      return out;
    }
    if (f.mode === 'randomString') return { mode: 'randomString', length: Number(f.length) || 12 };
    return { mode: 'timestamp' };
  };

  const estLen = fragments.reduce((sum, f) => {
    if (f.mode === 'fixed') return sum + (f.value?.length ?? 0);
    if (f.mode === 'date') return sum + (f.format?.length ?? 8);
    if (f.mode === 'randomNumber') return sum + (f.length ? Number(f.length) : String(Number(f.max) || 999999).length);
    if (f.mode === 'randomString') return sum + (Number(f.length) || 12);
    return sum + 13;
  }, 0);
  const over = estLen > 1024;

  const commitMode = (m: ValueMode) => {
    setMode(m);
    if (m === 'fixed') onChange(fixed);
    else if (m === 'randomString') onChange({ mode: 'randomString', length: Number(genLength) || 12 });
    else if (m === 'randomNumber') onChange({ mode: 'randomNumber', min: Number(genMin) || 0, max: Number(genMax) || 999999 });
    else if (m === 'timestamp') onChange({ mode: 'timestamp' });
    else if (m === 'prefixTimestamp') onChange({ mode: 'prefixTimestamp', prefix: genPrefix });
    else onChange({ mode: 'composite', fragments: fragments.map(buildFragment) });
  };

  const patchFragment = (i: number, patch: Partial<FragmentDraft>) => {
    const next = fragments.map((f, idx) => (idx === i ? { ...f, ...patch } : f));
    setFragments(next);
    if (mode === 'composite') onChange({ mode: 'composite', fragments: next.map(buildFragment) });
  };

  return (
    <div className="flex flex-col gap-2">
      <Segmented<ValueMode>
        options={MODE_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) }))}
        value={mode}
        onChange={commitMode}
      />

      {mode === 'fixed' && (
        <>
          <input
            className="input-base input-sm"
            value={fixed}
            onChange={(e) => { setFixed(e.target.value); onChange(e.target.value); }}
            placeholder={t('cases:fillVarPlaceholder', { col: '{{变量名}}' })}
            list="drawer-available-vars"
          />
          <datalist id="drawer-available-vars">
            {availableVars.map((v) => <option key={v} value={`{{${v}}}`} />)}
          </datalist>
          {availableVars.length > 0 && (
            <div className="text-[10px] mt-1 flex gap-3" style={{ color: 'var(--muted-foreground)' }}>
              {datasetVars.length > 0 && <span>{t('cases:datasetColumns')}{datasetVars.map((v) => `{{${v}}}`).join('、')}</span>}
              {extractOnly.length > 0 && (
                <span>{t('cases:extractVars')}{extractOnly.map((v) => `{{${v}}}`).join('、')}</span>
              )}
            </div>
          )}
        </>
      )}
      {mode === 'randomString' && (
        <label className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          {t('cases:lengthLabel')}
          <input className="input-base input-sm" value={genLength} inputMode="numeric"
            onChange={(e) => { setGenLength(e.target.value); onChange({ mode: 'randomString', length: Number(e.target.value) || 12 }); }} />
        </label>
      )}
      {mode === 'randomNumber' && (
        <div className="flex gap-2">
          <label className="text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>{t('cases:minLabel')}
            <input className="input-base input-sm" value={genMin} inputMode="numeric"
              onChange={(e) => { setGenMin(e.target.value); onChange({ mode: 'randomNumber', min: Number(e.target.value) || 0, max: Number(genMax) || 999999 }); }} />
          </label>
          <label className="text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>{t('cases:maxLabel')}
            <input className="input-base input-sm" value={genMax} inputMode="numeric"
              onChange={(e) => { setGenMax(e.target.value); onChange({ mode: 'randomNumber', min: Number(genMin) || 0, max: Number(e.target.value) || 999999 }); }} />
          </label>
        </div>
      )}
      {mode === 'prefixTimestamp' && (
        <input className="input-base input-sm" value={genPrefix} placeholder={t('cases:prefixPlaceholder')}
          onChange={(e) => { setGenPrefix(e.target.value); onChange({ mode: 'prefixTimestamp', prefix: e.target.value }); }} />
      )}
      {mode === 'composite' && (
        <div className="flex flex-col gap-2">
          {fragments.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                className="input-base input-sm"
                style={{ width: 110, flex: '0 0 110px' }}
                value={f.mode}
                onChange={(e) => {
                  const m = e.target.value as FragmentDraft['mode'];
                  const patch: Partial<FragmentDraft> =
                    m === 'fixed' ? { mode: 'fixed', value: '' }
                    : m === 'date' ? { mode: 'date', format: 'YYYYMMDD' }
                    : m === 'randomNumber' ? { mode: 'randomNumber', min: '0', max: '999999', length: '' }
                    : m === 'randomString' ? { mode: 'randomString', length: '12' }
                    : { mode: 'timestamp' };
                  patchFragment(i, patch);
                }}
              >
                <option value="fixed">{t('cases:fillModeFixed')}</option>
                <option value="date">{t('cases:fillModeDate')}</option>
                <option value="randomNumber">{t('cases:fillModeRandomNumber')}</option>
                <option value="randomString">{t('cases:fillModeRandomString')}</option>
                <option value="timestamp">{t('cases:fillModeTimestamp')}</option>
              </select>
              {f.mode === 'fixed' && (
                <input className="input-base input-sm" style={{ flex: 1, minWidth: 0 }} value={f.value ?? ''}
                  onChange={(e) => patchFragment(i, { value: e.target.value })} />
              )}
              {f.mode === 'date' && (
                <select className="input-base input-sm" style={{ flex: 1 }} value={f.format}
                  onChange={(e) => patchFragment(i, { format: e.target.value as DateFormat })}>
                  <option value="YYYYMMDD">YYYYMMDD</option>
                  <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                  <option value="YYYY/MM/DD">YYYY/MM/DD</option>
                </select>
              )}
              {f.mode === 'randomNumber' && (
                <>
                  <input className="input-base input-sm" style={{ width: 70 }} placeholder="min" inputMode="numeric" value={f.min ?? ''}
                    onChange={(e) => patchFragment(i, { min: e.target.value })} />
                  <input className="input-base input-sm" style={{ width: 70 }} placeholder="max" inputMode="numeric" value={f.max ?? ''}
                    onChange={(e) => patchFragment(i, { max: e.target.value })} />
                  <input className="input-base input-sm" style={{ width: 70 }} placeholder={t('cases:digitsPlaceholder')} inputMode="numeric" value={f.length ?? ''}
                    onChange={(e) => patchFragment(i, { length: e.target.value })} />
                </>
              )}
              {f.mode === 'randomString' && (
                <input className="input-base input-sm" style={{ width: 100 }} placeholder={t('cases:lengthLabel')} inputMode="numeric" value={f.length ?? ''}
                  onChange={(e) => patchFragment(i, { length: e.target.value })} />
              )}
              {f.mode === 'timestamp' && <span className="text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>{t('cases:currentMsTimestamp')}</span>}
              <IconButton
                icon="x"
                title={t('cases:deleteFragment')}
                tone="destructive"
                size="sm"
                onClick={() => {
                  const next = fragments.filter((_, idx) => idx !== i);
                  setFragments(next);
                  onChange({ mode: 'composite', fragments: next.map(buildFragment) });
                }}
              />
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => {
              const next: FragmentDraft[] = [...fragments, { mode: 'fixed', value: '' }];
              setFragments(next);
              onChange({ mode: 'composite', fragments: next.map(buildFragment) });
            }}
          >
            {t('cases:addFragment')}
          </Button>
          <p className="text-[11px]" style={{ color: over ? 'var(--destructive)' : 'var(--muted-foreground)' }}>
            {t('cases:estLength', { len: estLen })}{over ? t('cases:overLimit') : ''}
          </p>
        </div>
      )}
    </div>
  );
}