import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import type { Locator, QueryDbAction, ObserveLogAction } from '@itest/shared';
import type { StepAction } from '@itest/shared';
import { useQuery } from '@tanstack/react-query';
import type { StepClip } from '../stores/stepClipboard';
import { api } from '../api/client';
import { formatBytes, shortDateTime, stepKindLabel } from '../lib/format';
import { validateStepEdit } from '../lib/stepValidation';
import { stepSummary } from '../lib/stepSummary';
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
  datasetVars?: string[];
  caseId?: string;
  /** 移动端用例时启用 mobile 步骤种类 + 隐藏 web-only kind；同步影响 kind 下拉与表单字段。 */
  platform?: 'web' | 'mobile';
  onSave: (next: StepClip) => void;
  onClose: () => void;
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <span className="text-[11px]" style={{ color: 'var(--destructive)' }}>{msg}</span>;
}

/** 步骤编辑抽屉：外壳管类型切换 + 通用字段；DrawerForm 按 kind 重挂载管差异字段。 */
export default function StepEditDrawer({ initial, mode = 'edit', availableVars = [], datasetVars = [], caseId, platform = 'web', onSave, onClose }: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { projectId: routeProjectId, versionId: routeVersionId } = useParams<{ projectId: string; versionId: string }>();
  // 移动端可见 kind = 移动 9 + 跨平台可用 6（click/fill/assertVisible/assertText/screenshot/aiTask）
  const MOBILE_ALLOWED_KINDS: ReadonlySet<string> = new Set([
    'tap', 'swipe', 'setAppearance', 'setNetwork', 'setLocation',
    'appOpen', 'appBack', 'appRestart', 'home',
    'click', 'fill', 'assertVisible', 'assertText', 'screenshot', 'aiTask',
  ]);
  const isMobile = platform === 'mobile';
  const availableKinds = (isMobile ? STEP_KINDS.filter((k) => MOBILE_ALLOWED_KINDS.has(k)) : STEP_KINDS) as StepKind[];
  const [draft, setDraft] = useState<StepClip>(initial);
  // 通用字段放外壳：类型切换（DrawerForm 重挂载）不丢用户已输入的延迟
  // 2026-10-07 移除 name 输入框：name 列已退役，行级自然语言全部由 rowInstruction 承担。
  const [delayMs, setDelayMs] = useState(initial.delayMs ? String(initial.delayMs) : '');
  const kind = ((draft.action as { kind?: string })?.kind ?? (isMobile ? 'tap' : 'click')) as StepKind;
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
          <SheetTitle className="text-sm font-semibold">{mode === 'create' ? t('cases:addStep') : t('cases:editStep')}</SheetTitle>
          <select
            value={kind}
            onChange={(e) => {
              // 先取 DrawerForm 当前表单状态（含未保存编辑），再切换；避免切换丢编辑
              const current = buildActionRef.current?.() ?? draft.action;
              setDraft(switchAction({ ...draft, action: current }, e.target.value as StepKind));
            }}
            className="input-base input-xs input-inline"
            title={t('cases:switchAction')}
          >
            {availableKinds.map((k) => <option key={k} value={k}>{t(stepKindLabel(k))}</option>)}
          </select>
          <div className="flex-1" />
          <SheetClose asChild>
            <IconButton icon="close" title={t('common:close')} />
          </SheetClose>
        </div>

        <DrawerForm
          key={kind}
          clip={draft}
          kind={kind}
          delayMs={delayMs}
          onDelayMs={setDelayMs}
          availableVars={availableVars}
          datasetVars={datasetVars}
          caseId={caseId}
          platform={platform}
          buildActionRef={buildActionRef}
          onCancel={onClose}
          saveLabel={mode === 'create' ? t('cases:addStepAction') : t('common:save')}
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
  datasetVars: string[];
  caseId?: string;
  platform?: 'web' | 'mobile';
  buildActionRef: RefObject<(() => Record<string, unknown> | null) | null>;
  onCancel: () => void;
  onSave: (built: StepClip) => void;
  saveLabel: string;
  saveMode: 'edit' | 'create';
}

