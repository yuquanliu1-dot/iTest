import { useEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Locator, QueryDbAction, ObserveLogAction } from '@itest/shared';
import type { StepAction } from '@itest/shared';
import { useQuery } from '@tanstack/react-query';
import type { StepClip } from '../stores/stepClipboard';
import { api } from '../api/client';
import { formatBytes, shortDateTime, stepKindLabel } from '../lib/format';
import { validateStepEdit } from '../lib/stepValidation';
import { STEP_KINDS, switchAction, kindNeedsLocator, type StepKind } from './step-form/switchAction';
import LocatorArrayEditor from './step-form/LocatorArrayEditor';
import FillValueEditor from './step-form/FillValueEditor';
import Button from './ui/Button';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/shadcn/sheet';
import IconButton from './ui/IconButton';
import { cn } from '../lib/cn';

interface Props {
  initial: StepClip;
  /** 'edit' = 修改已有步骤；'create' = 新增未编译空白步骤（首屏带 click 默认 action）。
   *  仅影响标题文案 + 保存按钮文案 + 默认 source；保存数据流不变。 */
  mode?: 'edit' | 'create';
  availableVars?: string[];
  caseId?: string;
  onSave: (next: StepClip) => void;
  onClose: () => void;
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <span className="text-[11px]" style={{ color: 'var(--destructive)' }}>{msg}</span>;
}

/** 步骤编辑抽屉：外壳管类型切换 + 通用字段；DrawerForm 按 kind 重挂载管差异字段。 */
export default function StepEditDrawer({ initial, mode = 'edit', availableVars = [], caseId, onSave, onClose }: Props) {
  const navigate = useNavigate();
  const { projectId: routeProjectId, versionId: routeVersionId } = useParams<{ projectId: string; versionId: string }>();
  const [draft, setDraft] = useState<StepClip>(initial);
  // 通用字段放外壳：类型切换（DrawerForm 重挂载）不丢用户已输入的延迟
  // 2026-10-07 移除 name 输入框：name 列已退役，行级自然语言全部由 rowInstruction 承担。
  const [delayMs, setDelayMs] = useState(initial.delayMs ? String(initial.delayMs) : '');
  const kind = ((draft.action as { kind?: string })?.kind ?? 'click') as StepKind;
  // DrawerForm 每次渲染注册最新的 buildAction；类型切换前用它把未保存的字段编辑同步进 draft
  const buildActionRef = useRef<(() => Record<string, unknown> | null) | null>(null);

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[520px] sm:max-w-[92vw] p-0 gap-0"
        aria-describedby={undefined}
      >
        <div className="flex items-center gap-3 px-5 py-4 shrink-0 border-b">
          <SheetTitle className="text-sm font-semibold">{mode === 'create' ? '新增步骤' : '编辑步骤'}</SheetTitle>
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
          <SheetClose asChild>
            <IconButton icon="close" title="关闭" />
          </SheetClose>
        </div>

        <DrawerForm
          key={kind}
          clip={draft}
          kind={kind}
          delayMs={delayMs}
          onDelayMs={setDelayMs}
          availableVars={availableVars}
          caseId={caseId}
          buildActionRef={buildActionRef}
          onCancel={onClose}
          saveLabel={mode === 'create' ? '添加步骤' : '保存'}
          saveMode={mode}
          onSave={(built) => onSave({
            ...built,
            source: built.source && built.source !== 'recorder' && built.source !== 'agent' ? built.source : 'manual',
            delayMs: delayMs ? Number(delayMs) : undefined,
          })}
        />
      </SheetContent>
    </Sheet>
  );
}

/* ---------------- DrawerForm：kind 差异字段 + 保存校验 ---------------- */

interface FormProps {
  clip: StepClip;
  kind: StepKind;
  delayMs: string;
  onDelayMs: (v: string) => void;
  availableVars: string[];
  caseId?: string;
  buildActionRef: RefObject<(() => Record<string, unknown> | null) | null>;
  onCancel: () => void;
  onSave: (built: StepClip) => void;
  saveLabel: string;
  saveMode: 'edit' | 'create';
}

