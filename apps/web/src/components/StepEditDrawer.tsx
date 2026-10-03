import { useEffect, useRef, useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Locator } from '@itest/shared';
import type { StepClip } from '../stores/stepClipboard';
import { api } from '../api/client';
import { formatBytes, shortDateTime, stepKindLabel } from '../lib/format';
import { validateStepEdit } from '../lib/stepValidation';
import { STEP_KINDS, switchAction, kindNeedsLocator, type StepKind } from './step-form/switchAction';
import LocatorArrayEditor from './step-form/LocatorArrayEditor';
import FillValueEditor from './step-form/FillValueEditor';
import Button from './ui/Button';
import { cn } from '../lib/cn';
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
  // DrawerForm 每次渲染注册最新的 buildAction；类型切换前用它把未保存的字段编辑同步进 draft
  const buildActionRef = useRef<(() => Record<string, unknown> | null) | null>(null);

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
              onChange={(e) => {
                // 先取 DrawerForm 当前表单状态（含未保存编辑），再切换；避免切换丢编辑
                const current = buildActionRef.current?.() ?? draft.action;
                setDraft(switchAction({ ...draft, action: current }, e.target.value as StepKind));
              }}
              className="input-base input-xs input-inline"
              title="切换操作类型（兼容字段自动保留）"
            >
              {STEP_KINDS.map((k) => <option key={k} value={k}>{stepKindLabel(k)}</option>)}
            </select>
            <div className="flex-1" />
            <Dialog.Close asChild>
              <button type="button" className="press" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-foreground-muted)', fontSize: 16 }} title="关闭">✕</button>
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
            buildActionRef={buildActionRef}
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
  buildActionRef: RefObject<(() => Record<string, unknown> | null) | null>;
  onCancel: () => void;
  onSave: (built: StepClip) => void;
}

