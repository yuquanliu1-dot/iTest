import { useEffect, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Locator } from '@itest/shared';
import type { StepClip } from '../stores/stepClipboard';
import { api } from '../api/client';
import { formatBytes, shortDateTime, stepKindLabel } from '../lib/format';
import { validateStepEdit } from '../lib/stepValidation';
import { STEP_KINDS, switchAction, kindNeedsLocator, type StepKind } from './step-form/switchAction';
import LocatorArrayEditor from './step-form/LocatorArrayEditor';
import FillValueEditor from './step-form/FillValueEditor';
import './StepEditDrawer.css';

interface Props {
  initial: StepClip;
  availableVars?: string[];
  caseId?: string;
  onSave: (next: StepClip) => void;
  onClose: () => void;
}

/** 与服务端 aiStepSplit.splitByNumber 同一行匹配规则（自 StepEditModal 原样迁移）。 */
function countNumberedSegments(text: string): number {
  const re = /^[ \t]*\d+(?:\.[ \t]+|、[ \t]*)(.+)$/;
  return text.split(/\r?\n/).filter((line) => re.test(line)).length;
}

const inputStyle: CSSProperties = {
  width: '100%', padding: '6px 8px', fontSize: 12, border: '1px solid var(--color-glass-border)',
  borderRadius: 6, background: 'var(--color-background-subtle)', color: 'var(--color-foreground)',
  boxSizing: 'border-box', marginTop: 4,
};
const labelStyle: CSSProperties = { fontSize: 11, color: 'var(--color-foreground-muted)' };
const errStyle: CSSProperties = { border: '1px solid var(--color-destructive)' };

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <span className="text-[11px]" style={{ color: 'var(--color-destructive)' }}>{msg}</span>;
}

