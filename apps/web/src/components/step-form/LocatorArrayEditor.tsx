import type { Locator } from '@itest/shared';
import IconButton from '../ui/IconButton';

interface Props {
  locators: Locator[];
  onChange: (next: Locator[]) => void;
  /** 以 action.locator 开头的错误，如 { 'action.locator.0.value': '…' } */
  errors?: Record<string, string>;
  /** 移动端用例：补全 accessibilityId/label/predicate 三个移动专用策略。 */
  mobile?: boolean;
}

const STRATEGIES_WEB: Locator['strategy'][] = ['role', 'text', 'testId', 'css', 'xpath'];
const STRATEGIES_MOBILE_EXTRA: Locator['strategy'][] = ['accessibilityId', 'label', 'predicate'];

/** locator 有序候选数组编辑器：录制会产生多个候选，顺序即回放优先级。 */
export default function LocatorArrayEditor({ locators, onChange, errors = {}, mobile }: Props) {
  const strategies = mobile ? [...STRATEGIES_WEB, ...STRATEGIES_MOBILE_EXTRA] : STRATEGIES_WEB;
  const update = (i: number, patch: Partial<Locator>) =>
    onChange(locators.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => onChange(locators.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= locators.length) return;
    const next = [...locators];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {locators.map((l, i) => {
        const err = errors[`action.locator.${i}.value`];
        return (
          <div key={i} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--muted-foreground)' }}>{i + 1}</span>
              <select
                className="input-base input-sm shrink-0"
                style={{ width: 92 }}
                value={l.strategy}
                onChange={(e) => update(i, { strategy: e.target.value as Locator['strategy'] })}
              >
                {strategies.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <input
                className="input-base input-sm"
                style={{ flex: 1, minWidth: 0, ...(err ? { border: '1px solid var(--destructive)' } : {}) }}
                value={l.value}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder="定位值"
              />
              <IconButton icon="arrowUp" title="上移" disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton icon="arrowDown" title="下移" disabled={i === locators.length - 1} onClick={() => move(i, 1)} />
              <IconButton icon="x" title="删除候选" tone="destructive" onClick={() => remove(i)} />
            </div>
            {err && <span className="text-[11px] pl-5" style={{ color: 'var(--destructive)' }}>{err}</span>}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...locators, { strategy: mobile ? 'accessibilityId' : 'css', value: '' }])}
        className="press text-[11px] px-2 py-1 rounded-[var(--radius-sm)] self-start"
        style={{ border: '1px dashed var(--border)', background: 'var(--popover)', color: 'var(--muted-foreground)', cursor: 'pointer' }}
      >
        + 添加候选
      </button>
      {errors['action.locator'] && (
        <span className="text-[11px]" style={{ color: 'var(--destructive)' }}>{errors['action.locator']}</span>
      )}
    </div>
  );
}
