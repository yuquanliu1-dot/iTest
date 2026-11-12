import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { localizeApiError } from '../i18n';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type VariableReport } from '../api/client';
import { useUIStore } from '../stores/ui';
import { useRecorderStore } from '../stores/recorder';
import { useStepClipboard, type StepClip } from '../stores/stepClipboard';
import Icon from '../components/Icon';
import CaseStatusMenu from '../components/CaseStatusMenu';
import PriorityBadge from '../components/ui/PriorityBadge';
import Button from '../components/ui/Button';
import IconButton from '../components/ui/IconButton';
import Input from '../components/ui/Input';
import Segmented from '../components/ui/Segmented';
import InlineEdit from '../components/ui/InlineEdit';
import Toggle from '../components/ui/Toggle';
import EmptyState from '../components/ui/EmptyState';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/Modal';
import StepEditDrawer from '../components/StepEditDrawer';
import DatasetRowPickerDialog from '../components/DatasetRowPickerDialog';
import { MobileRecorder } from '../features/mobile-recorder';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import SortableStepRow from '../components/step-form/SortableStepRow';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/shadcn/tooltip';
import TagChip from '../components/ui/Tag';
import LabelsManagerDialog from '../components/labels/LabelsManagerDialog';
import { stepKindLabel } from '../lib/format';
import { stepSummary, fullStepDescription, getKind as getStepKind } from '../lib/stepSummary';
import { creatorName } from '../lib/creatorName';


type Tab = 'description' | 'reports';

/** Step identity snapshot comparison: detects whether a concurrent mutation touched the row we are editing. */
function sameStep(a: StepClip, b: StepClip): boolean {
  return JSON.stringify(a.action) === JSON.stringify(b.action);
}