function DrawerForm({ clip, kind, delayMs, onDelayMs, availableVars, datasetVars = [], caseId, platform = 'web', buildActionRef, onCancel, onSave, saveLabel, saveMode }: FormProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  // validateStepEdit 返回 i18n token → 当前语言文案；定位候选序号从字段路径推得。
  const errText = (token: string, path: string): string =>
    token === 'stepLocatorValueEmpty'
      ? t('cases:stepLocatorValueEmpty', { n: Number(/^action\.locator\.(\d+)\.value$/.exec(path)?.[1] ?? 0) + 1 })
      : token.startsWith('step') ? t(`cases:${token}`) : token;
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

  // httpRequest
  const [httpMethod, setHttpMethod] = useState<string>(String(action.method ?? 'GET'));
  const [httpUrl, setHttpUrl] = useState(String(action.url ?? ''));
  const [httpHeaders, setHttpHeaders] = useState<Array<{ key: string; value: string }>>(
    Array.isArray(action.headers) ? (action.headers as Array<{ key?: unknown; value?: unknown }>).map((h) => ({ key: String(h.key ?? ''), value: String(h.value ?? '') })) : [],
  );
  const [httpBody, setHttpBody] = useState(String(action.body ?? ''));
  const [httpTimeout, setHttpTimeout] = useState(String(action.timeoutMs ?? 10000));
  const [httpCarryLogin, setHttpCarryLogin] = useState(action.carryLoginState === true);
  const [httpSaveAs, setHttpSaveAs] = useState<{ varName: string; from: 'body' | 'status'; path: string }>(() => {
    const s = action.saveAs as { varName?: unknown; from?: unknown; path?: unknown } | undefined;
    return { varName: String(s?.varName ?? ''), from: s?.from === 'status' ? 'status' : 'body', path: String(s?.path ?? '') };
  });
  const [httpAssertion, setHttpAssertion] = useState<{ status: string; match: 'equals' | 'contains' | 'regex'; expected: string } | undefined>(() => {
    const a = action.assertion as { status?: unknown; match?: unknown; expected?: unknown } | undefined;
    if (!a) return undefined;
    return {
      status: a.status !== undefined ? String(a.status) : '',
      match: a.match === 'equals' || a.match === 'regex' ? a.match : 'contains',
      expected: String(a.expected ?? ''),
    };
  });

  // mobile-only
  const isMobileForm = platform === 'mobile';
  const [swipeFrom, setSwipeFrom] = useState<Locator[]>(() => {
    if (Array.isArray(action.from)) return action.from as Locator[];
    return [{ strategy: 'accessibilityId', value: '' }];
  });
  const [swipeTo, setSwipeTo] = useState<Locator[]>(() => {
    if (Array.isArray(action.to)) return action.to as Locator[];
    return [{ strategy: 'accessibilityId', value: '' }];
  });
  const [appearanceMode, setAppearanceMode] = useState<'light' | 'dark'>(
    (action.mode as 'light' | 'dark') ?? 'light',
  );
  const [networkState, setNetworkState] = useState<'online' | 'offline' | 'airplane'>(
    (action.state as 'online' | 'offline' | 'airplane') ?? 'online',
  );
  const [latInput, setLatInput] = useState(String(action.latitude ?? 0));
  const [lonInput, setLonInput] = useState(String(action.longitude ?? 0));
  const [appOpenBundleId, setAppOpenBundleId] = useState(String(action.bundleId ?? ''));

  useEffect(() => {
    if (kind !== 'upload' || !caseId) return;
    let cancelled = false;
    api.attachments.list(caseId).then((rows) => { if (!cancelled) setAttachments(rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [kind, caseId]);

  /** 把当前表单状态构建为 action（含未保存编辑）；assertJson 解析失败返回 null。类型切换与保存共用。 */
  const buildAction = (): Record<string, unknown> | null => {
    const next: Record<string, unknown> = { ...action };

    // waitFor 定位可选：滤掉没填值的候选，全空 → locator:[] = 固定时长等待；
    // 其他类型原样透传，空值候选仍由 zod 逐个拦截。
    if (kindNeedsLocator(kind)) {
      next.locator = kind === 'waitFor'
        ? locators.filter((l) => String(l.value ?? '').trim())
        : locators;
    }
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
    if (kind === 'httpRequest') {
      next.method = httpMethod;
      next.url = httpUrl.trim();
      next.headers = httpHeaders
        .filter((h) => h.key.trim())
        .slice(0, 20)
        .map((h) => ({ key: h.key.trim(), value: h.value }));
      if (httpBody) next.body = httpBody;
      else delete next.body;
      next.timeoutMs = Math.max(1000, Math.min(30000, Number(httpTimeout) || 10000));
      if (httpCarryLogin) next.carryLoginState = true;
      else delete next.carryLoginState;
      if (httpSaveAs.varName.trim()) {
        next.saveAs = {
          varName: httpSaveAs.varName.trim(),
          from: httpSaveAs.from,
          ...(httpSaveAs.from === 'body' && httpSaveAs.path.trim() ? { path: httpSaveAs.path.trim() } : {}),
        };
      } else {
        delete next.saveAs;
      }
      if (httpAssertion && (httpAssertion.status.trim() !== '' || httpAssertion.expected !== '')) {
        const statusNum = Number(httpAssertion.status);
        next.assertion = {
          ...(httpAssertion.status.trim() !== '' && Number.isInteger(statusNum) ? { status: statusNum } : {}),
          match: httpAssertion.match,
          ...(httpAssertion.expected !== '' ? { expected: httpAssertion.expected } : {}),
        };
      } else {
        delete next.assertion;
      }
    }
    if (kind === 'swipe') {
      next.from = swipeFrom;
      next.to = swipeTo;
    }
    if (kind === 'setAppearance') next.mode = appearanceMode;
    if (kind === 'setNetwork') next.state = networkState;
    if (kind === 'setLocation') {
      next.latitude = Number(latInput) || 0;
      next.longitude = Number(lonInput) || 0;
    }
    if (kind === 'appOpen') {
      next.bundleId = appOpenBundleId.trim() || undefined;
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
      setFieldErrors({ sensitive: t('cases:sensitiveNeeded') });
      return;
    }
    if (kind === 'extract' && extractMode === 'smartExtract' && !extractDescription.trim() && !extractPattern.trim()) {
      setFieldErrors({ 'action.description': t('cases:smartExtractNeedsDesc') });
      return;
    }
    if (kind === 'aiTask' && !aiInstruction.trim()) {
      setFieldErrors({ 'action.instruction': t('cases:instructionRequired') });
      return;
    }
    // 自然语言描述里填 DSL JSON 是常见误操作（参数应填下方表单字段）——拦截并指路，
    // 否则保存后 AI 编译拿到的"指令"是一段 JSON，无从编译。
    {
      const inst = rowInstruction.trim();
      if (/^[[{]/.test(inst)) {
        try {
          JSON.parse(inst);
          setFieldErrors({ instruction: t('cases:dslJsonNotAllowed') });
          return;
        } catch { /* 不是合法 JSON，按普通文本放行 */ }
      }
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
      setFieldErrors({ 'action.equals': t('cases:invalidJsonExpected') });
      return;
    }
    const v = validateStepEdit({ action: next, delayMs: delayMs ? Number(delayMs) : undefined });
    if (!v.ok) {
      const translated: Record<string, string> = {};
      for (const [path, token] of Object.entries(v.errors)) translated[path] = errText(token, path);
      setFieldErrors(translated);
      return;
    }
    // aiTask 必须先 AI 编译出 compiled：空数组 = dispatcher 抛 compile-missing。
    // 非 aiTask 编辑只改 compiled[0]：保存时保留其余动作（AI 可能一次产出一串 DSL），
    // 否则会把整条链覆盖成 [next]，静默丢掉后续动作。create 模式无 compiled，自然为 [next]。
    const compiledTail = Array.isArray(compiled) ? compiled.slice(1) : [];
    const compiledOut: unknown[] = kind === 'aiTask' ? (compiled ?? []) : [next, ...compiledTail];
    if (kind === 'aiTask' && compiledOut.length === 0) {
      setFieldErrors({ 'action.instruction': t('cases:aiTaskNotCompiled') });
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
  //   行级「AI 智能任务」按钮把 compiled 填回来。waitFor 例外：不填定位 = 合法空等待，正常保存。
  const saveAsPlaceholder = saveMode === 'create' && kindNeedsLocator(kind) && kind !== 'waitFor' && locators.every((l) => !String(l.value ?? '').trim());

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        {/* 2026-10-07：移除「步骤名称」input —— name 列已退役,自然语言完整说明统一存到行级 instruction。 */}
        <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          <span>{t('cases:naturalLanguageDesc')}</span>
          <textarea
            className="input-base input-xs"
            aria-invalid={!!fieldErrors.instruction}
            value={rowInstruction}
            onChange={(e) => setRowInstruction(e.target.value)}
            placeholder={t('cases:instructionRequiredPlaceholder')}
            rows={2}
          />
          <FieldError msg={fieldErrors.instruction} />
        </label>
        <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
          <span>{t('cases:delayMsLabel')}</span>
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
            <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:locatorCandidates')}</span>
            <LocatorArrayEditor locators={locators} onChange={setLocators} errors={fieldErrors} mobile={isMobileForm} />
          </div>
        )}

        {(kind === 'fill' || kind === 'select') && (
          <div className="flex flex-col gap-2">
            {kind === 'fill' && (
              <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
                {t('cases:sensitiveValue')}
              </label>
            )}
            {kind === 'fill' && sensitive ? (
              <div className="flex flex-col gap-1">
                <input
                  type="password"
                  className="input-base input-xs"
                  aria-invalid={!!fieldErrors.sensitive}
                  placeholder={t('cases:pwdDraftPlaceholder')}
                  value={pwdDraft}
                  onChange={(e) => setPwdDraft(e.target.value)}
                />
                <FieldError msg={fieldErrors.sensitive} />
              </div>
            ) : kind === 'fill' ? (
              <FillValueEditor value={fillValue} onChange={setFillValue} availableVars={availableVars} datasetVars={datasetVars} />
            ) : (
              <div className="flex flex-col gap-1">
                <input
                  className="input-base input-xs"
                  aria-invalid={!!fieldErrors['action.value']}
                  value={selectValue}
                  onChange={(e) => setSelectValue(e.target.value)}
                  placeholder={t('cases:selectValuePlaceholder')}
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
            <span>{t('cases:waitTimeoutLabel')}</span>
            <span className="text-[10px]">{t('cases:waitNoLocatorHint')}</span>
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
            {t('cases:checkLabel')}
          </label>
        )}

        {kind === 'assertText' && (
          <>
            <div className="flex gap-2">
              <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
                <span>{t('cases:assertTargetLabel')}</span>
                <select className="input-base input-xs" value={assertTarget} onChange={(e) => setAssertTarget(e.target.value as typeof assertTarget)}>
                  <option value="specifiedElement">{t('cases:assertTargetElement')}</option>
                  <option value="page">{t('cases:assertTargetPage')}</option>
                  <option value="errorMessage">{t('cases:assertTargetErrorArea')}</option>
                  <option value="url">{t('cases:assertTargetCurrentUrl')}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
                <span>{t('cases:matchMode')}</span>
                <select className="input-base input-xs" value={assertMatch} onChange={(e) => setAssertMatch(e.target.value as typeof assertMatch)}>
                  <option value="equals">{t('cases:matchEqualsTrim')}</option>
                  <option value="contains">{t('cases:matchContains')}</option>
                  <option value="notContains">{t('cases:matchNotContains')}</option>
                  <option value="regex">{t('cases:matchRegex')}</option>
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:expectedText')}</span>
              <textarea className="input-base input-xs" rows={3} value={equalsText} onChange={(e) => setEqualsText(e.target.value)} />
            </label>
          </>
        )}

        {kind === 'assertJson' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            <span>{t('cases:expectedJson')}</span>
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
              <span>{t('cases:varNameLabel')}</span>
              <input
                className="input-base input-xs"
                aria-invalid={!!fieldErrors['action.varName']}
                value={varName}
                onChange={(e) => setVarName(e.target.value)}
                placeholder={t('cases:varNamePlaceholder', { col: '{{变量名}}' })}
              />
              <FieldError msg={fieldErrors['action.varName']} />
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:extractModeLabel')}</span>
              <select className="input-base input-xs" value={extractMode} onChange={(e) => setExtractMode(e.target.value as typeof extractMode)}>
                <option value="completeValue">{t('cases:extractCompleteValue')}</option>
                <option value="smartExtract">{t('cases:extractSmart')}</option>
                <option value="regex">{t('cases:matchRegex')}</option>
              </select>
            </label>
            {extractMode === 'regex' && (
              <div className="flex gap-2">
                <label className="flex flex-col gap-1 text-[11px] flex-[3]" style={{ color: 'var(--muted-foreground)' }}>
                  <span>{t('cases:regexLabel')}</span>
                  <input
                    className="input-base input-xs font-mono"
                    aria-invalid={!!fieldErrors['action.pattern']}
                    value={extractPattern}
                    onChange={(e) => setExtractPattern(e.target.value)}
                    placeholder={t('cases:regexValuePlaceholder')}
                  />
                  <FieldError msg={fieldErrors['action.pattern']} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
                  <span>{t('cases:captureGroup')}</span>
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
                  <span>{t('cases:extractDescLabel')}</span>
                  <textarea
                    className="input-base input-xs"
                    aria-invalid={!!fieldErrors['action.description']}
                    rows={2}
                    value={extractDescription}
                    onChange={(e) => setExtractDescription(e.target.value)}
                    placeholder={t('cases:extractDescPlaceholder')}
                  />
                  <FieldError msg={fieldErrors['action.description']} />
                </label>
                <button
                  type="button"
                  onClick={async () => {
                    if (!caseId) { setCompileErr(t('cases:missingCaseId')); return; }
                    const sampleText = window.prompt(t('cases:samplePrompt'), '');
                    if (!sampleText) return;
                    setCompiling(true);
                    setCompileErr('');
                    try {
                      const r = await api.cases.compileExtract(caseId, { description: extractDescription.trim(), sampleText });
                      if (r.pattern) {
                        setExtractPattern(r.pattern);
                        setExtractGroup(String(r.group ?? 0));
                      } else {
                        setCompileErr(r.error ?? t('cases:compileFailed'));
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
                  {compiling ? t('cases:compilingInProgress') : t('cases:generateRegex')}
                </button>
                {compileErr && <p className="text-[11px]" style={{ color: 'var(--destructive)' }}>{compileErr}</p>}
                {extractPattern && (
                  <p className="text-[11px] font-mono" style={{ color: 'var(--muted-foreground)' }}>
                    {t('cases:regexGenerated', { pattern: extractPattern, group: extractGroup })}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {kind === 'aiTask' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:aiSubInstruction')}</span>
              <textarea
                className="input-base input-xs"
                aria-invalid={!!fieldErrors['action.instruction']}
                rows={3}
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                placeholder={t('cases:aiSubPlaceholder')}
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
              title={t('cases:aiCompileTooltip')}
            >
              {t('cases:aiCompileButton')}
            </button>
            <div className="text-[11px] flex flex-col gap-1" style={{ color: 'var(--muted-foreground)' }}>
              <p>{t('cases:aiStepBullet1')}</p>
              <p>{t('cases:aiStepBullet2')}</p>
            </div>
          </div>
        )}

        {kind === 'upload' && (
          <div className="flex flex-col gap-2">
            <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:uploadHint')}</span>
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
                  setFieldErrors((cur) => ({ ...cur, 'action.fileId': t('cases:fileTooLarge') }));
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
                <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:orPickUploaded')}</span>
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
                {t('cases:boundFileId')} <code>{fileId.slice(0, 8)}…</code>
                <button
                  type="button"
                  onClick={() => setFileId(undefined)}
                  className="press ml-2 text-[11px] underline-offset-2 hover:underline"
                  style={{ background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--primary)', cursor: 'pointer', borderRadius: 4 }}
                >
                  {t('cases:replaceFile')}
                </button>
              </p>
            )}
          </div>
        )}

        {kind === 'switchTab' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            <span>{t('cases:tabRefLabel')}</span>
            <input
              className="input-base input-xs"
              aria-invalid={!!fieldErrors['action.tabRef']}
              value={tabRef}
              onChange={(e) => setTabRef(e.target.value)}
              placeholder={t('cases:tabRefPlaceholder')}
            />
            <FieldError msg={fieldErrors['action.tabRef']} />
          </label>
        )}

        {kind === 'screenshot' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            <span>{t('cases:screenshotName')}</span>
            <input className="input-base input-xs" value={shotName} onChange={(e) => setShotName(e.target.value)} placeholder={t('cases:optional')} />
          </label>
        )}

        {/* ---- mobile-only kind forms ----  (tap/swipe/setAppearance/setNetwork/setLocation/appOpen/appBack/appRestart/home) */}
        {kind === 'swipe' && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:swipeFromLabel')}</span>
              <LocatorArrayEditor locators={swipeFrom} onChange={setSwipeFrom} errors={fieldErrors} mobile />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:swipeToLabel')}</span>
              <LocatorArrayEditor locators={swipeTo} onChange={setSwipeTo} errors={fieldErrors} mobile />
            </div>
          </div>
        )}

        {kind === 'setAppearance' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            <span>{t('cases:appearanceMode')}</span>
            <select className="input-base input-xs" value={appearanceMode} onChange={(e) => setAppearanceMode(e.target.value as 'light' | 'dark')}>
              <option value="light">{t('cases:light')}</option>
              <option value="dark">{t('cases:dark')}</option>
            </select>
          </label>
        )}

        {kind === 'setNetwork' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            <span>{t('cases:networkState')}</span>
            <select className="input-base input-xs" value={networkState} onChange={(e) => setNetworkState(e.target.value as 'online' | 'offline' | 'airplane')}>
              <option value="online">{t('cases:online')}</option>
              <option value="offline">{t('cases:offline')}</option>
              <option value="airplane">{t('cases:airplane')}</option>
            </select>
          </label>
        )}

        {kind === 'setLocation' && (
          <div className="flex gap-2">
            <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:latitude')}</span>
              <input
                className="input-base input-xs"
                aria-invalid={!!fieldErrors['action.latitude']}
                value={latInput}
                onChange={(e) => setLatInput(e.target.value)}
                inputMode="numeric"
                placeholder="0"
              />
              <FieldError msg={fieldErrors['action.latitude']} />
            </label>
            <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:longitude')}</span>
              <input
                className="input-base input-xs"
                aria-invalid={!!fieldErrors['action.longitude']}
                value={lonInput}
                onChange={(e) => setLonInput(e.target.value)}
                inputMode="numeric"
                placeholder="0"
              />
              <FieldError msg={fieldErrors['action.longitude']} />
            </label>
          </div>
        )}

        {kind === 'appOpen' && (
          <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            <span>{t('cases:bundleIdLabel')}</span>
            <input
              className="input-base input-xs"
              aria-invalid={!!fieldErrors['action.bundleId']}
              value={appOpenBundleId}
              onChange={(e) => setAppOpenBundleId(e.target.value)}
              placeholder="com.example.app"
            />
            <FieldError msg={fieldErrors['action.bundleId']} />
          </label>
        )}

        {(kind === 'appBack' || kind === 'appRestart' || kind === 'home') && (
          <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('cases:noExtraFieldsHint')}
          </p>
        )}

        {kind === 'queryDb' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:queryTableLabel')}</span>
              <select className="input-base input-xs" value={queryTable} onChange={(e) => setQueryTable(e.target.value)}>
                {(allowedTablesData ? Object.keys(allowedTablesData) : ['test_cases']).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:queryColumnsLabel')}</span>
              <select multiple className="input-base input-xs" style={{ minHeight: 80 }} value={queryColumns} onChange={(e) => setQueryColumns(Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {queryTableCols.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:whereConditions')}</span>
              {queryWhere.map((w, i) => (
                <div key={i} className="flex gap-1 items-center">
                  <select className="input-base input-xs flex-1" value={w.column} onChange={(e) => {
                    const next = [...queryWhere]; next[i] = { ...w, column: e.target.value }; setQueryWhere(next);
                  }}>
                    <option value="">{t('cases:columnDash')}</option>
                    {queryTableCols.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input className="input-base input-xs flex-1" value={w.equals} placeholder={t('cases:equalsOp')} onChange={(e) => {
                    const next = [...queryWhere]; next[i] = { ...w, equals: e.target.value }; setQueryWhere(next);
                  }} />
                  <button type="button" className="text-[11px] press" style={{ background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--destructive)', cursor: 'pointer', borderRadius: 4 }} onClick={() => setQueryWhere(queryWhere.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              {queryWhere.length < 10 && (
                <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px dashed var(--border)', color: 'var(--primary)', cursor: 'pointer', borderRadius: 4, padding: '4px 8px' }} onClick={() => setQueryWhere([...queryWhere, { column: queryTableCols[0] ?? '', equals: '' }])}>
                  {t('cases:addCondition')}
                </button>
              )}
            </div>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:queryLimitLabel')}</span>
              <input className="input-base input-xs" type="number" min={1} max={200} value={queryLimit} onChange={(e) => setQueryLimit(e.target.value)} />
            </label>
            <DbAssertionEditor value={queryAssertion} onChange={setQueryAssertion} columns={queryTableCols} />
          </div>
        )}

        {kind === 'observeLog' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:observeWindowLabel')}</span>
              <input className="input-base input-xs" type="number" min={1000} max={600000} value={observeWindowMs} onChange={(e) => setObserveWindowMs(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:observeKeywordsLabel')}</span>
              <input className="input-base input-xs" value={observeKeywords} onChange={(e) => setObserveKeywords(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:observeFromLineLabel')}</span>
              <input className="input-base input-xs" type="number" min={1} max={10000} value={observeFromLine} onChange={(e) => setObserveFromLine(e.target.value)} />
            </label>
            <DbAssertionEditor value={logAssertion} onChange={setLogAssertion} />
          </div>
        )}

        {kind === 'httpRequest' && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-1.5">
              <select className="input-base input-xs" style={{ width: 96 }} value={httpMethod} onChange={(e) => setHttpMethod(e.target.value)}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                className="input-base input-xs flex-1"
                aria-invalid={!!fieldErrors['action.url']}
                value={httpUrl}
                onChange={(e) => setHttpUrl(e.target.value)}
                placeholder={t('cases:httpUrlPlaceholder', { col: '{{var}}' })}
              />
            </div>
            <FieldError msg={fieldErrors['action.url']} />
            <div className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:httpHeadersLabel', { col: '{{var}}' })}</span>
              {httpHeaders.map((h, i) => (
                <div key={i} className="flex gap-1 items-center">
                  <input className="input-base input-xs" style={{ width: 140 }} value={h.key} placeholder="Header" onChange={(e) => {
                    const nextH = [...httpHeaders]; nextH[i] = { ...h, key: e.target.value }; setHttpHeaders(nextH);
                  }} />
                  <input className="input-base input-xs flex-1" value={h.value} placeholder={t('cases:headerValuePlaceholder')} onChange={(e) => {
                    const nextH = [...httpHeaders]; nextH[i] = { ...h, value: e.target.value }; setHttpHeaders(nextH);
                  }} />
                  <button type="button" className="text-[11px] press" style={{ background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--destructive)', cursor: 'pointer', borderRadius: 4 }} onClick={() => setHttpHeaders(httpHeaders.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              {httpHeaders.length < 20 && (
                <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px dashed var(--border)', color: 'var(--primary)', cursor: 'pointer', borderRadius: 4, padding: '4px 8px' }} onClick={() => setHttpHeaders([...httpHeaders, { key: '', value: '' }])}>
                  {t('cases:addHeader')}
                </button>
              )}
            </div>
            {httpMethod !== 'GET' && httpMethod !== 'HEAD' && (
              <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                <span>{t('cases:httpBodyLabel', { col: '{{var}}' })}</span>
                <textarea
                  className="input-base input-xs font-mono"
                  style={{ minHeight: 72 }}
                  value={httpBody}
                  onChange={(e) => setHttpBody(e.target.value)}
                  placeholder='{"name": "value"}'
                />
              </label>
            )}
            <div className="flex gap-2 items-center">
              <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
                <span>{t('cases:httpTimeoutLabel')}</span>
                <input className="input-base input-xs" type="number" min={1000} max={30000} value={httpTimeout} onChange={(e) => setHttpTimeout(e.target.value)} />
              </label>
              <label className="flex gap-1.5 items-center text-[11px] self-end pb-1 cursor-pointer" style={{ color: 'var(--muted-foreground)' }}>
                <input type="checkbox" checked={httpCarryLogin} onChange={(e) => setHttpCarryLogin(e.target.checked)} />
                <span>{t('cases:carryLoginCookie')}</span>
              </label>
            </div>
            <div className="flex flex-col gap-1.5 p-2 rounded-[var(--radius-sm)]" style={{ border: '1px solid var(--border)', background: 'var(--muted)' }}>
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:saveVarLabel', { col: '{{var}}' })}</span>
              <div className="flex gap-1.5">
                <input className="input-base input-xs" style={{ width: 130 }} value={httpSaveAs.varName} placeholder={t('cases:saveVarNamePlaceholder')} onChange={(e) => setHttpSaveAs({ ...httpSaveAs, varName: e.target.value })} />
                <select className="input-base input-xs" style={{ width: 96 }} value={httpSaveAs.from} onChange={(e) => setHttpSaveAs({ ...httpSaveAs, from: e.target.value as 'body' | 'status' })}>
                  <option value="body">{t('cases:saveVarFromBody')}</option>
                  <option value="status">{t('cases:saveVarFromStatus')}</option>
                </select>
                {httpSaveAs.from === 'body' && (
                  <input className="input-base input-xs flex-1 font-mono" value={httpSaveAs.path} placeholder={t('cases:saveVarPathPlaceholder')} onChange={(e) => setHttpSaveAs({ ...httpSaveAs, path: e.target.value })} />
                )}
              </div>
            </div>
            <HttpAssertionEditor value={httpAssertion} onChange={setHttpAssertion} />
          </div>
        )}

        {/* compiled 动作链（只读）：AI 一次产出一串 DSL 时（如登录+操作+断言合并成一步），
            上方表单只镜像 compiled[0]；这里枚举整条链提示用户保存不会丢尾部动作。 */}
        {Array.isArray(compiled) && compiled.length > 1 && (
          <div className="flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-dashed p-2" style={{ borderColor: 'var(--border)' }}>
            <span className="text-[11px] font-semibold" style={{ color: 'var(--muted-foreground)' }}>
              {t('cases:compiledChainTitle', { count: compiled.length })}
            </span>
            <ol className="flex flex-col gap-0.5 m-0 p-0 list-none">
              {compiled.map((c, i) => (
                <li key={i} className="text-[11px] font-mono" style={{ color: 'var(--muted-foreground)' }}>
                  {i + 1}. {stepSummary({ compiled: [c] }, t)}
                </li>
              ))}
            </ol>
            <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('cases:compiledChainHint')}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 justify-end px-5 py-4 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('common:cancel')}</Button>
        {saveAsPlaceholder && (
          <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('cases:saveAsPlaceholderHint')}
          </span>
        )}
        <Button size="sm" onClick={handleSave}>{saveLabel}</Button>
      </div>
    </div>
  );
}

function DbAssertionEditor({ value, onChange, columns }: { value: { match: 'equals' | 'contains' | 'regex'; expected: string; column?: string } | undefined; onChange: (v: typeof value) => void; columns?: string[] }) {
  const { t } = useTranslation();
  if (!value) {
    return (
      <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px dashed var(--border)', color: 'var(--muted-foreground)', cursor: 'pointer', padding: '4px 8px', borderRadius: 5 }} onClick={() => onChange({ match: 'contains', expected: '' })}>
        {t('cases:addAssertion')}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 p-2 rounded-[var(--radius-sm)]" style={{ border: '1px solid var(--border)', background: 'var(--muted)' }}>
      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:assertMismatch')}</span>
      <div className="flex gap-1.5">
        <select className="input-base input-xs" value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as 'equals' | 'contains' | 'regex' })}>
          <option value="equals">{t('cases:equalsOp')}</option>
          <option value="contains">{t('cases:matchContains')}</option>
          <option value="regex">{t('cases:regexLabel')}</option>
        </select>
        <input className="input-base input-xs flex-1" value={value.expected} placeholder={t('cases:expectedText')} onChange={(e) => onChange({ ...value, expected: e.target.value })} />
      </div>
      {columns && columns.length > 0 && (
        <select className="input-base input-xs" value={value.column ?? ''} onChange={(e) => onChange({ ...value, column: e.target.value || undefined })}>
          <option value="">{t('cases:anyColumn')}</option>
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px solid var(--destructive)', color: 'var(--destructive)', cursor: 'pointer', borderRadius: 4, padding: '2px 8px' }} onClick={() => onChange(undefined)}>{t('cases:removeAssertion')}</button>
    </div>
  );
}

function HttpAssertionEditor({ value, onChange }: { value: { status: string; match: 'equals' | 'contains' | 'regex'; expected: string } | undefined; onChange: (v: typeof value) => void }) {
  const { t } = useTranslation();
  if (!value) {
    return (
      <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px dashed var(--border)', color: 'var(--muted-foreground)', cursor: 'pointer', padding: '4px 8px', borderRadius: 5 }} onClick={() => onChange({ status: '', match: 'contains', expected: '' })}>
        {t('cases:addAssertion')}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 p-2 rounded-[var(--radius-sm)]" style={{ border: '1px solid var(--border)', background: 'var(--muted)' }}>
      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:httpAssertMismatch')}</span>
      <div className="flex gap-1.5">
        <input className="input-base input-xs" style={{ width: 130 }} type="number" min={100} max={599} value={value.status ?? ''} placeholder={t('cases:statusCodePlaceholder')} onChange={(e) => onChange({ ...value, status: e.target.value })} />
        <select className="input-base input-xs" style={{ width: 84 }} value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as 'equals' | 'contains' | 'regex' })}>
          <option value="equals">{t('cases:equalsOp')}</option>
          <option value="contains">{t('cases:matchContains')}</option>
          <option value="regex">{t('cases:regexLabel')}</option>
        </select>
        <input className="input-base input-xs flex-1" value={value.expected} placeholder={t('cases:bodyExpectPlaceholder')} onChange={(e) => onChange({ ...value, expected: e.target.value })} />
      </div>
      <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px solid var(--destructive)', color: 'var(--destructive)', cursor: 'pointer', borderRadius: 4, padding: '2px 8px' }} onClick={() => onChange(undefined)}>{t('cases:removeAssertion')}</button>
    </div>
  );
}