function DrawerForm({ clip, kind, name, delayMs, onName, onDelayMs, availableVars, caseId, buildActionRef, onCancel, onSave }: FormProps) {
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
  // aiStep 可选断言：与 instruction 解耦；保存后落到 test_steps.assertion（assertText 形态）。
  // 后端在 save 路径会做 migrateAssertion，老数据缺这字段时会回填空字符串而非报错。
  const [aiAssertion, setAiAssertion] = useState(String(action.assertion ?? ''));
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

  /** 把当前表单状态构建为 action（含未保存编辑）；assertJson 解析失败返回 null。类型切换与保存共用。 */
  const buildAction = (): Record<string, unknown> | null => {
    const next: Record<string, unknown> = { ...action };

    if (kindNeedsLocator(kind)) next.locator = locators;
    if (kind === 'fill' || kind === 'select') {
      if (kind === 'fill') {
        if (sensitive) {
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
        return null;
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
      next.instruction = instruction.trim();
      next.compiled = action.compiled ?? null;
      const a = aiAssertion.trim();
      if (a) next.assertion = a;
      else delete next.assertion;
    }
    if (kind === 'navigate') next.url = url.trim();
    if (kind === 'waitFor') {
      if (timeoutMs) next.timeoutMs = Number(timeoutMs);
      else delete next.timeoutMs;
    }
    if (kind === 'check') next.checked = checked;
    if (kind === 'switchTab') next.tabRef = tabRef;
    if (kind === 'screenshot') next.name = shotName;

    return next;
  };

  // 每次渲染注册最新闭包（不设依赖数组）；卸载时清空，外壳只在表单挂载时取得到
  useEffect(() => {
    buildActionRef.current = buildAction;
    return () => { buildActionRef.current = null; };
  });

  /** 保存：先做交互级 gate，再构建 + zod 校验（自 StepEditModal.handleSave 迁移）。 */
  const handleSave = () => {
    if (kind === 'fill' && sensitive && !pwdDraft) {
      setFieldErrors({ sensitive: '已加密 — 修改时请输入新密码' });
      return;
    }
    if (kind === 'extract' && extractMode === 'smartExtract' && !extractDescription.trim() && !extractPattern.trim()) {
      setFieldErrors({ 'action.description': '智能抽取需要填写描述并生成正则' });
      return;
    }
    if (kind === 'aiStep' && !instruction.trim()) {
      setFieldErrors({ 'action.instruction': '指令不能为空' });
      return;
    }
    const next = buildAction();
    if (!next) {
      setFieldErrors({ 'action.equals': '期望值不是合法 JSON' });
      return;
    }
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
        <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
          <span>步骤名称</span>
          <input
            className={cn('input-base input-xs')}
            aria-invalid={!!fieldErrors.name}
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="可选"
          />
          <FieldError msg={fieldErrors.name} />
        </label>
        <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
          <span>执行前等待 (ms)</span>
          <input
            className="input-base input-xs"
            aria-invalid={!!fieldErrors.delayMs}
            value={delayMs}
            onChange={(e) => onDelayMs(e.target.value)}
            placeholder="0"
            inputMode="numeric"
          />
          <FieldError msg={fieldErrors.delayMs} />
        </label>

        {showLocator && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>定位候选（按顺序尝试，录制产生的语义定位优先）</span>
            <LocatorArrayEditor locators={locators} onChange={setLocators} errors={fieldErrors} />
          </div>
        )}

        {(kind === 'fill' || kind === 'select') && (
          <div className="flex flex-col gap-2">
            {kind === 'fill' && (
              <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
                敏感值（密码，加密保存，明文不显示）
              </label>
            )}
            {kind === 'fill' && sensitive ? (
              <div className="flex flex-col gap-1">
                <input
                  type="password"
                  className="input-base input-xs"
                  aria-invalid={!!fieldErrors.sensitive}
                  placeholder="输入新密码（已加密值不回显）"
                  value={pwdDraft}
                  onChange={(e) => setPwdDraft(e.target.value)}
                />
                <FieldError msg={fieldErrors.sensitive} />
              </div>
            ) : kind === 'fill' ? (
              <FillValueEditor value={fillValue} onChange={setFillValue} availableVars={availableVars} />
            ) : (
              <div className="flex flex-col gap-1">
                <input
                  className="input-base input-xs"
                  aria-invalid={!!fieldErrors['action.value']}
                  value={selectValue}
                  onChange={(e) => setSelectValue(e.target.value)}
                  placeholder="下拉选项值"
                />
                <FieldError msg={fieldErrors['action.value']} />
              </div>
            )}
          </div>
        )}

        {kind === 'navigate' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
            <span>URL</span>
            <input
              className="input-base input-xs"
              aria-invalid={!!fieldErrors['action.url']}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
            />
            <FieldError msg={fieldErrors['action.url']} />
          </label>
        )}

        {kind === 'waitFor' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
            <span>超时 (ms，留空默认 5000)</span>
            <input
              className="input-base input-xs"
              aria-invalid={!!fieldErrors['action.timeoutMs']}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              inputMode="numeric"
            />
            <FieldError msg={fieldErrors['action.timeoutMs']} />
          </label>
        )}

        {kind === 'check' && (
          <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            勾选（取消勾选则为取消勾选操作）
          </label>
        )}

        {kind === 'assertText' && (
          <>
            <div className="flex gap-2">
              <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--color-foreground-muted)' }}>
                <span>断言目标</span>
                <select className="input-base input-xs" value={assertTarget} onChange={(e) => setAssertTarget(e.target.value as typeof assertTarget)}>
                  <option value="specifiedElement">指定元素（需定位候选）</option>
                  <option value="page">整页文本</option>
                  <option value="errorMessage">错误提示区</option>
                  <option value="url">当前 URL</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--color-foreground-muted)' }}>
                <span>匹配方式</span>
                <select className="input-base input-xs" value={assertMatch} onChange={(e) => setAssertMatch(e.target.value as typeof assertMatch)}>
                  <option value="equals">等于（trim）</option>
                  <option value="contains">包含</option>
                  <option value="notContains">不包含</option>
                  <option value="regex">正则匹配</option>
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
              <span>期望文本</span>
              <textarea className="input-base input-xs" rows={3} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            </label>
          </>
        )}

        {kind === 'assertJson' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
            <span>期望 JSON（整段深比较）</span>
            <textarea
              className="input-base input-xs font-mono"
              aria-invalid={!!fieldErrors['action.equals']}
              rows={6}
              value={equalsText}
              onChange={(e) => setEqualsText(e.target.value)}
            />
            <FieldError msg={fieldErrors['action.equals']} />
          </label>
        )}

        {kind === 'extract' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
              <span>变量名</span>
              <input
                className="input-base input-xs"
                aria-invalid={!!fieldErrors['action.varName']}
                value={varName}
                onChange={(e) => setVarName(e.target.value)}
                placeholder="后续步骤用 {{变量名}} 引用"
              />
              <FieldError msg={fieldErrors['action.varName']} />
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
              <span>抽取方式</span>
              <select className="input-base input-xs" value={extractMode} onChange={(e) => setExtractMode(e.target.value as typeof extractMode)}>
                <option value="completeValue">完整值（元素文本/input 值）</option>
                <option value="smartExtract">智能抽取（按描述生成正则）</option>
                <option value="regex">正则匹配</option>
              </select>
            </label>
            {extractMode === 'regex' && (
              <div className="flex gap-2">
                <label className="flex flex-col gap-1 text-[11px] flex-[3]" style={{ color: 'var(--color-foreground-muted)' }}>
                  <span>正则</span>
                  <input
                    className="input-base input-xs font-mono"
                    aria-invalid={!!fieldErrors['action.pattern']}
                    value={extractPattern}
                    onChange={(e) => setExtractPattern(e.target.value)}
                    placeholder="如 ORD-\d+"
                  />
                  <FieldError msg={fieldErrors['action.pattern']} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--color-foreground-muted)' }}>
                  <span>捕获组</span>
                  <input
                    className="input-base input-xs"
                    value={extractGroup}
                    onChange={(e) => setExtractGroup(e.target.value)}
                    inputMode="numeric"
                    placeholder="0"
                  />
                </label>
              </div>
            )}
            {extractMode === 'smartExtract' && (
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
                  <span>抽取描述（自然语言）</span>
                  <textarea
                    className="input-base input-xs"
                    aria-invalid={!!fieldErrors['action.description']}
                    rows={2}
                    value={extractDescription}
                    onChange={(e) => setExtractDescription(e.target.value)}
                    placeholder="如：提取订单号"
                  />
                  <FieldError msg={fieldErrors['action.description']} />
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
                  className="press self-start text-[11px] px-2 py-1 rounded-[5px] border border-dashed"
                  style={{ borderColor: 'var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)', cursor: compiling ? 'wait' : 'pointer' }}
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
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
              <span>自然语言指令（保存后自动编译）</span>
              <textarea
                className="input-base input-xs"
                aria-invalid={!!fieldErrors['action.instruction']}
                rows={3}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="可用 #cssSelector 引用页面元素，例: 识别图片 #captchaImg 并输入到 #captchaInput"
              />
              <FieldError msg={fieldErrors['action.instruction']} />
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
              <span>断言（可选，保存后落入 assertText）</span>
              <textarea
                className="input-base input-xs"
                rows={2}
                value={aiAssertion}
                onChange={(e) => setAiAssertion(e.target.value)}
                placeholder="例：看见验证码识别结果；留空则不生成断言"
              />
            </label>
            {countNumberedSegments(instruction) >= 2 && (
              <p className="text-[11px]" style={{ color: 'var(--color-accent)' }}>
                检测到 {countNumberedSegments(instruction)} 条编号，保存时将自动拆为 {countNumberedSegments(instruction)} 条独立智能步骤
              </p>
            )}
            <button
              type="button"
              onClick={() => setShowBoundary((v) => !v)}
              className="press self-start text-[11px] px-2 py-1 rounded-[5px] border"
              style={{ cursor: 'pointer', borderColor: 'var(--color-glass-border)', background: 'transparent', color: 'var(--color-foreground-muted)' }}
            >
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
            <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>绑定回放文件（按 project 隔离，≤ 10 MB）</span>
            <input
              type="file"
              aria-invalid={!!fieldErrors['action.fileId']}
              className="block text-[11px]"
              style={{ color: 'var(--color-foreground-muted)' }}
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
                <span className="text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>—— 或从本 project 已上传文件选择 ——</span>
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
                <button
                  type="button"
                  onClick={() => setFileId(undefined)}
                  className="press ml-2 text-[11px] underline-offset-2 hover:underline"
                  style={{ background: 'transparent', border: 'none', color: 'var(--color-accent)', cursor: 'pointer' }}
                >
                  更换
                </button>
              </p>
            )}
          </div>
        )}

        {kind === 'switchTab' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
            <span>标签引用（tabRef）</span>
            <input
              className="input-base input-xs"
              aria-invalid={!!fieldErrors['action.tabRef']}
              value={tabRef}
              onChange={(e) => setTabRef(e.target.value)}
              placeholder="录制产生的标签标识"
            />
            <FieldError msg={fieldErrors['action.tabRef']} />
          </label>
        )}

        {kind === 'screenshot' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-foreground-muted)' }}>
            <span>截图名称</span>
            <input className="input-base input-xs" value={shotName} onChange={(e) => setShotName(e.target.value)} placeholder="可选" />
          </label>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end px-5 py-4 shrink-0" style={{ borderTop: '1px solid var(--color-glass-border)' }}>
        <Button variant="plain" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" onClick={handleSave}>保存</Button>
      </div>
    </div>
  );
}