function DrawerForm({ clip, kind, delayMs, onDelayMs, availableVars, caseId, buildActionRef, onCancel, onSave, saveLabel, saveMode }: FormProps) {
  const navigate = useNavigate();
  const { projectId: routeProjectId, versionId: routeVersionId } = useParams<{ projectId: string; versionId: string }>();
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

  // aiTask 子步 instruction(LLM 多轮读) 与行级 instruction(人看/给 LLM 起手,回放不读)。
  // 行级 instruction 走 rowInstruction state;aiTask 这块独立用 aiInstruction。
  // 两字段在 DB 是不同列(行 instruction + compiled[i].instruction),勿混。
  const [rowInstruction, setRowInstruction] = useState(String(clip.instruction ?? ''));
  const [aiInstruction, setAiInstruction] = useState(String(action.instruction ?? ''));
  const [url, setUrl] = useState(String(action.url ?? ''));
  const [timeoutMs, setTimeoutMs] = useState(String(action.timeoutMs ?? ''));
  const [checked, setChecked] = useState(action.checked !== false);
  const [tabRef, setTabRef] = useState(String(action.tabRef ?? ''));
  const [shotName, setShotName] = useState(String(action.name ?? ''));

  // 2026-10-06：行级 compiled 数组（aiTask 用得到）。其余 kind
  //   由 buildAction 自然回填到 compiled=[action]，与 dispatcher 走同一条路径。
  // 2026-10-07：aiTask 编译改为跳 AI 助手走 stage_case_op(action=update_step / insert_step),
  //   这里只读 display — 落库完全由助手在 StagePanel 勾选后回写。
  const initialDraftCompiled: unknown[] | null = Array.isArray(clip.compiled) ? clip.compiled : null;
  const [compiled] = useState<unknown[] | null>(initialDraftCompiled);

  // extract 智能抽取编译（沿用历史变量名 compiling/compileErr）
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState('');

  // queryDb / observeLog
  const { data: allowedTablesData } = useQuery({
    queryKey: ['env-allowed-tables'],
    queryFn: () => api.environments.allowedTables(),
    staleTime: 5 * 60_000,
  });
  const queryTableCols = allowedTablesData?.[String(action.table ?? '')] ?? [];

  // queryDb
  const [queryTable, setQueryTable] = useState(String(action.table ?? 'test_cases'));
  const [queryColumns, setQueryColumns] = useState<string[]>(Array.isArray(action.columns) ? (action.columns as string[]) : []);
  const [queryWhere, setQueryWhere] = useState<Array<{ column: string; equals: string }>>(
    Array.isArray(action.where) ? (action.where as Array<{ column: string; equals: unknown }>).map((w) => ({ column: String(w.column ?? ''), equals: String(w.equals ?? '') })) : [],
  );
  const [queryLimit, setQueryLimit] = useState(String(action.limit ?? 50));
  const [queryAssertion, setQueryAssertion] = useState<{ match: 'equals' | 'contains' | 'regex'; expected: string; column?: string } | undefined>(
    action.assertion as { match: 'equals' | 'contains' | 'regex'; expected: string; column?: string } | undefined,
  );

  // observeLog
  const [observeWindowMs, setObserveWindowMs] = useState(String(action.windowMs ?? 60000));
  const [observeKeywords, setObserveKeywords] = useState(Array.isArray(action.keywords) ? (action.keywords as string[]).join(', ') : '');
  const [observeFromLine, setObserveFromLine] = useState(String(action.fromLine ?? 200));
  const [logAssertion, setLogAssertion] = useState<{ match: 'equals' | 'contains' | 'regex'; expected: string } | undefined>(
    action.assertion as { match: 'equals' | 'contains' | 'regex'; expected: string } | undefined,
  );

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
    if (kind === 'aiTask') next.instruction = aiInstruction.trim();
    if (kind === 'navigate') next.url = url.trim();
    if (kind === 'waitFor') {
      if (timeoutMs) next.timeoutMs = Number(timeoutMs);
      else delete next.timeoutMs;
    }
    if (kind === 'check') next.checked = checked;
    if (kind === 'switchTab') next.tabRef = tabRef;
    if (kind === 'screenshot') next.name = shotName;
    if (kind === 'queryDb') {
      next.table = queryTable;
      next.columns = queryColumns.slice(0, 40);
      next.limit = Math.max(1, Math.min(200, Number(queryLimit) || 50));
      next.where = queryWhere
        .filter((w) => w.column && String(w.equals) !== '')
        .slice(0, 10)
        .map((w) => {
          const raw = w.equals;
          const n = Number(raw);
          const eq: string | number | boolean = raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(n) && raw.trim() !== '' ? n : raw;
          return { column: w.column, equals: eq };
        });
      if (queryAssertion) next.assertion = queryAssertion;
      else delete next.assertion;
    }
    if (kind === 'observeLog') {
      next.windowMs = Math.max(1000, Math.min(600000, Number(observeWindowMs) || 60000));
      next.keywords = observeKeywords.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
      next.fromLine = Math.max(1, Math.min(10000, Number(observeFromLine) || 200));
      if (logAssertion) next.assertion = logAssertion;
      else delete next.assertion;
    }

    return next;
  };

  // 每次渲染注册最新闭包（不设依赖数组）；卸载时清空，外壳只在表单挂载时取得到
  useEffect(() => {
    buildActionRef.current = buildAction;
    return () => { buildActionRef.current = null; };
  });

  /** 保存：先做交互级 gate，再构建 + zod 校验（自 StepEditModal.handleSave 迁移）。
   *  2026-10-06：aiTask 强制要求 compiled 非空（未编译不允许保存），dispatcher 阻塞执行。
   *  其他 kind 的 compiled 由 buildAction 自然回填为 [action]，与 dispatcher 走同一条路径。
   *  2026-10-07：放宽 row 位置校验——create 模式允许空 locator/空 compiled 占位保存：
   *    用户手填了 enableAutoCompile = true 时,直接走 {kind:'click', locator:[]}, compiled:[] 占位入栈,
   *    顶部"执行"按 dispatcher compile-missing 抛错阻塞,行级「AI 智能任务」按钮一键回填。 */
  const handleSave = () => {
    if (kind === 'fill' && sensitive && !pwdDraft) {
      setFieldErrors({ sensitive: '已加密 — 修改时请输入新密码' });
      return;
    }
    if (kind === 'extract' && extractMode === 'smartExtract' && !extractDescription.trim() && !extractPattern.trim()) {
      setFieldErrors({ 'action.description': '智能抽取需要填写描述并生成正则' });
      return;
    }
    if (kind === 'aiTask' && !aiInstruction.trim()) {
      setFieldErrors({ 'action.instruction': '指令不能为空' });
      return;
    }
    // 占位保存分支：create 模式下 locator 全空时跳过 zod 校验,直接入库 compiled:[]
    if (saveAsPlaceholder) {
      const placeholderAction: Record<string, unknown> = { kind, locator: [] };
      onSave({
        action: placeholderAction,
        source: clip.source,
        instruction: rowInstruction.trim() || null,
        compiled: [],
      });
      return;
    }
    const next = buildAction();
    if (!next) {
      setFieldErrors({ 'action.equals': '期望值不是合法 JSON' });
      return;
    }
    const v = validateStepEdit({ action: next, delayMs: delayMs ? Number(delayMs) : undefined });
    if (!v.ok) {
      setFieldErrors(v.errors);
      return;
    }
    // aiTask 必须先 AI 编译出 compiled：空数组 = dispatcher 抛 compile-missing。
    const compiledOut: unknown[] = kind === 'aiTask' ? (compiled ?? []) : [next];
    if (kind === 'aiTask' && compiledOut.length === 0) {
      setFieldErrors({ 'action.instruction': '未编译：请先点击「AI 编译」生成 DSL' });
      return;
    }
    onSave({
      action: next,
      source: clip.source,
      instruction: rowInstruction.trim() || null,
      compiled: compiledOut,
    });
  };

  const showLocator = kindNeedsLocator(kind) && !(kind === 'assertText' && assertTarget !== 'specifiedElement');
  // create 模式下用户没填 locator 时给一条「存为未编译占位」出口 —— 抽屉关闭后顶部执行仍置灰,
  //   行级「AI 智能任务」按钮把 compiled 填回来。
  const saveAsPlaceholder = saveMode === 'create' && kindNeedsLocator(kind) && locators.every((l) => !String(l.value ?? '').trim());

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        {/* 2026-10-07：移除「步骤名称」input —— name 列已退役,自然语言完整说明统一存到行级 instruction。 */}
        <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          <span>自然语言描述（行级 instruction,人看 / 给 LLM 起手;回放不读）</span>
          <textarea
            className="input-base input-xs"
            value={rowInstruction}
            onChange={(e) => setRowInstruction(e.target.value)}
            placeholder="必填。例:在用户名框输入管理员账号"
            rows={2}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
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
            <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>定位候选（按顺序尝试，录制产生的语义定位优先）</span>
            <LocatorArrayEditor locators={locators} onChange={setLocators} errors={fieldErrors} />
          </div>
        )}

        {(kind === 'fill' || kind === 'select') && (
          <div className="flex flex-col gap-2">
            {kind === 'fill' && (
              <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
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
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
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
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
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
          <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            勾选（取消勾选则为取消勾选操作）
          </label>
        )}

        {kind === 'assertText' && (
          <>
            <div className="flex gap-2">
              <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
                <span>断言目标</span>
                <select className="input-base input-xs" value={assertTarget} onChange={(e) => setAssertTarget(e.target.value as typeof assertTarget)}>
                  <option value="specifiedElement">指定元素（需定位候选）</option>
                  <option value="page">整页文本</option>
                  <option value="errorMessage">错误提示区</option>
                  <option value="url">当前 URL</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
                <span>匹配方式</span>
                <select className="input-base input-xs" value={assertMatch} onChange={(e) => setAssertMatch(e.target.value as typeof assertMatch)}>
                  <option value="equals">等于（trim）</option>
                  <option value="contains">包含</option>
                  <option value="notContains">不包含</option>
                  <option value="regex">正则匹配</option>
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>期望文本</span>
              <textarea className="input-base input-xs" rows={3} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            </label>
          </>
        )}

        {kind === 'assertJson' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
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
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
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
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>抽取方式</span>
              <select className="input-base input-xs" value={extractMode} onChange={(e) => setExtractMode(e.target.value as typeof extractMode)}>
                <option value="completeValue">完整值（元素文本/input 值）</option>
                <option value="smartExtract">智能抽取（按描述生成正则）</option>
                <option value="regex">正则匹配</option>
              </select>
            </label>
            {extractMode === 'regex' && (
              <div className="flex gap-2">
                <label className="flex flex-col gap-1 text-[11px] flex-[3]" style={{ color: 'var(--muted-foreground)' }}>
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
                <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
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
                <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
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
                  className="press self-start text-[11px] px-2 py-1 rounded-[var(--radius-sm)] border border-dashed"
                  style={{ borderColor: 'var(--border)', background: 'var(--popover)', color: 'var(--muted-foreground)', cursor: compiling ? 'wait' : 'pointer' }}
                >
                  {compiling ? '编译中…' : '生成正则'}
                </button>
                {compileErr && <p className="text-[11px]" style={{ color: 'var(--destructive)' }}>{compileErr}</p>}
                {extractPattern && (
                  <p className="text-[11px] font-mono" style={{ color: 'var(--muted-foreground)' }}>
                    已生成正则：{extractPattern}（捕获组 {extractGroup}，保存后回放按正则执行）
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {kind === 'aiTask' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>AI 子步指令（编译后落到 compiled[0].instruction，回放时由 LLM 多轮读）</span>
              <textarea
                className="input-base input-xs"
                aria-invalid={!!fieldErrors['action.instruction']}
                rows={3}
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                placeholder="例：识别验证码图片中的字符并填入验证码输入框"
              />
              <FieldError msg={fieldErrors['action.instruction']} />
            </label>
            <button
              type="button"
              disabled={!aiInstruction.trim() || !caseId}
              onClick={() => {
                if (!caseId || !routeProjectId || !routeVersionId) return;
                // 2026-10-07：aiTask 子步的「AI 编译」改为跳 AI 助手走 stage_case_op(action=update_step / insert_step)。
                // 助手能 inspect_page 抓真实元素 + 让用户在 StagePanel 勾选 → 落库。
                navigate(
                  `/p/${routeProjectId}/v/${routeVersionId}/assistant`,
                  {
                    state: {
                      initialMessage:
                        `对 caseId=${caseId} 编辑一个 aiTask 步骤,instruction: ${JSON.stringify(aiInstruction.trim())}。\n` +
                        `请先 manage_cases get 拿完整用例,再 inspect_page 抓真实元素,然后 stage_case_op(action=update_step 或 insert_step, compiled 里给出 [{kind:'aiTask', instruction:'${aiInstruction.trim().replace(/'/g, "\\'")}'}])。`,
                    },
                  },
                );
              }}
              className="press self-start text-[11px] px-2 py-1 rounded-[var(--radius-sm)] border border-dashed"
              style={{
                borderColor: 'var(--border)',
                color: 'var(--muted-foreground)',
                background: 'var(--popover)',
              }}
              title="把自然语言指令交给 AI 助手，助手会跳到 StagePanel 预览 → 勾选保存。"
            >
              AI 助手编译
            </button>
            {compiled && compiled.length > 0 && (
              <p className="text-[11px] font-mono" style={{ color: 'var(--muted-foreground)' }}>
                已生成 DSL：{compiled.map((c) => (c as { kind?: string }).kind ?? '?').join(' → ')}（保存后回放按 compiled 执行）
              </p>
            )}
            <div className="text-[11px] flex flex-col gap-1" style={{ color: 'var(--muted-foreground)' }}>
              <p>• 智能步骤由 AI 在回放时看截图逐步执行，适合验证码识别、动态弹窗等难以固化为 DSL 的交互。</p>
              <p>• 确定性高的常规操作请用 click / fill / waitFor 等具体步骤，更稳更快。</p>
            </div>
          </div>
        )}

        {kind === 'upload' && (
          <div className="flex flex-col gap-2">
            <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>绑定回放文件（按 project 隔离，≤ 10 MB）</span>
            <input
              type="file"
              aria-invalid={!!fieldErrors['action.fileId']}
              className="block text-[11px]"
              style={{ color: 'var(--muted-foreground)' }}
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
                <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>—— 或从本 project 已上传文件选择 ——</span>
                <ul style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 0, margin: 0, listStyle: 'none' }}>
                  {attachments.map((a) => (
                    <li
                      key={a.id}
                      onClick={() => setFileId(a.id)}
                      style={{
                        padding: '6px 8px', cursor: 'pointer',
                        background: fileId === a.id ? 'var(--primary)' : 'transparent',
                        color: fileId === a.id ? '#fff' : 'var(--muted-foreground)',
                        fontSize: 11, display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center',
                        borderBottom: '1px solid var(--border)',
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
              <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                已绑定 fileId: <code>{fileId.slice(0, 8)}…</code>
                <button
                  type="button"
                  onClick={() => setFileId(undefined)}
                  className="press ml-2 text-[11px] underline-offset-2 hover:underline"
                  style={{ background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--primary)', cursor: 'pointer', borderRadius: 4 }}
                >
                  更换
                </button>
              </p>
            )}
          </div>
        )}

        {kind === 'switchTab' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
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
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            <span>截图名称</span>
            <input className="input-base input-xs" value={shotName} onChange={(e) => setShotName(e.target.value)} placeholder="可选" />
          </label>
        )}

        {kind === 'queryDb' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>表名（白名单）</span>
              <select className="input-base input-xs" value={queryTable} onChange={(e) => setQueryTable(e.target.value)}>
                {(allowedTablesData ? Object.keys(allowedTablesData) : ['test_cases']).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>返回列（按住 Ctrl/Cmd 多选；留空表示 *）</span>
              <select multiple className="input-base input-xs" style={{ minHeight: 80 }} value={queryColumns} onChange={(e) => setQueryColumns(Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {queryTableCols.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>WHERE 条件（最多 10 条）</span>
              {queryWhere.map((w, i) => (
                <div key={i} className="flex gap-1 items-center">
                  <select className="input-base input-xs flex-1" value={w.column} onChange={(e) => {
                    const next = [...queryWhere]; next[i] = { ...w, column: e.target.value }; setQueryWhere(next);
                  }}>
                    <option value="">— 列 —</option>
                    {queryTableCols.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input className="input-base input-xs flex-1" value={w.equals} placeholder="等于" onChange={(e) => {
                    const next = [...queryWhere]; next[i] = { ...w, equals: e.target.value }; setQueryWhere(next);
                  }} />
                  <button type="button" className="text-[11px] press" style={{ background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--destructive)', cursor: 'pointer', borderRadius: 4 }} onClick={() => setQueryWhere(queryWhere.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              {queryWhere.length < 10 && (
                <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px dashed var(--border)', color: 'var(--primary)', cursor: 'pointer', borderRadius: 4, padding: '4px 8px' }} onClick={() => setQueryWhere([...queryWhere, { column: queryTableCols[0] ?? '', equals: '' }])}>
                  + 增加条件
                </button>
              )}
            </div>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>limit（1-200）</span>
              <input className="input-base input-xs" type="number" min={1} max={200} value={queryLimit} onChange={(e) => setQueryLimit(e.target.value)} />
            </label>
            <DbAssertionEditor value={queryAssertion} onChange={setQueryAssertion} columns={queryTableCols} />
          </div>
        )}

        {kind === 'observeLog' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>时间窗 (ms, 1000-600000)</span>
              <input className="input-base input-xs" type="number" min={1000} max={600000} value={observeWindowMs} onChange={(e) => setObserveWindowMs(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>关键字（逗号分隔，最多 10 个）</span>
              <input className="input-base input-xs" value={observeKeywords} onChange={(e) => setObserveKeywords(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>起始行数（1-10000）</span>
              <input className="input-base input-xs" type="number" min={1} max={10000} value={observeFromLine} onChange={(e) => setObserveFromLine(e.target.value)} />
            </label>
            <DbAssertionEditor value={logAssertion} onChange={setLogAssertion} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end px-5 py-4 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        {saveAsPlaceholder && (
          <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
            将存为未编译占位 — 执行会被阻塞,点行级「AI 智能任务」回填
          </span>
        )}
        <Button size="sm" onClick={handleSave}>{saveLabel}</Button>
      </div>
    </div>
  );
}

function DbAssertionEditor({ value, onChange, columns }: { value: { match: 'equals' | 'contains' | 'regex'; expected: string; column?: string } | undefined; onChange: (v: typeof value) => void; columns?: string[] }) {
  if (!value) {
    return (
      <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px dashed var(--border)', color: 'var(--muted-foreground)', cursor: 'pointer', padding: '4px 8px', borderRadius: 5 }} onClick={() => onChange({ match: 'contains', expected: '' })}>
        + 附加断言
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 p-2 rounded-[var(--radius-sm)]" style={{ border: '1px solid var(--border)', background: 'var(--muted)' }}>
      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>断言（不命中则步骤失败）</span>
      <div className="flex gap-1.5">
        <select className="input-base input-xs" value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as 'equals' | 'contains' | 'regex' })}>
          <option value="equals">等于</option>
          <option value="contains">包含</option>
          <option value="regex">正则</option>
        </select>
        <input className="input-base input-xs flex-1" value={value.expected} placeholder="期望文本" onChange={(e) => onChange({ ...value, expected: e.target.value })} />
      </div>
      {columns && columns.length > 0 && (
        <select className="input-base input-xs" value={value.column ?? ''} onChange={(e) => onChange({ ...value, column: e.target.value || undefined })}>
          <option value="">任意列</option>
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px solid var(--destructive)', color: 'var(--destructive)', cursor: 'pointer', borderRadius: 4, padding: '2px 8px' }} onClick={() => onChange(undefined)}>移除断言</button>
    </div>
  );
}