/** 步骤编辑抽屉：外壳管类型切换 + 通用字段；DrawerForm 按 kind 重挂载管差异字段。 */
export default function StepEditDrawer({ initial, availableVars = [], caseId, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<StepClip>(initial);
  // 通用字段放外壳：类型切换（DrawerForm 重挂载）不丢用户已输入的名称/延迟
  const [name, setName] = useState(initial.name ?? '');
  const [delayMs, setDelayMs] = useState(initial.delayMs ? String(initial.delayMs) : '');
  const kind = ((draft.action as { kind?: string })?.kind ?? 'click') as StepKind;

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 60 }} />
        <Dialog.Content
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 520, maxWidth: '92vw', zIndex: 61,
            background: 'var(--color-background)', borderLeft: '1px solid var(--color-glass-border)',
            boxShadow: 'var(--shadow-modal, 0 8px 32px rgba(0,0,0,0.18))',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
          className="drawer-slide-in"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-3 px-5 py-4 shrink-0" style={{ borderBottom: '1px solid var(--color-glass-border)' }}>
            <Dialog.Title className="text-[14px] font-semibold" style={{ color: 'var(--color-foreground)' }}>
              编辑步骤
            </Dialog.Title>
            <select
              value={kind}
              onChange={(e) => setDraft(switchAction(draft, e.target.value as StepKind))}
              style={{ fontSize: 12, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--color-glass-border)', background: 'var(--color-background-subtle)', color: 'var(--color-foreground)' }}
              title="切换操作类型（兼容字段自动保留）"
            >
              {STEP_KINDS.map((k) => <option key={k} value={k}>{stepKindLabel(k)}</option>)}
            </select>
            <div className="flex-1" />
            <Dialog.Close asChild>
              <button style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', fontSize: 16 }} title="关闭">✕</button>
            </Dialog.Close>
          </div>

          <DrawerForm
            key={kind}
            clip={draft}
            kind={kind}
            name={name}
            delayMs={delayMs}
            onName={setName}
            onDelayMs={setDelayMs}
            availableVars={availableVars}
            caseId={caseId}
            onCancel={onClose}
            onSave={(built) => onSave({ ...built, name: name.trim() || undefined, delayMs: delayMs ? Number(delayMs) : undefined })}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---------------- DrawerForm：kind 差异字段 + 保存校验 ---------------- */

interface FormProps {
  clip: StepClip;
  kind: StepKind;
  name: string;
  delayMs: string;
  onName: (v: string) => void;
  onDelayMs: (v: string) => void;
  availableVars: string[];
  caseId?: string;
  onCancel: () => void;
  onSave: (built: StepClip) => void;
}

function DrawerForm({ clip, kind, name, delayMs, onName, onDelayMs, availableVars, caseId, onCancel, onSave }: FormProps) {
  const action = clip.action as Record<string, unknown>;
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // locator（需要定位的类型可编辑）
  const [locators, setLocators] = useState<Locator[]>(() =>
    Array.isArray(action.locator) ? (action.locator as Locator[]) : kindNeedsLocator(kind) ? [{ strategy: 'css', value: '' }] : [],
  );

  // fill 敏感值（自 Modal 迁移：占位 '__sensitive__' 必须重输）
  const [sensitive, setSensitive] = useState(!!(action as { sensitive?: boolean }).sensitive);
  const [pwdDraft, setPwdDraft] = useState('');
  const [fillValue, setFillValue] = useState<unknown>(
    action.sensitive ? '' : action.value ?? '',
  );
  const [selectValue, setSelectValue] = useState(typeof action.value === 'string' ? action.value : '');

  // upload（自 Modal 迁移）
  const [fileId, setFileId] = useState<string | undefined>(action.fileId as string | undefined);
  const [attachments, setAttachments] = useState<Array<{ id: string; originalName: string; size: number; mime: string | null; sha256: string; createdAt: string }>>([]);

  // assertText / assertJson
  const [equalsText, setEqualsText] = useState(
    kind === 'assertJson' ? JSON.stringify(action.equals ?? null, null, 2) : String(action.equals ?? ''),
  );
  const [assertTarget, setAssertTarget] = useState<'specifiedElement' | 'page' | 'errorMessage' | 'url'>(
    (action.target as 'specifiedElement') ?? 'specifiedElement',
  );
  const [assertMatch, setAssertMatch] = useState<'equals' | 'contains' | 'notContains' | 'regex'>(
    (action.match as 'equals') ?? 'equals',
  );

  // extract（自 Modal 迁移，含智能抽取编译）
  const [varName, setVarName] = useState(String(action.varName ?? ''));
  const [extractMode, setExtractMode] = useState<'completeValue' | 'smartExtract' | 'regex'>(
    (action.mode as 'completeValue') ?? 'completeValue',
  );
  const [extractPattern, setExtractPattern] = useState(String(action.pattern ?? ''));
  const [extractGroup, setExtractGroup] = useState(String(action.group ?? '1'));
  const [extractDescription, setExtractDescription] = useState(String(action.description ?? ''));
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState('');

  // aiStep / navigate / waitFor / check / switchTab / screenshot
  const [instruction, setInstruction] = useState(String(action.instruction ?? ''));
  const [showBoundary, setShowBoundary] = useState(false);
  const [url, setUrl] = useState(String(action.url ?? ''));
  const [timeoutMs, setTimeoutMs] = useState(String(action.timeoutMs ?? ''));
  const [checked, setChecked] = useState(action.checked !== false);
  const [tabRef, setTabRef] = useState(String(action.tabRef ?? ''));
  const [shotName, setShotName] = useState(String(action.name ?? ''));

  useEffect(() => {
    if (kind !== 'upload' || !caseId) return;
    let cancelled = false;
    api.attachments.list(caseId).then((rows) => { if (!cancelled) setAttachments(rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [kind, caseId]);

  /** 构建 action（自 StepEditModal.handleSave 迁移），再走 validateStepEdit。 */
  const handleSave = () => {
    const next: Record<string, unknown> = { ...action };

    if (kindNeedsLocator(kind)) next.locator = locators;
    if (kind === 'fill' || kind === 'select') {
      if (kind === 'fill') {
        if (sensitive) {
          if (!pwdDraft) {
            setFieldErrors({ sensitive: '已加密 — 修改时请输入新密码' });
            return;
          }
          next.value = pwdDraft;
          next.sensitive = true;
        } else {
          next.value = fillValue;
          delete next.sensitive;
        }
      } else {
        next.value = selectValue;
      }
    }
    if (kind === 'upload') next.fileId = fileId ?? '';
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
        setFieldErrors({ 'action.equals': '期望值不是合法 JSON' });
        return;
      }
    }
    if (kind === 'extract') {
      next.varName = varName.trim();
      next.mode = extractMode;
      if (extractMode === 'regex') {
        next.pattern = extractPattern.trim();
        next.group = Number(extractGroup) >= 0 ? Number(extractGroup) : 0;
        delete next.description;
      } else if (extractMode === 'smartExtract') {
        if (!extractDescription.trim() && !extractPattern.trim()) {
          setFieldErrors({ 'action.description': '智能抽取需要填写描述并生成正则' });
          return;
        }
        if (extractDescription.trim()) next.description = extractDescription.trim();
        else delete next.description;
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
        setFieldErrors({ 'action.instruction': '指令不能为空' });
        return;
      }
      next.instruction = instruction.trim();
      next.compiled = action.compiled ?? null;
    }
    if (kind === 'navigate') next.url = url.trim();
    if (kind === 'waitFor') {
      if (timeoutMs) next.timeoutMs = Number(timeoutMs);
      else delete next.timeoutMs;
    }
    if (kind === 'check') next.checked = checked;
    if (kind === 'switchTab') next.tabRef = tabRef;
    if (kind === 'screenshot') next.name = shotName;

    const v = validateStepEdit({ action: next, name: name.trim() || undefined, delayMs: delayMs ? Number(delayMs) : undefined });
    if (!v.ok) {
      setFieldErrors(v.errors);
      return;
    }
    onSave({ action: next, source: clip.source });
  };

  const showLocator = kindNeedsLocator(kind) && !(kind === 'assertText' && assertTarget !== 'specifiedElement');

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        <label style={labelStyle}>
          步骤名称
          <input style={{ ...inputStyle, ...(fieldErrors.name ? errStyle : {}) }} value={name} onChange={(e) => onName(e.target.value)} placeholder="可选" />
          <FieldError msg={fieldErrors.name} />
        </label>
        <label style={labelStyle}>
          执行前等待 (ms)
          <input style={{ ...inputStyle, ...(fieldErrors.delayMs ? errStyle : {}) }} value={delayMs} onChange={(e) => onDelayMs(e.target.value)} placeholder="0" inputMode="numeric" />
          <FieldError msg={fieldErrors.delayMs} />
        </label>

        {showLocator && (
          <div className="flex flex-col gap-1.5">
            <span style={labelStyle}>定位候选（按顺序尝试，录制产生的语义定位优先）</span>
            <LocatorArrayEditor locators={locators} onChange={setLocators} errors={fieldErrors} />
          </div>
        )}

        {(kind === 'fill' || kind === 'select') && (
          <div className="flex flex-col gap-2">
            {kind === 'fill' && (
              <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
                敏感值（密码，加密保存，明文不显示）
              </label>
            )}
            {kind === 'fill' && sensitive ? (
              <div className="flex flex-col gap-1">
                <input
                  type="password"
                  style={{ ...inputStyle, ...(fieldErrors.sensitive ? errStyle : {}) }}
                  placeholder="输入新密码（已加密值不回显）"
                  value={pwdDraft}
                  onChange={(e) => setPwdDraft(e.target.value)}
                />
                <FieldError msg={fieldErrors.sensitive} />
              </div>
            ) : kind === 'fill' ? (
              <FillValueEditor value={fillValue} onChange={setFillValue} availableVars={availableVars} />
            ) : (
              <input style={inputStyle} value={selectValue} onChange={(e) => setSelectValue(e.target.value)} placeholder="下拉选项值" />
            )}
          </div>
        )}

        {kind === 'navigate' && (
          <label style={labelStyle}>
            URL
            <input style={{ ...inputStyle, ...(fieldErrors['action.url'] ? errStyle : {}) }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
            <FieldError msg={fieldErrors['action.url']} />
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

        {kind === 'assertText' && (
          <>
            <div className="flex gap-2">
              <label style={{ ...labelStyle, flex: 1 }}>
                断言目标
                <select style={inputStyle} value={assertTarget} onChange={(e) => setAssertTarget(e.target.value as typeof assertTarget)}>
                  <option value="specifiedElement">指定元素（需定位候选）</option>
                  <option value="page">整页文本</option>
                  <option value="errorMessage">错误提示区</option>
                  <option value="url">当前 URL</option>
                </select>
              </label>
              <label style={{ ...labelStyle, flex: 1 }}>
                匹配方式
                <select style={inputStyle} value={assertMatch} onChange={(e) => setAssertMatch(e.target.value as typeof assertMatch)}>
                  <option value="equals">等于（trim）</option>
                  <option value="contains">包含</option>
                  <option value="notContains">不包含</option>
                  <option value="regex">正则匹配</option>
                </select>
              </label>
            </div>
            <label style={labelStyle}>
              期望文本
              <textarea style={{ ...inputStyle, fontFamily: 'inherit' }} rows={3} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            </label>
          </>
        )}

        {kind === 'assertJson' && (
          <label style={labelStyle}>
            期望 JSON（整段深比较）
            <textarea style={{ ...inputStyle, fontFamily: 'monospace', ...(fieldErrors['action.equals'] ? errStyle : {}) }} rows={6} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            <FieldError msg={fieldErrors['action.equals']} />
          </label>
        )}

        {kind === 'extract' && (
          <div className="flex flex-col gap-2">
            <label style={labelStyle}>
              变量名
              <input style={{ ...inputStyle, ...(fieldErrors['action.varName'] ? errStyle : {}) }} value={varName} onChange={(e) => setVarName(e.target.value)} placeholder="后续步骤用 {{变量名}} 引用" />
              <FieldError msg={fieldErrors['action.varName']} />
            </label>
            <label style={labelStyle}>
              抽取方式
              <select style={inputStyle} value={extractMode} onChange={(e) => setExtractMode(e.target.value as typeof extractMode)}>
                <option value="completeValue">完整值（元素文本/input 值）</option>
                <option value="smartExtract">智能抽取（按描述生成正则）</option>
                <option value="regex">正则匹配</option>
              </select>
            </label>
            {extractMode === 'regex' && (
              <div className="flex gap-2">
                <label style={{ ...labelStyle, flex: 3 }}>
                  正则
                  <input style={{ ...inputStyle, fontFamily: 'monospace', ...(fieldErrors['action.pattern'] ? errStyle : {}) }} value={extractPattern} onChange={(e) => setExtractPattern(e.target.value)} placeholder="如 ORD-\d+" />
                  <FieldError msg={fieldErrors['action.pattern']} />
                </label>
                <label style={{ ...labelStyle, flex: 1 }}>
                  捕获组
                  <input style={inputStyle} value={extractGroup} onChange={(e) => setExtractGroup(e.target.value)} inputMode="numeric" placeholder="0" />
                </label>
              </div>
            )}
            {extractMode === 'smartExtract' && (
              <div className="flex flex-col gap-2">
                <label style={labelStyle}>
                  抽取描述（自然语言）
                  <textarea style={{ ...inputStyle, fontFamily: 'inherit', ...(fieldErrors['action.description'] ? { border: '1px solid var(--color-destructive)' } : {}) }} rows={2} value={extractDescription} onChange={(e) => setExtractDescription(e.target.value)} placeholder="如：提取订单号" />
                  {fieldErrors['action.description'] && (
                    <span className="text-[11px]" style={{ color: 'var(--color-destructive)' }}>{fieldErrors['action.description']}</span>
                  )}
                </label>
                <button
                  type="button"
                  onClick={async () => {
                    if (!caseId) { setCompileErr('缺少 caseId，无法编译'); return; }
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
                  disabled={compiling}
                  style={{ fontSize: 11, padding: '4px 8px', borderRadius: 5, border: '1px dashed var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', cursor: compiling ? 'wait' : 'pointer', alignSelf: 'flex-start' }}
                >
                  {compiling ? '编译中…' : '生成正则'}
                </button>
                {compileErr && <p className="text-[11px]" style={{ color: 'var(--color-destructive)' }}>{compileErr}</p>}
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
                style={{ ...inputStyle, fontFamily: 'inherit', ...(fieldErrors['action.instruction'] ? errStyle : {}) }}
                rows={3}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="可用 #cssSelector 引用页面元素，例: 识别图片 #captchaImg 并输入到 #captchaInput"
              />
              <FieldError msg={fieldErrors['action.instruction']} />
            </label>
            {countNumberedSegments(instruction) >= 2 && (
              <p className="text-[11px]" style={{ color: 'var(--color-accent)' }}>
                检测到 {countNumberedSegments(instruction)} 条编号，保存时将自动拆为 {countNumberedSegments(instruction)} 条独立智能步骤
              </p>
            )}
            <button type="button" onClick={() => setShowBoundary((v) => !v)} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 5, cursor: 'pointer', border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', alignSelf: 'flex-start' }}>
              {showBoundary ? '收起使用边界提示' : '查看使用边界'}
            </button>
            {showBoundary && (
              <div className="text-[11px] flex flex-col gap-1" style={{ color: 'var(--color-foreground-muted)' }}>
                <p>• 智能步骤适合复杂页面、动态选择、第一条结果等场景。</p>
                <p>• 不建议用于登录、支付、删除审批等高风险路径，也不用于发布准入的关键确定性步骤。</p>
                <p>• 强对抗验证码（滑块、点选、行为验证）不适用；仅适合测试环境中的简单图片验证码。</p>
                <p>• 关键结果请使用文本断言 / JSON 断言，不要把验证全部塞进智能步骤。</p>
              </div>
            )}
          </div>
        )}

        {kind === 'upload' && (
          <div className="flex flex-col gap-2">
            <span style={labelStyle}>绑定回放文件（按 project 隔离，≤ 10 MB）</span>
            <input
              type="file"
              style={{ ...inputStyle, ...(fieldErrors['action.fileId'] ? errStyle : {}) }}
              onChange={async (e) => {
                if (!caseId) return;
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 10 * 1024 * 1024) {
                  setFieldErrors((cur) => ({ ...cur, 'action.fileId': '文件超过 10MB 上限' }));
                  return;
                }
                try {
                  const r = await api.attachments.upload(caseId, f);
                  setFileId(r.id);
                  setFieldErrors((cur) => { const rest = { ...cur }; delete rest['action.fileId']; return rest; });
                  api.attachments.list(caseId).then(setAttachments).catch(() => {});
                } catch (err) {
                  setFieldErrors((cur) => ({ ...cur, 'action.fileId': (err as Error).message }));
                }
              }}
            />
            <FieldError msg={fieldErrors['action.fileId']} />
            {attachments.length > 0 && (
              <>
                <span style={labelStyle}>—— 或从本 project 已上传文件选择 ——</span>
                <ul style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--color-glass-border)', borderRadius: 6, padding: 0, margin: 0, listStyle: 'none' }}>
                  {attachments.map((a) => (
                    <li
                      key={a.id}
                      onClick={() => setFileId(a.id)}
                      style={{
                        padding: '6px 8px', cursor: 'pointer',
                        background: fileId === a.id ? 'var(--color-accent)' : 'transparent',
                        color: fileId === a.id ? '#fff' : 'var(--color-foreground-secondary)',
                        fontSize: 11, display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center',
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
                <button type="button" onClick={() => setFileId(undefined)} style={{ marginLeft: 8, background: 'transparent', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 11 }}>
                  更换
                </button>
              </p>
            )}
          </div>
        )}

        {kind === 'switchTab' && (
          <label style={labelStyle}>
            标签引用（tabRef）
            <input style={{ ...inputStyle, ...(fieldErrors['action.tabRef'] ? errStyle : {}) }} value={tabRef} onChange={(e) => setTabRef(e.target.value)} placeholder="录制产生的标签标识" />
            <FieldError msg={fieldErrors['action.tabRef']} />
          </label>
        )}

        {kind === 'screenshot' && (
          <label style={labelStyle}>
            截图名称
            <input style={inputStyle} value={shotName} onChange={(e) => setShotName(e.target.value)} placeholder="可选" />
          </label>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end px-5 py-4 shrink-0" style={{ borderTop: '1px solid var(--color-glass-border)' }}>
        <button type="button" onClick={onCancel} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-secondary)', cursor: 'pointer' }}>
          取消
        </button>
        <button type="button" onClick={handleSave} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--color-accent)', color: '#fff', cursor: 'pointer' }}>
          保存
        </button>
      </div>
    </div>
  );
}