export default function CaseDetail() {
  const { id, projectId, versionId } = useParams<{ id: string; projectId: string; versionId?: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.showToast);
  const qc = useQueryClient();
  const recorder = useRecorderStore();
  const [tab, setTab] = useState<Tab>('description');
  const [targetUrl, setTargetUrl] = useState('');
  const sessionRef = useRef<string | null>(null);
  const [mode, setMode] = useState<'fresh' | 'append' | 'resume' | 'incognito'>('fresh');
  const [resumeTarget, setResumeTarget] = useState<{ stepId: string; order: number } | null>(null);
  const [confirmResume, setConfirmResume] = useState<{ stepId: string; order: number } | null>(null);
  /** Always show a confirm modal before deleting a step — an accidental delete requires re-recording or manual re-entry. */
  const [confirmDeleteStep, setConfirmDeleteStep] = useState<{ stepId: string; order: number; instruction: string } | null>(null);
  /** Bulk delete confirm (same anti-mistouch as single delete; goes through mutateSteps full replacement, undoable). */
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  /** Track 1: case-level expected outcome (natural language). After replay the vision LLM compares it against the final screenshot.
   *  Edit and save sync through caseDetail.expectedOutcome; a ref tracks the serverKey so a refetch never silently overwrites unsaved edits. */
  const [expectedOutcome, setExpectedOutcome] = useState('');
  const expectedOutcomeSyncRef = useRef<string | null>(null);
  /** Case description: textarea editing + explicit save; syncRef prevents refetch from overwriting unsaved edits (same pattern as expectedOutcome). */
  const [description, setDescription] = useState('');
  const descriptionSyncRef = useRef<string | null>(null);
  /** Requirement no.: committed on input blur/Enter (clearable → null); syncRef same as above. */
  const [requirementNo, setRequirementNo] = useState('');
  const requirementNoSyncRef = useRef<string | null>(null);
  const clipboard = useStepClipboard();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<StepClip | null>(null);
  const [editingIdx, setEditingIdx] = useState(-1);
  /** 2026-10-06: manually adding a step — with editingMode = 'create' StepEditDrawer shows a different title/buttons.
   *  Initial StepClip = { source:'manual', action:{kind:'click', locator:[{strategy:'css', value:''}]}, instruction:'', compiled:[] }
   *  — compiled=[] is the uncompiled signal, dispatcher throws compile-missing; uncompiled steps without instruction block execution (button greyed out + inline "uncompiled" badge), ones with instruction are executed live by AI. */
  const [editingMode, setEditingMode] = useState<'edit' | 'create'>('edit');
  const [varReport, setVarReport] = useState<VariableReport | null>(null);
  const [windowStrategy, setWindowStrategy] = useState<'maximize' | 'current' | 'custom'>('maximize');
  const [windowWidth, setWindowWidth] = useState<number | undefined>();
  const [windowHeight, setWindowHeight] = useState<number | undefined>();
  const [incognito, setIncognito] = useState(false);
  const [defaultEnvId, setDefaultEnvId] = useState<string | null>(null);
  const [datasetId, setDatasetId] = useState<string | null>(null);
  /** Dataset row selection: array of enabled row indexes. [] = all enabled rows (= same semantics as server-side test_cases.dataset_row_indexes). */
  const [datasetRowIndexes, setDatasetRowIndexes] = useState<number[]>([]);
  const [datasetRowPickerOpen, setDatasetRowPickerOpen] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  /** Web service selected in the init-nav-URL dialog (environment web object payload.name; empty → default service). */
  const [webRefDraft, setWebRefDraft] = useState('');
  const [urlSaving, setUrlSaving] = useState(false);
  /** 2026-10-07: mobile recording dialog switch (entry shown only when platform === 'mobile'). */
  const [mobileRecorderOpen, setMobileRecorderOpen] = useState(false);
  /** 2026-10-07: AI add-steps dialog input. The user writes a one-line supplemental intent, then we jump to the assistant carrying it as the initialMessage.
   *  No letting the assistant "guess"; aligned with row-level recompile — the AI has a concrete target before looking at snapshots. */
  const [genStepsDialogOpen, setGenStepsDialogOpen] = useState(false);
  const [genStepsIntent, setGenStepsIntent] = useState('');
  /** Row-level AI recompile: tracks the stepId currently being compiled to prevent duplicate clicks. */
  const editingIdxRef = useRef<number>(-1);
  const editingSnapshotRef = useRef<StepClip | null>(null);
  const historyRef = useRef<StepClip[][]>([]);

  /** StepClip.action is the client-side mirror of compiled[0] (the server-side action column was DROPped, no longer sent down).
   *  Non-empty compiled → action = compiled[0]; empty/missing → placeholder {}, DrawerForm falls back via buildAction. */
  const toClip = (s: { source: string; delayMs?: number | null; instruction?: string | null; compiled?: unknown[] | null }): StepClip => {
    const compiledFirst = Array.isArray(s.compiled) && s.compiled.length > 0 ? s.compiled[0] : null;
    return {
      action: compiledFirst ?? {},
      source: s.source,
      delayMs: s.delayMs ?? undefined,
      instruction: s.instruction ?? undefined,
      compiled: s.compiled ?? undefined,
    };
  };

  /** Row-level uncompiled check: aligned with the dispatcher — only a non-empty compiled array passes; null/undefined/[] all count as uncompiled. */
  const isUncompiledStep = (s: { compiled?: unknown[] | null }): boolean => {
    return !Array.isArray(s.compiled) || s.compiled.length === 0;
  };

  /** Jump to the AI assistant with an initialMessage that auto-starts a new thread injecting the first prompt.
   *  Invalidate the case query before jumping so data is fresh when returning to CaseDetail (changes completed in the assistant conversation land via StagePanel and reflect into ['case', id]). */
  const openAssistantWithMessage = (initialMessage: string) => {
    if (!caseDetail || !projectId || !versionId) return;
    void qc.invalidateQueries({ queryKey: ['case', id] });
    navigate(`/p/${projectId}/v/${versionId}/assistant`, { state: { initialMessage } });
  };

  /** Row-level "recompile via assistant": jumps to the AI assistant, first prompt states stepId/order/instruction and steers it through stage_case_op(update_step) */
  const askAssistantToRecompile = (stepId: string) => {
    if (!caseDetail) return;
    const target = caseDetail.steps.find((x) => x.id === stepId);
    if (!target) return;
    const instructionText = target.instruction?.trim() ?? '';
    if (!instructionText) {
      toast(t('cases:noInstructionForAiCompile'), 'error');
      return;
    }
    openAssistantWithMessage(
      `对用例「${caseDetail.title}」(caseId=${id}, versionId=${versionId}) 第 ${target.order} 步重编译。\n` +
        `instruction: ${JSON.stringify(instructionText)}\n` +
        `请先 manage_cases get 拿完整步骤与 resolvedUrl,再 inspect_page 抓真实页面元素,然后调用 stage_case_op(action=update_step) 给出新的 compiled 并附 diff。`,
    );
  };

  /** Row-level unsolidified check: same standard as the case list "solidify" column / bulk-solidify filter — only NULL compiled
   *  (pure natural-language instruction steps) counts as unsolidified; aiTask visual steps have non-empty compiled and the list counts them as solidified,
   *  so no double counting here, avoiding a mismatch where the list shows n/n all green while the detail banner still reports unsolidified steps. */
  const isUnsolidifiedStep = (s: { instruction?: string | null; compiled?: unknown[] | null }): boolean => {
    return s.compiled == null && typeof s.instruction === 'string' && s.instruction.trim().length > 0;
  };

  /** Jump to the AI assistant to solidify: unsolidified steps → solidify_case mechanized into compiled. The first prompt names the case and the unsolidified step list. */
  const askAssistantToSolidify = () => {
    if (!caseDetail) return;
    const visuals = caseDetail.steps
      .filter(isUnsolidifiedStep)
      .map((s) => `${s.order}. ${(s.instruction ?? '').trim().slice(0, 80)}`);
    if (visuals.length === 0) return;
    openAssistantWithMessage(
      `对用例「${caseDetail.title}」(caseId=${id}, versionId=${versionId}) 执行机械固化。\n` +
        `该用例有 ${visuals.length} 个未固化步骤（仅有自然语言指令,尚未固化为机械 compiled）,如下:\n${visuals.join('\n')}\n` +
        `请调用 solidify_case 真实执行一遍并收集动作,机械映射为 compiled 后暂存 update_step,再用 verify_case 验收（机械干跑通过）后引导我在暂存区勾选保存。`,
    );
  };

  const replaceSteps = useMutation({
    mutationFn: (steps: StepClip[]) =>
      api.cases.replaceSteps(
        id!,
        steps.map((s) => ({ ...s, delayMs: s.delayMs ?? undefined, instruction: s.instruction ?? undefined, compiled: s.compiled ?? undefined })),
      ),
    onSuccess: (r) => {
      setVarReport(r.variableReport ?? null);
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  /** Single entry point for all step changes: push an undo snapshot first, then full replacement. */
  const mutateSteps = (updater: (steps: StepClip[]) => StepClip[]) => {
    if (!caseDetail) return;
    const current = caseDetail.steps.map(toClip);
    historyRef.current.push(current);
    if (historyRef.current.length > 20) historyRef.current.shift();
    replaceSteps.mutate(updater(current));
  };

  /** Split: a multi-action row (a compiled chain AI produced in one shot) is split into N single-action rows, each independently editable.
   *  Row 1 keeps the original row-level instruction and delayMs; other rows get the action summary as instruction and an empty delayMs. */
  const splitStep = (idx: number) => {
    mutateSteps((cur) => {
      const clip = cur[idx];
      if (!clip || !Array.isArray(clip.compiled) || clip.compiled.length <= 1) return cur;
      const expanded: StepClip[] = clip.compiled.map((c, i) => ({
        ...clip,
        action: c,
        compiled: [c],
        instruction: i === 0 ? clip.instruction : stepSummary({ compiled: [c] }, t),
        delayMs: i === 0 ? clip.delayMs : undefined,
      }));
      const next = [...cur];
      next.splice(idx, 1, ...expanded);
      return next;
    });
  };

  const undo = () => {
    // While the drawer is open the step list may have changed concurrently (row indexes would misalign); close the drawer before undoing
    if (editing) {
      toast(t('cases:closeDrawerBeforeUndo'), 'info');
      return;
    }
    const snapshot = historyRef.current.pop();
    if (!snapshot) {
      toast(t('cases:nothingToUndo'), 'info');
      return;
    }
    replaceSteps.mutate(snapshot);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  const { data: caseDetail, isError, error } = useQuery({
    queryKey: ['case', id],
    queryFn: () => api.cases.get(id!),
    enabled: !!id,
  });

  // Recording target URL live-follows the "init nav URL" (case relative path + environment web service resolution).
  // After the user edits it manually it is no longer silently overwritten by caseDetail refetch; the "↺" on the right of the input restores the resolved value.
  const targetUrlDirtyRef = useRef(false);
  useEffect(() => {
    if (!caseDetail?.resolvedUrl) return;
    if (targetUrlDirtyRef.current) return;
    setTargetUrl(caseDetail.resolvedUrl);
  }, [caseDetail?.resolvedUrl]);

  // When execution settings have unsaved local edits, keep them from being silently overwritten by caseDetail refetch
  const runtimeSyncRef = useRef<string | null>(null);
  useEffect(() => {
    if (!caseDetail) return;
    const serverKey = JSON.stringify([
      (caseDetail.windowStrategy as 'maximize' | 'current' | 'custom') ?? 'maximize',
      caseDetail.windowWidth ?? undefined,
      caseDetail.windowHeight ?? undefined,
      !!caseDetail.incognito,
      caseDetail.defaultEnvId ?? null,
      caseDetail.datasetId ?? null,
      caseDetail.datasetRowIndexes ?? [],
    ]);
    const localKey = JSON.stringify([windowStrategy, windowWidth, windowHeight, incognito, defaultEnvId, datasetId, datasetRowIndexes]);
    if (runtimeSyncRef.current !== null && localKey !== runtimeSyncRef.current) return;
    runtimeSyncRef.current = serverKey;
    setWindowStrategy((caseDetail.windowStrategy as 'maximize' | 'current' | 'custom') ?? 'maximize');
    setWindowWidth(caseDetail.windowWidth ?? undefined);
    setWindowHeight(caseDetail.windowHeight ?? undefined);
    setIncognito(!!caseDetail.incognito);
    setDefaultEnvId(caseDetail.defaultEnvId ?? null);
    setDatasetId(caseDetail.datasetId ?? null);
    // Keep the reference stable so each sync does not produce a new array (prevents a re-render loop)
    const srvRows = caseDetail.datasetRowIndexes ?? [];
    setDatasetRowIndexes((prev) => (JSON.stringify(prev) === JSON.stringify(srvRows) ? prev : srvRows));
  }, [caseDetail, windowStrategy, windowWidth, windowHeight, incognito, defaultEnvId, datasetId, datasetRowIndexes]);

  // expectedOutcome server sync: same pattern as runtimeSyncRef (serverKey comparison, unsaved edits never overwritten)
  useEffect(() => {
    if (!caseDetail) return;
    const serverValue = caseDetail.expectedOutcome ?? '';
    if (expectedOutcomeSyncRef.current !== null && expectedOutcome !== expectedOutcomeSyncRef.current) return;
    expectedOutcomeSyncRef.current = serverValue;
    setExpectedOutcome(serverValue);
  }, [caseDetail, expectedOutcome]);

  // Case description server sync (same pattern as expectedOutcome)
  useEffect(() => {
    if (!caseDetail) return;
    const serverValue = caseDetail.description ?? '';
    if (descriptionSyncRef.current !== null && description !== descriptionSyncRef.current) return;
    descriptionSyncRef.current = serverValue;
    setDescription(serverValue);
  }, [caseDetail, description]);

  // Requirement no. server sync (same pattern as expectedOutcome)
  useEffect(() => {
    if (!caseDetail) return;
    const serverValue = caseDetail.requirementNo ?? '';
    if (requirementNoSyncRef.current !== null && requirementNo !== requirementNoSyncRef.current) return;
    requirementNoSyncRef.current = serverValue;
    setRequirementNo(serverValue);
  }, [caseDetail, requirementNo]);

  const { data: groups } = useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.projects.groups(projectId!),
    enabled: !!projectId,
  });
  const group = groups?.find((g) => g.id === caseDetail?.groupId);

  const { data: scenarios } = useQuery({
    queryKey: ['scenarios', caseDetail?.requirementId],
    queryFn: () => api.scenarios.listForRequirement(caseDetail!.requirementId!),
    enabled: !!caseDetail?.requirementId,
  });

  const { data: projectTags } = useQuery({
    queryKey: ['tags', projectId],
    queryFn: () => api.tags.list(projectId!),
    enabled: !!projectId,
  });

  const { data: environments } = useQuery({
    queryKey: ['environments', projectId],
    queryFn: () => api.environments.list(projectId!),
    enabled: !!projectId,
  });

  // Web service candidates for init nav = named web objects in the case's environment (case.defaultEnvId → project default).
  // Uses the local defaultEnvId state (not caseDetail.defaultEnvId): within the window where the env dropdown was changed but not saved,
  // the web service picked in the dialog stays consistent with the environment about to be persisted, avoiding orphan refs.
  // Leaving the dropdown unselected → uses that environment's default web service (handled by backend resolve).
  const caseEnvId = defaultEnvId ?? environments?.find((e) => e.isDefault)?.id ?? null;
  const webOptions = useMemo(() => {
    const env = environments?.find((e) => e.id === caseEnvId);
    if (!env) return [];
    const names: string[] = [];
    for (const o of env.objects) {
      if (o.objectType !== 'web') continue;
      const n = String((o.payload as Record<string, unknown>)?.name ?? '').trim();
      if (n && !names.includes(n)) names.push(n);
    }
    return names;
  }, [environments, caseEnvId]);

  const { data: datasetList } = useQuery({
    queryKey: ['datasets', projectId],
    queryFn: () => api.datasets.list(projectId!),
    enabled: !!projectId,
  });

  /** Dataset column names (the bound dataset) — merged with preceding extract variables for FillValueEditor. */
  const datasetVars = useMemo(() => {
    const ds = (datasetList ?? []).find((d) => d.id === datasetId);
    return ds ? ds.columns.map((c) => c.name) : [];
  }, [datasetList, datasetId]);

  /** Enabled row count of the bound dataset (for the "all rows" hint text). */
  const datasetEnabledRowCount = (datasetList ?? []).find((d) => d.id === datasetId)?.enabledRowCount ?? 0;

  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [labelsManagerOpen, setLabelsManagerOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [tagPickerAnchor, setTagPickerAnchor] = useState<{ top: number; left: number } | null>(null);
  const tagPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tagPickerOpen) return;
    setTagPickerAnchor(null);
    const trigger = tagPickerRef.current?.querySelector('[data-tag-trigger]') as HTMLElement | null;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setTagPickerAnchor({ top: rect.bottom + 4, left: Math.max(8, rect.right - 256) });
    }
    const onClick = (e: MouseEvent) => {
      if (tagPickerRef.current && !tagPickerRef.current.contains(e.target as Node)) setTagPickerOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [tagPickerOpen]);

  const caseTagIds = useMemo(() => (caseDetail?.tags ?? []).map((t) => t.id), [caseDetail?.tags]);
  const filteredTags = useMemo(() => {
    const list = projectTags ?? [];
    if (!tagSearch.trim()) return list;
    const q = tagSearch.trim().toLowerCase();
    return list.filter((t) => t.name.toLowerCase().includes(q));
  }, [projectTags, tagSearch]);

  const setTags = useMutation({
    mutationFn: (nextIds: string[]) => api.cases.patch(id!, { tagIds: nextIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['case', id] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // Inline case-name edit: changes the case itself (PATCH /cases/:id { title }), effective everywhere at once (case library/assistant/historical reports).
  const rename = useMutation({
    mutationFn: (title: string) => api.cases.patch(id!, { title }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['case', id] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
      qc.invalidateQueries({ queryKey: ['plan'] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      toast(t('cases:renamed'), 'success');
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const toggleTag = (tagId: string) => {
    const next = caseTagIds.includes(tagId)
      ? caseTagIds.filter((x) => x !== tagId)
      : [...caseTagIds, tagId];
    setTags.mutate(next);
  };

  const startRecording = useMutation({
    mutationFn: async () => {
      const opts: Parameters<typeof api.recorder.createSession>[1] = { mode };
      if (mode === 'resume' && resumeTarget) opts.resumeFromOrder = resumeTarget.order + 1;
      if (mode === 'incognito') opts.incognito = true;
      if (targetUrl) opts.targetUrl = targetUrl;
      const session = await api.recorder.createSession(id!, opts);
      recorder.setStatus('recording');
      recorder.setSession(session.sessionId);
      sessionRef.current = session.sessionId;
      if (!targetUrl && session.resolvedUrl) setTargetUrl(session.resolvedUrl);
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (v: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          resolve(v);
        };
        const onMsg = (e: MessageEvent) => {
          if (e.data?.source === 'ita-ext' && e.data?.type === 'start-result') finish(!!e.data.ok);
        };
        const timer = setTimeout(() => finish(false), 3000);
        window.addEventListener('message', onMsg);
        window.postMessage(
          {
            source: 'ita-web',
            type: 'start-recording',
            session: { wsUrl: session.wsUrl, sessionId: session.sessionId, token: session.wsToken, mode: opts.mode, ...(opts.incognito ? { incognito: true } : {}) },
            // Fall back to the server-resolved inherited URL when the field is empty; setTargetUrl is async, cannot rely on state captured in this closure
            targetUrl: targetUrl || session.resolvedUrl || '',
          },
          '*',
        );
      });
      if (!ok) {
        recorder.setError(t('cases:loadRecorderExtension'));
        sessionRef.current = null;
      }
    },
    onError: (e: Error) => {
      recorder.setError(e.message);
      toast(localizeApiError(e), 'error');
    },
  });

  const stopRecording = useMutation({
    mutationFn: async () => {
      const sessionId = recorder.sessionId;
      if (!sessionId) throw new Error('no active session');
      // First do the extension's flush handshake: wait for the background to send out all queued steps and the server to close the WS,
      // then call the finish HTTP — otherwise trailing steps may still be in flight over WS and finish would miss them.
      await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (v: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          resolve(v);
        };
        const onMsg = (e: MessageEvent) => {
          if (e.data?.source === 'ita-ext' && e.data?.type === 'stop-result') finish(!!e.data.ok);
        };
        const timer = setTimeout(() => finish(false), 5000);
        window.addEventListener('message', onMsg);
        window.postMessage({ source: 'ita-web', type: 'stop-recording', sessionId }, '*');
      });
      const r = await api.recorder.finish(sessionId);
      sessionRef.current = null;
      recorder.reset();
      setTargetUrl('');
      toast(t('cases:stepsWritten', { count: r.inserted }), 'success');
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
  });

  // When "stop recording" is clicked in the panel/dialog, the extension notifies this page to wrap up (same tail logic as stopRecording)
  useEffect(() => {
    const onStopped = (e: MessageEvent) => {
      if (e.data?.source !== 'ita-ext' || e.data?.type !== 'recording-stopped') return;
      const sessionId = recorder.sessionId;
      if (!sessionId) return;
      sessionRef.current = null;
      recorder.reset();
      api.recorder
        .finish(sessionId)
        .then((r) => {
          toast(t('cases:stepsWritten', { count: r.inserted }), 'success');
          qc.invalidateQueries({ queryKey: ['case', id] });
        })
        .catch((err: Error) => toast(localizeApiError(err), 'error'));
    };
    window.addEventListener('message', onStopped);
    return () => window.removeEventListener('message', onStopped);
  }, [recorder, id, qc, toast]);

  const genSteps = useMutation({
    mutationFn: async (intent: string) => {
      if (!caseDetail || !projectId || !versionId) throw new Error('case/project/version missing');
      const trimmed = intent.trim();
      // 2026-10-07: "AI add steps" now jumps to the AI assistant → stage_case_op(action=insert_step).
      // AI sees real page snapshots in the conversation and can pick the exact position and locator; the user confirms via StagePanel checkboxes.
      // The dialog lets the user write one line of "what to add", aligned with row-level recompile: the AI gets a concrete target before seeing snapshots.
      const intentLine = trimmed ? `补充意图:${trimmed}\n` : '补充意图:由 AI 自行判断用例缺什么步骤。\n';
      openAssistantWithMessage(
        `对用例「${caseDetail.title}」(caseId=${id}, versionId=${versionId}) 补充脚本步骤。\n` +
          `当前标题:${caseDetail.title}\n描述:${caseDetail.description ?? '（无）'}\n` +
          intentLine +
          `已有 ${caseDetail.steps.length} 步:\n` +
          caseDetail.steps
            .map((s, i) => `${i + 1}. ${(s.instruction ?? '').slice(0, 80)}`)
            .join('\n') +
          `\n请先 manage_cases get 拿完整 step 列表,再 inspect_page 抓真实元素,然后调用 stage_case_op(action=insert_step, afterOrder=末位 order) 给出新步骤的 compiled 与 instruction。`,
      );
      return Promise.resolve();
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const moveGroup = useMutation({
    mutationFn: (groupId: string) => api.cases.patch(id!, { groupId }),
    onSuccess: () => {
      toast(t('cases:groupMoved'), 'success');
      qc.invalidateQueries({ queryKey: ['case', id] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
      qc.invalidateQueries({ queryKey: ['groups', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const moveScenario = useMutation({
    mutationFn: (scenarioId: string | null) => api.cases.patch(id!, { scenarioId }),
    onSuccess: () => {
      toast(t('cases:scenarioSwitched'), 'success');
      qc.invalidateQueries({ queryKey: ['case', id] });
      qc.invalidateQueries({ queryKey: ['cases', projectId] });
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const execute = useMutation({
    mutationFn: () => api.cases.execute(id!),
    onSuccess: (r) => {
      // Execution is async: clicking Execute lands on the report page immediately (live view while running + report appears in place when done).
      // Multiple dataset rows → lands on the first report; the row switcher at the top of the report page flips rows.
      qc.invalidateQueries({ queryKey: ['reports'] });
      navigate(`/p/${projectId}/v/${versionId}/reports/${r.reportId}`);
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const deleteStep = useMutation({
    mutationFn: (stepId: string) => api.cases.deleteStep(id!, stepId),
    onSuccess: (_r, stepId) => {
      setConfirmDeleteStep(null);
      // Single delete after selection: without cleanup the deleted stepId stays in selected, inflating the copy-selected count and copying nothing
      setSelected((prev) => {
        if (!prev.has(stepId)) return prev;
        const next = new Set(prev);
        next.delete(stepId);
        return next;
      });
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
    onError: (e: Error) => {
      toast(localizeApiError(e), 'error');
      setConfirmDeleteStep(null);
    },
  });

  const moveStep = useMutation({
    mutationFn: ({ stepId, dir }: { stepId: string; dir: -1 | 1 }) => {
      if (!caseDetail) throw new Error('case not loaded');
      const ids = caseDetail.steps.map((s) => s.id);
      const i = ids.indexOf(stepId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) throw new Error('cannot move');
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      return api.cases.reorderSteps(id!, ids);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['case', id] }),
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // Undo snapshots optimistically pushed by drag before server confirmation; on reorder failure they are removed by reference to avoid polluting the undo stack
  const pendingDragSnapshotsRef = useRef<StepClip[][] | null>(null);

  const dragReorder = useMutation({
    mutationFn: (stepIds: string[]) => api.cases.reorderSteps(id!, stepIds),
    onSuccess: () => {
      pendingDragSnapshotsRef.current = null;
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
    onError: (e: Error) => {
      for (const snap of pendingDragSnapshotsRef.current ?? []) {
        const i = historyRef.current.indexOf(snap);
        if (i >= 0) historyRef.current.splice(i, 1);
      }
      pendingDragSnapshotsRef.current = null;
      toast(localizeApiError(e), 'error');
      qc.invalidateQueries({ queryKey: ['case', id] });
    },
  });

  const onDragEnd = (e: DragEndEvent) => {
    if (!caseDetail) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = caseDetail.steps.findIndex((s) => s.id === active.id);
    const newIdx = caseDetail.steps.findIndex((s) => s.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    // Drag goes through reorder (keeps step ids); undo snapshot is pushed manually, undo restores via replaceSteps
    const snapshot = caseDetail.steps.map(toClip);
    historyRef.current.push(snapshot);
    if (historyRef.current.length > 20) historyRef.current.shift();
    pendingDragSnapshotsRef.current = [...(pendingDragSnapshotsRef.current ?? []), snapshot];
    dragReorder.mutate(arrayMove(caseDetail.steps.map((s) => s.id), oldIdx, newIdx));
  };

  const saveRuntime = useMutation({
    mutationFn: () =>
      api.cases.patch(id!, {
        windowStrategy,
        windowWidth,
        windowHeight,
        incognito,
        defaultEnvId,
        datasetId,
        // Dataset row selection: always sent ([] sent too — the server distinguishes undefined=no change / []=all rows)
        datasetRowIndexes,
        // Track 1: saved together with run settings; empty string counts as clearing (send null)
        expectedOutcome: expectedOutcome.trim() ? expectedOutcome : null,
      }),
    onSuccess: () => {
      expectedOutcomeSyncRef.current = expectedOutcome.trim() ? expectedOutcome : '';
      qc.invalidateQueries({ queryKey: ['case', id] });
      toast(t('cases:saved'), 'success');
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // Case description: explicit save; empty = clear (send null)
  const saveDescription = useMutation({
    mutationFn: () => api.cases.patch(id!, { description: description.trim() ? description : null }),
    onSuccess: () => {
      descriptionSyncRef.current = description.trim() ? description : '';
      qc.invalidateQueries({ queryKey: ['case', id] });
      toast(t('cases:saved'), 'success');
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });

  // Requirement no.: committed on blur/Enter; empty = clear (send null). Not folded into saveRuntime like description/expectedOutcome —
  // the input sits in the right rail, and standalone immediate submission better fits the "fill and move on" usage.
  const saveRequirementNo = useMutation({
    mutationFn: (value: string | null) => api.cases.patch(id!, { requirementNo: value }),
    onSuccess: (_r, value) => {
      requirementNoSyncRef.current = value ?? '';
      qc.invalidateQueries({ queryKey: ['case', id] });
      toast(t('cases:saved'), 'success');
    },
    onError: (e: Error) => toast(localizeApiError(e), 'error'),
  });
  const commitRequirementNo = () => {
    const server = requirementNoSyncRef.current ?? '';
    const next = requirementNo.trim() ? requirementNo : '';
    if (next === server || saveRequirementNo.isPending) return;
    saveRequirementNo.mutate(requirementNo.trim() ? requirementNo : null);
  };

  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        window.postMessage({ source: 'ita-web', type: 'stop-recording', sessionId: sessionRef.current }, '*');
        sessionRef.current = null;
      }
    };
  }, []);

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
        {t('common:loadFailed')}：{error?.message ?? t('common:unknownError')}
      </div>
    );
  }

  if (!caseDetail) {
    return (
      <div className="flex flex-1 items-center justify-center" style={{ color: 'var(--muted-foreground)' }}>
        <Icon name="loader" size={16} className="animate-spin" />
        <span style={{ marginLeft: 8 }}>{t('cases:loading')}</span>
      </div>
    );
  }

  const extractVars = caseDetail.steps
    .map((s) => {
      const head = Array.isArray(s.compiled) && s.compiled.length > 0
        ? (s.compiled[0] as { kind?: string; varName?: string })
        : undefined;
      return head?.kind === 'extract' ? head.varName : undefined;
    })
    .filter((v): v is string => !!v);

  /** Count of unsolidified (no mechanical compiled: pure AI visual execution / natural-language-only instruction) steps, for the top banner. */
  const unsolidifiedStepCount = caseDetail.steps.filter(isUnsolidifiedStep).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-6 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(`/p/${projectId}/v/${versionId}/groups/${caseDetail.groupId ?? ''}`)}
        >
          <Icon name="chevronLeft" size={12} />
          {group?.name ?? t('cases:caseList')}
        </Button>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        {/* Case name inline-editable: click the title to edit, goes through PATCH /cases/:id { title } */}
        <InlineEdit
          value={caseDetail.title}
          disabled={rename.isPending}
          ariaLabel={t('cases:caseName')}
          onSave={(next) => rename.mutateAsync(next)}
          className="text-[16px] font-semibold max-w-[420px]"
          inputClassName="text-[16px] font-semibold max-w-[420px]"
          style={{ color: 'var(--foreground)' }}
        />
        <PriorityBadge priority={caseDetail.priority} />
        <CaseStatusMenu caseId={caseDetail.id} status={caseDetail.status} projectId={projectId} />
        <div className="flex-1" />
        <Button
          variant="ghost"
          onClick={() =>
            navigate(`/p/${projectId}/v/${versionId}/reports?caseId=${caseDetail.id}&tab=case`)
          }
          title={t('cases:viewAllReports')}
        >
          <Icon name="reportView" size={12} />
          {t('cases:viewReport')}
        </Button>
        {(() => {
          // Uncompiled steps come in two states: with a natural-language instruction = visual-mode step, AI executes it live per instruction during replay (solidify optional);
          // no compiled and no instruction = recording artifact never compiled, AI has nothing to execute → still blocking (dispatcher throws compile-missing).
          const unexecutable = caseDetail.steps.filter((s) => isUncompiledStep(s) && !s.instruction?.trim());
          const blocked = unexecutable.length > 0;
          return (
            <Button
              variant="ghost"
              onClick={() => {
                if (caseDetail.status === 'deprecated' && !window.confirm(t('cases:deprecatedExecuteConfirm'))) return;
                execute.mutate();
              }}
              disabled={execute.isPending || caseDetail.steps.length === 0 || blocked}
              title={blocked ? t('cases:uncompiledBlocking', { count: unexecutable.length }) : undefined}
            >
              <Icon name="play" size={12} />
              {t('cases:execute')}
            </Button>
          );
        })()}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 px-6 py-3 shrink-0">
        <Segmented
          options={[
            { value: 'description', label: t('cases:tabDescription'), icon: 'list' },
            { value: 'reports', label: t('cases:tabReports'), icon: 'flag' },
          ]}
          value={tab}
          onChange={(v) => setTab(v)}
        />
      </div>

      {/* Body — main area + right action sidebar */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex gap-5 px-6 pb-6">
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            {tab === 'description' && (
              <div className="flex flex-col gap-4">
                <div className="bg-card border rounded-[var(--radius-md)] p-5 flex flex-col gap-4">
                  <div className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>{t('cases:executionSettings')}</div>
                  <div className="flex flex-col gap-2">
                    <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:windowStrategy')}</span>
                    <Segmented
                      value={windowStrategy}
                      onChange={setWindowStrategy}
                      options={[
                        { label: t('cases:windowMaximize'), value: 'maximize' },
                        { label: t('cases:windowCurrent'), value: 'current' },
                        { label: t('cases:windowCustom'), value: 'custom' },
                      ]}
                    />
                  </div>
                  {windowStrategy === 'custom' && (
                    <div className="flex gap-3">
                      <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                        {t('cases:width')}
                        <Input
                          type="number"
                          value={windowWidth ?? ''}
                          onChange={(e) => setWindowWidth(e.target.value === '' ? undefined : Number(e.target.value))}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                        {t('cases:height')}
                        <Input
                          type="number"
                          value={windowHeight ?? ''}
                          onChange={(e) => setWindowHeight(e.target.value === '' ? undefined : Number(e.target.value))}
                        />
                      </label>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <Toggle checked={incognito} onChange={setIncognito} label={t('cases:incognitoMode')} />
                    <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                      {t('cases:incognitoHint')}
                    </span>
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:defaultEnv')}</span>
                    <select
                      className="input-base input-sm"
                      value={defaultEnvId ?? ''}
                      onChange={(e) => setDefaultEnvId(e.target.value || null)}
                      disabled={(environments ?? []).length === 0}
                    >
                      <option value="">{t('cases:noEnvOverride')}</option>
                      {(environments ?? []).map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/* Dataset and row range on one line: dataset dropdown on the left (label on top), once bound a "choose rows" entry + count on the same row to the right (bottom-aligned with the dropdown).
                      The runtime-replacement hint's full text is folded into hover, no longer its own grey line. */}
                  <div className="flex flex-wrap items-end gap-2">
                    <label
                      className="flex flex-col gap-1"
                      title={datasetId ? t('cases:datasetRunHint', { col: '{{列名}}' }) : undefined}
                    >
                      <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:testDataset')}</span>
                      <select
                        className="input-base input-sm"
                        value={datasetId ?? ''}
                        onChange={(e) => {
                          const next = e.target.value || null;
                          // Dataset switched → clear row selection (the index space belongs to the old dataset)
                          if (next !== datasetId) setDatasetRowIndexes([]);
                          setDatasetId(next);
                        }}
                      >
                        <option value="">{t('cases:noDataset')}</option>
                        {(datasetList ?? []).map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}{t('cases:datasetEnabledRows', { count: d.enabledRowCount })}
                          </option>
                        ))}
                      </select>
                    </label>
                    {datasetId && (
                      <div className="flex items-center gap-2 pb-0.5">
                        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                          {t('cases:datasetRowScope')}
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => setDatasetRowPickerOpen(true)}>
                          {t('cases:datasetRowChoose')}
                        </Button>
                        <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                          {datasetRowIndexes.length === 0
                            ? t('cases:datasetRowScopeAllHint', { count: datasetEnabledRowCount })
                            : t('cases:datasetRowSelected', { indexes: datasetRowIndexes.map((i) => i + 1).join('、') })}
                        </span>
                      </div>
                    )}
                  </div>
                  {/* Track 1: case-level expected outcome. After replay the vision LLM compares it against the final screenshot;
                      step-level assertions were tightened at the replay layer to only take effect as "specified element visible"; whole-page fuzzy assertions are always skipped. */}
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] flex items-center gap-1" style={{ color: 'var(--muted-foreground)' }}>
                      {t('cases:expectedOutcome')}
                      <Icon name="info" size={10} style={{ opacity: 0.5 }} />
                    </span>
                    <textarea
                      className="input-base"
                      style={{ minHeight: 64, resize: 'vertical', fontSize: 12 }}
                      placeholder={t('cases:expectedOutcomePlaceholder')}
                      value={expectedOutcome}
                      onChange={(e) => setExpectedOutcome(e.target.value)}
                    />
                    <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                      {t('cases:expectedOutcomeHint')}
                      {datasetId && t('cases:expectedOutcomeVarPrefix')}
                      {datasetId && <code className="font-mono">{'{{列名}}'}</code>}
                      {datasetId && t('cases:expectedOutcomeVarSuffix')}
                    </span>
                  </label>
                  <div className="flex justify-end">
                    <Button onClick={() => saveRuntime.mutate()} disabled={saveRuntime.isPending}>{t('common:save')}</Button>
                  </div>
                </div>
                <div className="bg-card border rounded-[var(--radius-md)] p-5">
                <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                  {t('cases:description')}
                </div>
                <textarea
                  className="input-base mb-3"
                  style={{ minHeight: 72, resize: 'vertical', fontSize: 13, lineHeight: 1.7 }}
                  placeholder={t('cases:descriptionPlaceholder')}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <div className="flex justify-end mb-3">
                  <Button
                    size="sm"
                    onClick={() => saveDescription.mutate()}
                    disabled={saveDescription.isPending || description === (descriptionSyncRef.current ?? '')}
                  >
                    {t('common:save')}
                  </Button>
                </div>
                {caseDetail.createdBy && (
                  <div className="text-[11px] mb-2" style={{ color: 'var(--muted-foreground)' }}>
                    {t('cases:createdBy')} {creatorName(caseDetail.createdBy)}
                  </div>
                )}
                <div
                  className="rounded-[var(--radius-sm)] px-3 py-2 mb-4 flex items-center gap-2 text-[11px]"
                  style={{
                    border: '1px solid var(--border)',
                    color: 'var(--muted-foreground)',
                    background: 'var(--muted)',
                  }}
                >
                  <Icon name="link" size={11} style={{ opacity: 0.6 }} />
                  <span className="font-medium shrink-0" style={{ color: 'var(--muted-foreground)' }}>{t('cases:initNavUrl')}</span>
                  <span className="min-w-0 flex-1 truncate font-mono" title={caseDetail.url ?? undefined}>
                    {caseDetail.url
                      ? (caseDetail.url.startsWith('/') ? t('cases:urlRelative', { url: caseDetail.url }) : caseDetail.url)
                      : t('cases:urlNotConfigured')}
                  </span>
                  {caseDetail.resolvedUrl && (
                    <span className="max-w-[40%] truncate font-mono text-[10px]" style={{ color: 'var(--muted-foreground)', opacity: 0.8 }} title={caseDetail.resolvedUrl}>
                      {t('cases:resolvedAs', { url: caseDetail.resolvedUrl })}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setUrlDraft(caseDetail.url ?? '');
                      setWebRefDraft(caseDetail.webServiceRef ?? '');
                      setUrlDialogOpen(true);
                    }}
                  >
                    {t('cases:edit')}
                  </Button>
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="text-[11px] font-medium uppercase tracking-[0.03em]" style={{ color: 'var(--muted-foreground)' }}>
                    {t('cases:steps', { count: caseDetail.steps.length })}
                  </div>
                  <div className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={recorder.status === 'recording'}
                    onClick={() => {
                      editingIdxRef.current = -1;
                      setEditingIdx(-1);
                      editingSnapshotRef.current = null;
                      setEditing({
                        action: { kind: 'click', locator: [{ strategy: 'css', value: '' }] },
                        source: 'manual',
                        instruction: '',
                        compiled: [],
                      });
                      setEditingMode('create');
                    }}
                    title={t('cases:addStepTitle')}
                  >
                    <Icon name="plus" size={12} />
                    {t('cases:addStep')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const clips = caseDetail.steps.filter((s) => selected.has(s.id)).map(toClip);
                      if (clips.length === 0) {
                        toast(t('cases:selectStepsToCopy'), 'info');
                        return;
                      }
                      clipboard.setSteps(clips);
                      toast(t('cases:stepsCopied', { count: clips.length }), 'success');
                    }}
                    disabled={selected.size === 0}
                  >
                    {t('cases:copySelected', { count: selected.size })}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDeleteSelected(true)}
                    disabled={selected.size === 0 || recorder.status === 'recording'}
                    style={{ color: 'var(--destructive)' }}
                  >
                    <Icon name="trash" size={12} />
                    {t('cases:deleteSelected', { count: selected.size })}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      mutateSteps((cur) => {
                        const selIdx = cur
                          .map((_, i) => (selected.has(caseDetail.steps[i]!.id) ? i : -1))
                          .filter((i) => i >= 0);
                        const at = selIdx.length > 0 ? selIdx[selIdx.length - 1]! : cur.length - 1;
                        const next = [...cur];
                        next.splice(at + 1, 0, ...clipboard.steps.map((c) => ({ ...c })));
                        return next;
                      })
                    }
                    disabled={clipboard.steps.length === 0}
                    title={selected.size > 0 ? t('cases:pasteAfterSelected') : t('cases:pasteAppend')}
                  >
                    {t('cases:pasteCount', { count: clipboard.steps.length })}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={undo}
                    disabled={historyRef.current.length === 0}
                  >
                    {t('cases:undo')}
                  </Button>
                </div>
                {varReport &&
                  (varReport.undefined.length > 0 ||
                    varReport.forwardRefs.length > 0 ||
                    varReport.duplicates.length > 0 ||
                    varReport.invalidNames.length > 0) && (
                  <div
                    className="rounded-[var(--radius-sm)] px-3 py-2 mb-3 text-[11px]"
                    style={{ border: '1px solid var(--warning-soft-border)', color: 'var(--warning)', background: 'var(--warning-soft)' }}
                  >
                    <div className="font-semibold mb-1">{t('cases:varCheckTitle')}</div>
                    <ul className="list-disc pl-4 flex flex-col gap-0.5">
                      {varReport.undefined.map((i, k) => (
                        <li key={`u${k}`}>
                          {t('cases:varUndefined', { order: i.stepOrder + 1, name: `{{${i.name}}}`, field: i.field })}
                        </li>
                      ))}
                      {varReport.forwardRefs.map((i, k) => (
                        <li key={`f${k}`}>
                          {t('cases:varForwardRef', { order: i.stepOrder + 1, name: `{{${i.name}}}` })}
                        </li>
                      ))}
                      {varReport.duplicates.map((i, k) => (
                        <li key={`d${k}`}>
                          {t('cases:varDuplicate', { name: i.name, orders: i.definedAt.map((n) => n + 1).join('、') })}
                        </li>
                      ))}
                      {varReport.invalidNames.map((i, k) => (
                        <li key={`n${k}`}>
                          {t('cases:varInvalidName', { order: i.stepOrder + 1, name: i.name, reason: i.reason })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {unsolidifiedStepCount > 0 && (
                  <div
                    className="rounded-[var(--radius-sm)] px-3 py-2 mb-3 flex items-center gap-2 text-[11px]"
                    style={{ border: '1px solid var(--warning-soft-border)', color: 'var(--warning)', background: 'var(--warning-soft)' }}
                  >
                    <Icon name="sparkles" size={11} />
                    <span className="flex-1">
                      {t('cases:unsolidifiedStepsBanner', { count: unsolidifiedStepCount })}
                    </span>
                    <Button variant="ghost" size="sm" onClick={askAssistantToSolidify} title={t('cases:solidifyTooltip')}>
                      {t('cases:solidifyAction')}
                    </Button>
                  </div>
                )}
                {caseDetail.steps.length === 0 ? (
                  <EmptyState
                    icon="listChecks"
                    title={t('cases:noStepsYet')}
                    description={t('cases:noStepsHint')}
                  />
                ) : (
                  <DndContext
                    sensors={recorder.status === 'recording' ? [] : sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={onDragEnd}
                  >
                    <SortableContext items={caseDetail.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                      <ol className="flex flex-col gap-2">
                        {caseDetail.steps.map((s, idx) => (
                          <SortableStepRow key={s.id} id={s.id} disabled={recorder.status === 'recording'} isEditing={idx === editingIdx}>
                            <input
                              type="checkbox"
                              checked={selected.has(s.id)}
                              onChange={(e) => {
                                const next = new Set(selected);
                                if (e.target.checked) next.add(s.id);
                                else next.delete(s.id);
                                setSelected(next);
                              }}
                              style={{ accentColor: 'var(--primary)' }}
                            />
                            <span className="text-[10px] uppercase font-semibold tracking-wide shrink-0" style={{ color: 'var(--primary)' }}>
                              {s.source}
                            </span>
                            <span className="text-[11px] font-mono shrink-0 w-5" style={{ color: 'var(--muted-foreground)' }}>
                              {idx + 1}
                            </span>
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className="flex min-w-0 flex-1 items-baseline gap-1 cursor-default text-left"
                                    style={{ color: 'var(--foreground)', fontSize: 12 }}
                                  >
                                    <span className="shrink-0 font-semibold" style={{ color: 'var(--primary)', fontSize: 10 }}>
                                      {t(stepKindLabel(getStepKind(s)))}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate">
                                      {s.instruction?.trim() || stepSummary(s, t)}
                                    </span>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent
                                  side="bottom"
                                  align="start"
                                  sideOffset={6}
                                  className="block w-fit max-w-[420px] whitespace-pre-wrap break-words text-left font-mono leading-relaxed"
                                >
                                  {fullStepDescription(s, t)}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            {Array.isArray(s.compiled) && s.compiled.length > 1 && (
                              <span
                                className="text-[10px] px-2 py-0.5 rounded-full shrink-0 font-mono"
                                style={{ border: '1px solid var(--border)', color: 'var(--muted-foreground)', background: 'var(--popover)' }}
                                title={t('cases:compiledActionsTooltip', { count: s.compiled.length })}
                              >
                                ⚙ {t('cases:actionsCount', { count: s.compiled.length })}
                              </span>
                            )}
                            {(() => {
                              const head = Array.isArray(s.compiled) && s.compiled.length > 0
                                ? (s.compiled[0] as { kind?: string; varName?: string })
                                : undefined;
                              return head?.kind === 'extract' ? (
                                <span
                                  className="text-[10px] px-2 py-0.5 rounded-full shrink-0 font-mono"
                                  style={{ border: '1px solid var(--primary)', color: 'var(--primary)', background: 'var(--popover)' }}
                                  title={t('cases:extractVarTooltip', { col: '{{引用}}' })}
                                >
                                  → {`{{${head.varName ?? ''}}}`}
                                </span>
                              ) : null;
                            })()}
                            {isUncompiledStep(s) && (
                              <button
                                onClick={() => askAssistantToRecompile(s.id)}
                                className="text-[10px] px-2 py-0.5 rounded-full shrink-0 press"
                                style={{ border: '1px solid var(--warning-soft-border)', color: 'var(--warning)', background: 'var(--warning-soft)' }}
                                title={t('cases:uncompiledTooltip')}
                              >
                                {t('cases:uncompiledBadge')}
                              </button>
                            )}
                            {isUnsolidifiedStep(s) && (
                              <button
                                onClick={askAssistantToSolidify}
                                className="text-[10px] px-2 py-0.5 rounded-full shrink-0 press"
                                style={{ border: '1px solid var(--primary)', color: 'var(--primary)', background: 'var(--popover)' }}
                                title={t('cases:unsolidifiedTooltip')}
                              >
                                {t('cases:unsolidifiedBadge')}
                              </button>
                            )}
                            <div className="flex items-center gap-1 shrink-0">
                              {Array.isArray(s.compiled) && s.compiled.length > 1 && (
                                <IconButton
                                  icon="split"
                                  title={t('cases:splitTooltip', { count: s.compiled.length })}
                                  disabled={recorder.status === 'recording'}
                                  onClick={() => splitStep(idx)}
                                />
                              )}
                              <IconButton
                                icon="copy"
                                title={t('cases:copyStepTooltip')}
                                disabled={recorder.status === 'recording'}
                                onClick={() => {
                                  mutateSteps((cur) => {
                                    const next = [...cur];
                                    next.splice(idx + 1, 0, { ...toClip(s) });
                                    return next;
                                  });
                                }}
                              />
                              <IconButton
                                icon="chevronUp"
                                title={t('cases:moveUp')}
                                disabled={idx === 0 || moveStep.isPending}
                                onClick={() => moveStep.mutate({ stepId: s.id, dir: -1 })}
                              />
                              <IconButton
                                icon="chevronDown"
                                title={t('cases:moveDown')}
                                disabled={idx === caseDetail.steps.length - 1 || moveStep.isPending}
                                onClick={() => moveStep.mutate({ stepId: s.id, dir: 1 })}
                              />
                              <IconButton
                                icon="chevronRight"
                                title={t('cases:recordFromHere')}
                                disabled={recorder.status === 'recording'}
                                onClick={() => {
                                  setConfirmResume({ stepId: s.id, order: idx });
                                }}
                              />
                              <IconButton
                                icon="pencil"
                                title={t('cases:edit')}
                                onClick={() => {
                                  editingIdxRef.current = idx;
                                  setEditingIdx(idx);
                                  editingSnapshotRef.current = toClip(s);
                                  setEditing(toClip(s));
                                  setEditingMode('edit');
                                }}
                              />
                              <IconButton
                                icon="trash"
                                title={t('common:delete')}
                                tone="destructive"
                                disabled={deleteStep.isPending}
                                onClick={() => setConfirmDeleteStep({ stepId: s.id, order: s.order, instruction: s.instruction ?? t('cases:stepOrderN', { order: s.order }) })}
                              />
                            </div>
                          </SortableStepRow>
                        ))}
                      </ol>
                    </SortableContext>
                  </DndContext>
                )}
                {recorder.status === 'recording' && (
                  <p className="text-[12px] mt-3 flex items-center gap-2" style={{ color: 'var(--info)' }}>
                    <span className="status-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
                    {t('cases:recordingInProgress')}
                  </p>
                )}
                {recorder.status === 'error' && (
                  <p className="text-[12px] mt-3" style={{ color: 'var(--destructive)' }}>
                    ✕ {recorder.errorMessage}
                  </p>
                )}
                </div>
              </div>
            )}

            {tab === 'reports' && (
              <div className="bg-card border rounded-[var(--radius-md)] p-5">
                <EmptyState icon="flag" title={t('cases:goToReportsTitle')} description={t('cases:goToReportsDesc')} action={
                  <Button size="sm" onClick={() => navigate(`/p/${projectId}/v/${versionId}/reports?caseId=${caseDetail.id}&tab=case`)}>{t('cases:openReportsPage')}</Button>
                } />
              </div>
            )}
          </div>

          {/* Right rail — action panel */}
          <div className="w-[280px] shrink-0 flex flex-col gap-3">
            <div className="bg-card border rounded-[var(--radius-md)] p-4 relative" ref={tagPickerRef} style={{ overflow: 'visible', zIndex: tagPickerOpen ? 30 : 'auto' }}>
              <div
                data-tag-trigger
                className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2 flex items-center gap-1 cursor-pointer select-none"
                style={{ color: 'var(--muted-foreground)' }}
                onClick={() => setTagPickerOpen((v) => !v)}
              >
                {t('cases:tags')}
                <Icon name="chevronDown" size={10} style={{ opacity: 0.4 }} />
              </div>
              <div className="flex flex-wrap gap-1.5 min-h-[24px]">
                {(caseDetail.tags ?? []).length === 0 ? (
                  <span className="text-[12px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:none')}</span>
                ) : (
                  (caseDetail.tags ?? []).map((t) => (
                    <TagChip
                      key={t.id}
                      tag={t}
                      onRemove={() => toggleTag(t.id)}
                    />
                  ))
                )}
              </div>
              {tagPickerOpen && tagPickerAnchor && createPortal(
                <div
                  className="rounded-[var(--radius-sm)] overflow-hidden popover-in"
                  style={{
                    position: 'fixed',
                    top: tagPickerAnchor.top,
                    left: tagPickerAnchor.left,
                    width: 256,
                    zIndex: 9999,
                    border: '1px solid var(--border)',
                    background: 'var(--card)',
                    boxShadow: 'var(--shadow-2xl)',
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="px-2 py-1.5 border-b" style={{ borderColor: 'var(--border)' }}>
                    <input
                      type="text"
                      placeholder={t('cases:searchTags')}
                      value={tagSearch}
                      onChange={(e) => setTagSearch(e.target.value)}
                      className="input-base input-sm"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-56 overflow-y-auto py-1">
                    {filteredTags.length === 0 ? (
                      <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
                        {(projectTags ?? []).length === 0 ? t('cases:noTagsInProject') : t('cases:noTagMatches')}
                      </div>
                    ) : (
                      filteredTags.map((t) => (
                        <label
                          key={t.id}
                          className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[var(--muted)]"
                        >
                          <input
                            type="checkbox"
                            checked={caseTagIds.includes(t.id)}
                            onChange={() => toggleTag(t.id)}
                            className="w-3.5 h-3.5 rounded-[3px]"
                            style={{ accentColor: 'var(--primary)' }}
                          />
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: `#${t.color}` }} />
                          <span className="text-[12px] truncate" style={{ color: 'var(--foreground)' }}>{t.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    style={{ borderTop: '1px solid var(--border)' }}
                    onClick={() => { setTagPickerOpen(false); setLabelsManagerOpen(true); }}
                  >
                    {t('cases:manageTags')}
                  </Button>
                </div>,
                document.body
              )}
            </div>

            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2" style={{ color: 'var(--muted-foreground)' }}>
                {t('cases:belongsGroup')}
              </div>
              <select
                className="input-base input-sm"
                value={caseDetail.groupId ?? ''}
                disabled={moveGroup.isPending}
                onChange={(e) => moveGroup.mutate(e.target.value)}
              >
                {(groups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <p className="text-[11px] mt-2" style={{ color: 'var(--muted-foreground)' }}>
                {t('cases:urlResolveHint')}
              </p>
            </div>

            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-2" style={{ color: 'var(--muted-foreground)' }}>
                {t('cases:belongsScenario')}
              </div>
              <select
                className="input-base input-sm"
                value={caseDetail.scenarioId ?? ''}
                disabled={moveScenario.isPending || !caseDetail.requirementId}
                onChange={(e) => moveScenario.mutate(e.target.value || null)}
              >
                <option value="">{t('cases:noScenarioOption')}</option>
                {(scenarios ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
              <div className="flex flex-col gap-1 mt-3">
                <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{t('cases:requirementNo')}</span>
                <Input
                  value={requirementNo}
                  placeholder={t('cases:requirementNoPlaceholder')}
                  onChange={(e) => setRequirementNo(e.target.value)}
                  onBlur={commitRequirementNo}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </div>
              {!caseDetail.requirementId && (
                <p className="text-[11px] mt-2" style={{ color: 'var(--muted-foreground)' }}>
                  {t('cases:noRequirementHint')}
                </p>
              )}
            </div>

            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                {t('cases:aiAdd')}
              </div>
              <Button onClick={() => setGenStepsDialogOpen(true)} className="w-full">
                <Icon name="bolt" size={12} />
                {t('cases:aiAddSteps')}
              </Button>
            </div>

            {caseDetail.platform === 'mobile' && (
              <div className="bg-card border rounded-[var(--radius-md)] p-4">
                <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                  {t('cases:mobileRecording')}
                </div>
                <Button
                  onClick={() => setMobileRecorderOpen(true)}
                  disabled={mobileRecorderOpen}
                  className="w-full"
                >
                  <Icon name="tablet" size={12} />
                  {t('cases:recordMobile')}
                </Button>
                <p className="text-[11px] mt-2" style={{ color: 'var(--muted-foreground)' }}>
                  {t('cases:mobileRecordingHint')}
                </p>
              </div>
            )}

            <div className="bg-card border rounded-[var(--radius-md)] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.03em] mb-3" style={{ color: 'var(--muted-foreground)' }}>
                {t('cases:browserRecording')}
              </div>
              <select
                className="input-base input-sm mb-2"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                disabled={recorder.status === 'recording'}
              >
                <option value="fresh">{t('cases:recordingFresh')}</option>
                <option value="append">{t('cases:recordingAppend')}</option>
                <option value="resume">{t('cases:recordingResume')}</option>
                <option value="incognito">{t('cases:recordingIncognito')}</option>
              </select>
              {mode === 'resume' && (
                <p className="text-[11px] mb-2" style={{ color: 'var(--info)' }}>
                  {t('cases:resumeModeHint')}
                </p>
              )}
              <div className="flex items-end gap-2 mb-3">
                <Input
                  label={t('cases:recordingTargetUrl')}
                  placeholder="https://example.com"
                  value={targetUrl}
                  onChange={(e) => {
                    targetUrlDirtyRef.current = true;
                    setTargetUrl(e.target.value);
                  }}
                  size="sm"
                  className="flex-1"
                />
                <IconButton
                  icon="refresh"
                  title={t('cases:useInitUrl')}
                  disabled={!caseDetail?.resolvedUrl || targetUrl === caseDetail.resolvedUrl}
                  onClick={() => {
                    targetUrlDirtyRef.current = false;
                    setTargetUrl(caseDetail?.resolvedUrl ?? '');
                  }}
                />
              </div>
              {recorder.status === 'recording' ? (
                <Button variant="ghost" onClick={() => stopRecording.mutate()} className="w-full">
                  <Icon name="pause" size={12} />
                  {t('cases:stopRecording')}
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    if (mode === 'resume' && !resumeTarget) {
                      toast(t('cases:selectStartStepFirst'), 'info');
                      return;
                    }
                    startRecording.mutate();
                  }}
                  className="w-full"
                >
                  <Icon name="play" size={12} />
                  {t('cases:recordMore')}
                </Button>
              )}
              <p className="text-[11px] mt-2" style={{ color: 'var(--muted-foreground)' }}>
                {t('cases:recorderExtHint')}
              </p>
            </div>
          </div>
        </div>
      </div>
      {editing && (
        <StepEditDrawer
          mode={editingMode}
          initial={editing}
          availableVars={Array.from(new Set([...datasetVars, ...extractVars]))}
          datasetVars={datasetVars}
          caseId={id}
          platform={caseDetail.platform ?? 'web'}
          onClose={() => { setEditing(null); setEditingIdx(-1); editingSnapshotRef.current = null; setEditingMode('edit'); }}
          onSave={(next) => {
            let applied = false;
            if (editingMode === 'create') {
              // Create: append to the end, reusing the replaceSteps entry (full replacement is simplest and satisfies undo).
              mutateSteps((cur) => {
                applied = true;
                // On save action must match compiled[0]: a stale action placeholder conflicts with the new convention, the server no longer writes the action column.
                // For single-element compiled (non-aiTask etc.) sync it directly; for multi-element/empty keep next.action and let buildAction fall back.
                const head = Array.isArray(next.compiled) && next.compiled.length > 0 ? next.compiled[0] : null;
                return [...cur, head ? { ...next, action: head } : next];
              });
            } else {
              mutateSteps((cur) => {
                const i = editingIdxRef.current;
                const prev = editingSnapshotRef.current;
                const curAt = cur[i];
                if (!curAt || !prev || !sameStep(curAt, prev)) return cur;
                applied = true;
                const newCur = [...cur];
                newCur[i] = next;
                return newCur;
              });
            }
            if (!applied) toast(t('cases:stepModifiedReload'), 'error');
            setEditing(null);
            setEditingIdx(-1);
            editingSnapshotRef.current = null;
            setEditingMode('edit');
          }}
        />
      )}

      {projectId && (
        <LabelsManagerDialog
          open={labelsManagerOpen}
          projectId={projectId}
          onClose={() => setLabelsManagerOpen(false)}
        />
      )}

      {/* Edit init nav URL */}
      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>{t('cases:initNavUrl')}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3 px-5 py-4">
            <Input
              label={t('cases:relativeUrlLabel')}
              placeholder={t('cases:relativeUrlPlaceholder')}
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              autoFocus
            />
            <div className="flex flex-col gap-1">
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-foreground)' }}>{t('cases:webService')}</label>
              <select
                className="input-base"
                value={webRefDraft}
                onChange={(e) => setWebRefDraft(e.target.value)}
                disabled={webOptions.length === 0 && !webRefDraft}
              >
                <option value="">{t('cases:defaultWebService')}</option>
                {webOptions.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </div>
            <p className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
              {t('cases:urlHelp')}
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUrlDialogOpen(false)}>{t('common:cancel')}</Button>
            <Button
              disabled={urlSaving}
              onClick={() => {
                setUrlSaving(true);
                api.cases
                  .patch(id!, {
                    url: urlDraft.trim() ? urlDraft.trim() : null,
                    webServiceRef: webRefDraft || null,
                  })
                  .then(() => {
                    qc.invalidateQueries({ queryKey: ['case', id] });
                    toast(t('cases:saved'), 'success');
                    setUrlDialogOpen(false);
                  })
                  .catch((e: Error) => toast(localizeApiError(e), 'error'))
                  .finally(() => setUrlSaving(false));
              }}
            >
              {urlSaving ? t('cases:saving') : t('common:save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pre-recording confirm: whether to replay preceding steps first */}
      <Dialog open={!!confirmResume} onOpenChange={(o) => !o && setConfirmResume(null)}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>{t('cases:replayPrecedingTitle')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('cases:replayPrecedingHint')}
            {t('cases:noPreviewHint')}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                if (!confirmResume) return;
                setResumeTarget(confirmResume);
                setMode('resume');
                setConfirmResume(null);
                toast(t('cases:resumeNoPreview'), 'info');
              }}
            >
              {t('cases:noPreview')}
            </Button>
            <Button
              onClick={() => {
                if (!confirmResume) return;
                setResumeTarget(confirmResume);
                setMode('resume');
                setConfirmResume(null);
                toast(t('cases:resumeReplayPreview'), 'info');
              }}
            >
              {t('cases:replayFirst')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete step confirm: accidental deletes need re-recording or manual re-entry; the frontend always confirms before sending the request */}
      <Dialog open={!!confirmDeleteStep} onOpenChange={(o) => !o && setConfirmDeleteStep(null)}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>{t('cases:deleteStep')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('cases:deleteStepConfirm', { order: confirmDeleteStep?.order, instruction: confirmDeleteStep?.instruction })}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDeleteStep(null)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
              disabled={deleteStep.isPending}
              onClick={() => confirmDeleteStep && deleteStep.mutate(confirmDeleteStep.stepId)}
            >
              {deleteStep.isPending ? t('cases:deleting') : t('cases:confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirm: goes through mutateSteps full replacement (auto-pushed to the undo stack, recoverable via "Undo") */}
      <Dialog open={confirmDeleteSelected} onOpenChange={setConfirmDeleteSelected}>
        <DialogContent style={{ maxWidth: 420 }}>
          <DialogHeader><DialogTitle>{t('cases:deleteSelectedTitle')}</DialogTitle></DialogHeader>
          <div className="px-5 py-4 text-[13px]" style={{ color: 'var(--muted-foreground)' }}>
            {t('cases:deleteSelectedConfirm', { count: selected.size })}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDeleteSelected(false)}>{t('common:cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!caseDetail || selected.size === 0) return;
                mutateSteps((cur) => cur.filter((_, i) => !selected.has(caseDetail.steps[i]!.id)));
                setSelected(new Set());
                setConfirmDeleteSelected(false);
              }}
            >
              {t('cases:confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={genStepsDialogOpen} onOpenChange={setGenStepsDialogOpen}>
        <DialogContent style={{ maxWidth: 480 }}>
          <DialogHeader><DialogTitle>{t('cases:aiAddSteps')}</DialogTitle></DialogHeader>
          <p className="text-[12px] mb-2" style={{ color: 'var(--muted-foreground)' }}>
            {t('cases:aiAddStepsHint')}
          </p>
          <textarea
            className="input-base input-sm w-full"
            rows={4}
            placeholder={t('cases:aiAddStepsPlaceholder')}
            value={genStepsIntent}
            onChange={(e) => setGenStepsIntent(e.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setGenStepsDialogOpen(false)}>{t('common:cancel')}</Button>
            <Button
              size="sm"
              onClick={() => {
                const intent = genStepsIntent;
                setGenStepsDialogOpen(false);
                setGenStepsIntent('');
                genSteps.mutate(intent);
              }}
            >
              <Icon name="bolt" size={12} />
              {t('cases:letAiAdd')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dataset row picker dialog: only checked rows run at execution time. */}
      <DatasetRowPickerDialog
        open={datasetRowPickerOpen}
        onOpenChange={setDatasetRowPickerOpen}
        projectId={projectId}
        datasetId={datasetId}
        value={datasetRowIndexes}
        onConfirm={(indexes) => setDatasetRowIndexes(indexes)}
      />

      {/* Mobile recording dialog: enabled only when platform === 'mobile' (button in the right sidebar above). onClose refreshes the case to pull back new steps. */}
      {mobileRecorderOpen && projectId && (
        <Dialog open={mobileRecorderOpen} onOpenChange={(o) => !o && setMobileRecorderOpen(false)}>
          <DialogContent style={{ maxWidth: 960, height: '70vh', padding: 0 }}>
            <DialogHeader className="px-5 pt-4 pb-2">
              <DialogTitle>{t('cases:mobileRecording')}</DialogTitle>
            </DialogHeader>
            <div className="flex-1 min-h-0" style={{ height: 'calc(70vh - 56px)' }}>
              <MobileRecorder
                caseId={id!}
                projectId={projectId}
                defaultTargetId={caseDetail.mobileDeviceTargetId ?? undefined}
                onClose={() => {
                  setMobileRecorderOpen(false);
                  qc.invalidateQueries({ queryKey: ['case', id] });
                }}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}