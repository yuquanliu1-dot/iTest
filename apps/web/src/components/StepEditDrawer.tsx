import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import type { Locator, ObserveLogAction } from '@itest/shared';
import type { StepAction } from '@itest/shared';
import { SyslogFacility, SyslogSeverity } from '@itest/shared';
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
  /** 'edit' = modify an existing step; 'create' = add a new uncompiled blank step (first render carries a default click action).
   *  Only affects the title copy + save button copy + default source; the save data flow is unchanged. */
  mode?: 'edit' | 'create';
  availableVars?: string[];
  datasetVars?: string[];
  caseId?: string;
  /** For mobile cases, enables mobile step kinds + hides web-only kinds; also affects the kind dropdown and form fields. */
  platform?: 'web' | 'mobile';
  onSave: (next: StepClip) => void;
  onClose: () => void;
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <span className="text-[11px]" style={{ color: 'var(--destructive)' }}>{msg}</span>;
}

/** Step edit drawer: the shell handles type switching + common fields; DrawerForm remounts per kind to handle the differing fields. */
export default function StepEditDrawer({ initial, mode = 'edit', availableVars = [], datasetVars = [], caseId, platform = 'web', onSave, onClose }: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { projectId: routeProjectId, versionId: routeVersionId } = useParams<{ projectId: string; versionId: string }>();
  // Mobile-visible kinds = 9 mobile + 6 cross-platform (click/fill/assertVisible/assertText/screenshot/aiTask)
  const MOBILE_ALLOWED_KINDS: ReadonlySet<string> = new Set([
    'tap', 'swipe', 'setAppearance', 'setNetwork', 'setLocation',
    'appOpen', 'appBack', 'appRestart', 'home',
    'click', 'fill', 'assertVisible', 'assertText', 'screenshot', 'aiTask',
  ]);
  const isMobile = platform === 'mobile';
  const availableKinds = (isMobile ? STEP_KINDS.filter((k) => MOBILE_ALLOWED_KINDS.has(k)) : STEP_KINDS) as StepKind[];
  const [draft, setDraft] = useState<StepClip>(initial);
  // Common fields live in the shell so type switching (DrawerForm remount) doesn't lose the user-entered delay
  // 2026-10-07 removed the name input: the name column is retired; row-level natural language is carried entirely by rowInstruction.
  const [delayMs, setDelayMs] = useState(initial.delayMs ? String(initial.delayMs) : '');
  const kind = ((draft.action as { kind?: string })?.kind ?? (isMobile ? 'tap' : 'click')) as StepKind;
  // DrawerForm registers the latest buildAction on every render; before switching type, use it to sync unsaved field edits into the draft
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
              // Grab DrawerForm's current form state (including unsaved edits) first, then switch; avoids losing edits on switch
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

/* ---------------- DrawerForm: per-kind differing fields + save validation ---------------- */

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
  // validateStepEdit returns i18n tokens → copy in the current language; locator candidate index is derived from the field path.
  const errText = (token: string, path: string): string =>
    token === 'stepLocatorValueEmpty'
      ? t('cases:stepLocatorValueEmpty', { n: Number(/^action\.locator\.(\d+)\.value$/.exec(path)?.[1] ?? 0) + 1 })
      : token.startsWith('step') ? t(`cases:${token}`) : token;
  const { projectId: routeProjectId, versionId: routeVersionId } = useParams<{ projectId: string; versionId: string }>();
  const action = clip.action as Record<string, unknown>;
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // locator (editable for kinds that need locating)
  const [locators, setLocators] = useState<Locator[]>(() =>
    Array.isArray(action.locator) ? (action.locator as Locator[]) : kindNeedsLocator(kind) ? [{ strategy: 'css', value: '' }] : [],
  );

  // fill sensitive value (migrated from Modal: the '__sensitive__' placeholder must be re-entered)
  const [sensitive, setSensitive] = useState(!!(action as { sensitive?: boolean }).sensitive);
  const [pwdDraft, setPwdDraft] = useState('');
  const [fillValue, setFillValue] = useState<unknown>(
    action.sensitive ? '' : action.value ?? '',
  );
  const [selectValue, setSelectValue] = useState(typeof action.value === 'string' ? action.value : '');

  // upload (migrated from Modal)
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

  // extract (migrated from Modal, includes smart-extract compilation)
  const [varName, setVarName] = useState(String(action.varName ?? ''));
  const [extractMode, setExtractMode] = useState<'completeValue' | 'smartExtract' | 'regex'>(
    (action.mode as 'completeValue') ?? 'completeValue',
  );
  const [extractPattern, setExtractPattern] = useState(String(action.pattern ?? ''));
  const [extractGroup, setExtractGroup] = useState(String(action.group ?? '1'));
  const [extractDescription, setExtractDescription] = useState(String(action.description ?? ''));

  // aiTask sub-step instruction (read by the LLM across turns) vs row-level instruction (for humans / LLM kick-off, not read at replay).
  // Row-level instruction uses rowInstruction state; this aiTask block uses aiInstruction independently.
  // The two fields are different DB columns (row instruction + compiled[i].instruction); don't mix them.
  const [rowInstruction, setRowInstruction] = useState(String(clip.instruction ?? ''));
  const [aiInstruction, setAiInstruction] = useState(String(action.instruction ?? ''));
  const [url, setUrl] = useState(String(action.url ?? ''));
  const [timeoutMs, setTimeoutMs] = useState(String(action.timeoutMs ?? ''));
  const [checked, setChecked] = useState(action.checked !== false);
  const [tabRef, setTabRef] = useState(String(action.tabRef ?? ''));
  const [shotName, setShotName] = useState(String(action.name ?? ''));

  // scroll absolute positions (kept as strings for easy input editing; buildAction normalizes to non-negative integers)
  const [scrollTopInput, setScrollTopInput] = useState(String(action.scrollTop ?? 0));
  const [scrollLeftInput, setScrollLeftInput] = useState(String(action.scrollLeft ?? 0));

  // 2026-10-06: row-level compiled array (used by aiTask). Other kinds
  //   get compiled=[action] naturally backfilled by buildAction, sharing the same path as the dispatcher.
  // 2026-10-07: aiTask compilation changed to jump to the AI assistant via stage_case_op(action=update_step / insert_step);
  //   here it's display-only — persistence is written back entirely by the assistant after the user checks items in StagePanel.
  const initialDraftCompiled: unknown[] | null = Array.isArray(clip.compiled) ? clip.compiled : null;
  const [compiled] = useState<unknown[] | null>(initialDraftCompiled);

  // extract smart-extract compilation (keeps the historical variable names compiling/compileErr)
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState('');

  // observeLog
  const [observeSyslogRef, setObserveSyslogRef] = useState(String(action.syslogRef ?? ''));
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
  const [httpAssertion, setHttpAssertion] = useState<{ status: string; match: 'equals' | 'contains' | 'notContains' | 'regex'; expected: string; allowTransportFailure: boolean } | undefined>(() => {
    const a = action.assertion as { status?: unknown; match?: unknown; expected?: unknown; allowTransportFailure?: unknown } | undefined;
    if (!a) return undefined;
    return {
      status: a.status !== undefined ? String(a.status) : '',
      match: a.match === 'equals' || a.match === 'regex' || a.match === 'notContains' ? a.match : 'contains',
      expected: String(a.expected ?? ''),
      allowTransportFailure: a.allowTransportFailure === true,
    };
  });

  // sendSyslog
  const [syslogProtocol, setSyslogProtocol] = useState<string>(String(action.protocol ?? 'udp'));
  const [syslogHost, setSyslogHost] = useState(String(action.host ?? ''));
  const [syslogPort, setSyslogPort] = useState(String(action.port ?? 514));
  const [syslogFacility, setSyslogFacility] = useState<string>(String(action.facility ?? 'user'));
  const [syslogSeverity, setSyslogSeverity] = useState<string>(String(action.severity ?? 'info'));
  const [syslogMessage, setSyslogMessage] = useState(String(action.message ?? ''));
  const [syslogTimeout, setSyslogTimeout] = useState(String(action.timeoutMs ?? 5000));

  // sql (query the SUT's own database)
  const [sqlText, setSqlText] = useState(typeof action.sql === 'string' ? action.sql : '');
  const [sqlParams, setSqlParams] = useState<string[]>(
    Array.isArray(action.params) ? (action.params as unknown[]).map((p) => String(p ?? '')) : [],
  );
  const [sqlLimit, setSqlLimit] = useState(String(action.limit ?? 50));
  const [sqlDbRef, setSqlDbRef] = useState(typeof action.dbRef === 'string' ? action.dbRef : '');
  const [sqlAssertion, setSqlAssertion] = useState<{ match: 'equals' | 'contains' | 'regex'; expected: string; column?: string } | undefined>(
    action.assertion as { match: 'equals' | 'contains' | 'regex'; expected: string; column?: string } | undefined,
  );

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

  /** Builds the current form state into an action (including unsaved edits); returns null on assertJson parse failure. Shared by type switching and saving. */
  const buildAction = (): Record<string, unknown> | null => {
    const next: Record<string, unknown> = { ...action };

    // waitFor locating is optional: filter out candidates with no value; all empty → locator:[] = fixed-duration wait;
    // other kinds pass through as-is; empty-value candidates are still caught one by one by zod.
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
    if (kind === 'scroll') {
      next.scrollTop = Math.max(0, Math.round(Number(scrollTopInput) || 0));
      next.scrollLeft = Math.max(0, Math.round(Number(scrollLeftInput) || 0));
    }
    // press requires a key (zod); fallback to Enter when missing/lost (the recorder only produces Enter presses)
    if (kind === 'press') next.key = typeof next.key === 'string' && next.key.trim() ? next.key : 'Enter';
    if (kind === 'switchTab') next.tabRef = tabRef;
    if (kind === 'screenshot') next.name = shotName;
    if (kind === 'observeLog') {
      if (observeSyslogRef.trim()) next.syslogRef = observeSyslogRef.trim();
      else delete next.syslogRef;
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
      // allowTransportFailure alone counts as an assertion (transport-layer failure passes, no status/expected needed).
      if (httpAssertion && (httpAssertion.status.trim() !== '' || httpAssertion.expected !== '' || httpAssertion.allowTransportFailure)) {
        const statusNum = Number(httpAssertion.status);
        next.assertion = {
          ...(httpAssertion.status.trim() !== '' && Number.isInteger(statusNum) ? { status: statusNum } : {}),
          match: httpAssertion.match,
          ...(httpAssertion.expected !== '' ? { expected: httpAssertion.expected } : {}),
          ...(httpAssertion.allowTransportFailure ? { allowTransportFailure: true } : {}),
        };
      } else {
        delete next.assertion;
      }
    }
    if (kind === 'sendSyslog') {
      next.protocol = syslogProtocol === 'tcp' ? 'tcp' : 'udp';
      next.host = syslogHost.trim();
      next.port = Math.max(1, Math.min(65535, Number(syslogPort) || 514));
      next.facility = syslogFacility;
      next.severity = syslogSeverity;
      next.message = syslogMessage;
      next.timeoutMs = Math.max(1000, Math.min(30000, Number(syslogTimeout) || 5000));
    }
    if (kind === 'sql') {
      next.sql = sqlText;
      next.limit = Math.max(1, Math.min(200, Number(sqlLimit) || 50));
      // params keep the raw text ("{{var}}" is replaced at execution time); here we only normalize types and drop empty strings.
      next.params = sqlParams
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .slice(0, 20)
        .map((p) => {
          if (p === 'true') return true;
          if (p === 'false') return false;
          if (p === 'null') return null;
          if (!Number.isNaN(Number(p))) return Number(p);
          return p;
        });
      if (sqlDbRef.trim()) next.dbRef = sqlDbRef.trim();
      else delete next.dbRef;
      if (sqlAssertion) next.assertion = sqlAssertion;
      else delete next.assertion;
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

  // Register the latest closure on every render (no dependency array); clear on unmount — the shell can only grab it while the form is mounted
  useEffect(() => {
    buildActionRef.current = buildAction;
    return () => { buildActionRef.current = null; };
  });

  /** Save: first the interaction-level gate, then build + zod validation (migrated from StepEditModal.handleSave).
   *  2026-10-06: aiTask requires compiled to be non-empty (uncompiled steps can't be saved); the dispatcher blocks execution.
   *  Other kinds get compiled backfilled to [action] naturally by buildAction, sharing the same path as the dispatcher.
   *  2026-10-07: relaxed row placement validation — create mode allows placeholder saves with empty locator/empty compiled:
   *    when the user manually sets enableAutoCompile = true, it goes straight to {kind:'click', locator:[]} with compiled:[] pushed as placeholder;
   *    the top "Run" is blocked by the dispatcher's compile-missing error, and the row-level "AI smart task" button backfills in one click. */
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
    // Putting DSL JSON into the natural-language description is a common mistake (parameters belong in the form fields below) — intercept and redirect,
    // otherwise after saving the AI compiler receives a "instruction" that is just JSON and has nothing to compile.
    {
      const inst = rowInstruction.trim();
      if (/^[[{]/.test(inst)) {
        try {
          JSON.parse(inst);
          setFieldErrors({ instruction: t('cases:dslJsonNotAllowed') });
          return;
        } catch { /* not valid JSON; let it through as plain text */ }
      }
    }
    // Placeholder save branch: in create mode with all locators empty, skip zod validation and persist compiled:[] directly
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
    // aiTask must first have compiled produced by AI compilation: an empty array = the dispatcher throws compile-missing.
    // Non-aiTask edits only change compiled[0]: keep the other actions on save (the AI may produce a chain of DSL in one shot),
    // otherwise the whole chain would be overwritten with [next], silently dropping later actions. Create mode has no compiled, so it's naturally [next].
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
  // In create mode when the user left locator empty, offer a "save as uncompiled placeholder" exit — after the drawer closes, top-level Run stays disabled,
  //   and the row-level "AI smart task" button fills compiled back in. waitFor is the exception: no locator = a legal empty wait, save normally.
  const saveAsPlaceholder = saveMode === 'create' && kindNeedsLocator(kind) && kind !== 'waitFor' && locators.every((l) => !String(l.value ?? '').trim());

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        {/* 2026-10-07: removed the "step name" input — the name column is retired; full natural-language descriptions are stored uniformly in the row-level instruction. */}
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

        {kind === 'scroll' && (
          <div className="flex gap-3">
            <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:stepSummary.fieldScrollTop')}</span>
              <input
                className="input-base input-xs"
                aria-invalid={!!fieldErrors['action.scrollTop']}
                value={scrollTopInput}
                onChange={(e) => setScrollTopInput(e.target.value)}
                placeholder="0"
                inputMode="numeric"
              />
              <FieldError msg={fieldErrors['action.scrollTop']} />
            </label>
            <label className="flex flex-col gap-1 text-[11px] flex-1" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:stepSummary.fieldScrollLeft')}</span>
              <input
                className="input-base input-xs"
                aria-invalid={!!fieldErrors['action.scrollLeft']}
                value={scrollLeftInput}
                onChange={(e) => setScrollLeftInput(e.target.value)}
                placeholder="0"
                inputMode="numeric"
              />
              <FieldError msg={fieldErrors['action.scrollLeft']} />
            </label>
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
                // 2026-10-07: "AI compile" for aiTask sub-steps now jumps to the AI assistant via stage_case_op(action=update_step / insert_step).
                // The assistant can inspect_page to grab real elements + let the user check items in StagePanel → persisted.
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

        {kind === 'observeLog' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:observeSyslogRefLabel')}</span>
              <input
                className="input-base input-xs"
                value={observeSyslogRef}
                onChange={(e) => setObserveSyslogRef(e.target.value)}
                placeholder={t('cases:observeSyslogRefPlaceholder')}
              />
            </label>
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

        {kind === 'sendSyslog' && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-1.5">
              <select className="input-base input-xs" style={{ width: 88 }} value={syslogProtocol} onChange={(e) => setSyslogProtocol(e.target.value)}>
                <option value="udp">UDP</option>
                <option value="tcp">TCP</option>
              </select>
              <input
                className="input-base input-xs flex-1"
                aria-invalid={!!fieldErrors['action.host']}
                value={syslogHost}
                onChange={(e) => setSyslogHost(e.target.value)}
                placeholder={t('cases:syslogHostPlaceholder', { col: '{{var}}' })}
              />
              <input
                className="input-base input-xs"
                style={{ width: 84 }}
                type="number"
                min={1}
                max={65535}
                value={syslogPort}
                onChange={(e) => setSyslogPort(e.target.value)}
              />
            </div>
            <FieldError msg={fieldErrors['action.host']} />
            <div className="flex gap-1.5">
              <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                <span>facility</span>
                <select className="input-base input-xs" value={syslogFacility} onChange={(e) => setSyslogFacility(e.target.value)}>
                  {SyslogFacility.options.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                <span>severity</span>
                <select className="input-base input-xs" value={syslogSeverity} onChange={(e) => setSyslogSeverity(e.target.value)}>
                  {SyslogSeverity.options.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:syslogMessageLabel')}</span>
              <textarea
                className="input-base input-xs font-mono"
                style={{ minHeight: 60 }}
                aria-invalid={!!fieldErrors['action.message']}
                value={syslogMessage}
                onChange={(e) => setSyslogMessage(e.target.value)}
              />
            </label>
            <FieldError msg={fieldErrors['action.message']} />
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:syslogTimeoutLabel')}</span>
              <input className="input-base input-xs" type="number" min={1000} max={30000} value={syslogTimeout} onChange={(e) => setSyslogTimeout(e.target.value)} />
            </label>
          </div>
        )}

        {kind === 'sql' && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:sqlDbRefLabel')}</span>
              <input
                className="input-base input-xs"
                value={sqlDbRef}
                onChange={(e) => setSqlDbRef(e.target.value)}
                placeholder={t('cases:sqlDbRefPlaceholder')}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:sqlTextLabel')}</span>
              <textarea
                className="input-base input-xs font-mono"
                style={{ minHeight: 96 }}
                aria-invalid={!!fieldErrors['action.sql']}
                value={sqlText}
                onChange={(e) => setSqlText(e.target.value)}
                placeholder="SELECT id, status FROM orders WHERE user = {{user}}"
              />
            </label>
            <FieldError msg={fieldErrors['action.sql']} />
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:sqlReadOnlyHint')}</p>
            <div className="flex flex-col gap-1">
              <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:sqlParamsLabel')}</span>
              {sqlParams.map((p, i) => (
                <div key={i} className="flex gap-1 items-center">
                  <input
                    className="input-base input-xs flex-1"
                    value={p}
                    onChange={(e) => {
                      const next = [...sqlParams];
                      next[i] = e.target.value;
                      setSqlParams(next);
                    }}
                  />
                  <button
                    type="button"
                    className="text-[11px] press"
                    style={{ background: 'var(--popover)', border: '1px solid var(--border)', color: 'var(--destructive)', cursor: 'pointer', borderRadius: 4 }}
                    onClick={() => setSqlParams(sqlParams.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {sqlParams.length < 20 && (
                <button
                  type="button"
                  className="text-[11px] self-start press"
                  style={{ background: 'var(--popover)', border: '1px dashed var(--border)', color: 'var(--primary)', cursor: 'pointer', borderRadius: 4, padding: '4px 8px' }}
                  onClick={() => setSqlParams([...sqlParams, ''])}
                >
                  {t('cases:addParam')}
                </button>
              )}
            </div>
            <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              <span>{t('cases:sqlLimitLabel')}</span>
              <input className="input-base input-xs" type="number" min={1} max={200} value={sqlLimit} onChange={(e) => setSqlLimit(e.target.value)} />
            </label>
            <DbAssertionEditor value={sqlAssertion} onChange={setSqlAssertion} />
          </div>
        )}

        {/* compiled action chain (read-only): when the AI produces a chain of DSL in one shot (e.g. login + operation + assertion merged into one step),
            the form above only mirrors compiled[0]; enumerating the whole chain here tells the user that saving won't drop the tail actions. */}
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

function HttpAssertionEditor({ value, onChange }: { value: { status: string; match: 'equals' | 'contains' | 'notContains' | 'regex'; expected: string; allowTransportFailure: boolean } | undefined; onChange: (v: typeof value) => void }) {
  const { t } = useTranslation();
  if (!value) {
    return (
      <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px dashed var(--border)', color: 'var(--muted-foreground)', cursor: 'pointer', padding: '4px 8px', borderRadius: 5 }} onClick={() => onChange({ status: '', match: 'contains', expected: '', allowTransportFailure: false })}>
        {t('cases:addAssertion')}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 p-2 rounded-[var(--radius-sm)]" style={{ border: '1px solid var(--border)', background: 'var(--muted)' }}>
      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:httpAssertMismatch')}</span>
      <div className="flex gap-1.5">
        <input className="input-base input-xs" style={{ width: 130 }} type="number" min={100} max={599} value={value.status ?? ''} placeholder={t('cases:statusCodePlaceholder')} onChange={(e) => onChange({ ...value, status: e.target.value })} />
        <select className="input-base input-xs" style={{ width: 84 }} value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as 'equals' | 'contains' | 'notContains' | 'regex' })}>
          <option value="equals">{t('cases:equalsOp')}</option>
          <option value="contains">{t('cases:matchContains')}</option>
          <option value="notContains">{t('cases:matchNotContains')}</option>
          <option value="regex">{t('cases:regexLabel')}</option>
        </select>
        <input className="input-base input-xs flex-1" value={value.expected} placeholder={t('cases:bodyExpectPlaceholder')} onChange={(e) => onChange({ ...value, expected: e.target.value })} />
      </div>
      <label className="flex items-start gap-1.5 text-[11px] cursor-pointer" style={{ color: 'var(--muted-foreground)' }}>
        <input
          type="checkbox"
          className="mt-0.5"
          style={{ accentColor: 'var(--primary)' }}
          checked={value.allowTransportFailure}
          onChange={(e) => onChange({ ...value, allowTransportFailure: e.target.checked })}
        />
        <span>{t('cases:httpAssertAllowTransportFailure')}</span>
      </label>
      <button type="button" className="text-[11px] self-start press" style={{ background: 'var(--popover)', border: '1px solid var(--destructive)', color: 'var(--destructive)', cursor: 'pointer', borderRadius: 4, padding: '2px 8px' }} onClick={() => onChange(undefined)}>{t('cases:removeAssertion')}</button>
    </div>
  );
}
