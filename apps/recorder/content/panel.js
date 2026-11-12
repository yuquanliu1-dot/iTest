/**
 * In-page recording control panel: injected by background into the recording tab when recording starts;
 * by default pinned as a glass card at the bottom-right, draggable via the title bar to any position
 * (clamped to the viewport).
 * Styling aligns with iTest design tokens (packages/ui/src/tokens.css, CRM shadcn style): button radius 5px,
 * primary action green fill (#006b4f), secondary ghost, danger destructive, spacing tokenized.
 * Shadow DOM isolation to avoid style pollution between host page and panel.
 */
(() => {
  const t = (k, s) => chrome.i18n.getMessage(k, s);
  const HOST_ID = 'itest-recorder-panel-host';
  let paused = false;
  let count = 0;
  let collapsed = false;

  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  // all:initial keeps the host page's global styles (font/line-height etc.) from bleeding in
  host.style.cssText = 'all:initial;position:fixed;bottom:16px;right:16px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        font-family: "Geist Variable", "Geist", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        width: 240px;
        background: rgba(255, 255, 255, 0.82);
        -webkit-backdrop-filter: blur(14px);
        backdrop-filter: blur(14px);
        border: 1px solid rgba(255, 255, 255, 0.9);
        border-radius: 8px;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06), 0 8px 30px rgba(0, 0, 0, 0.10);
        color: #171717;
        overflow: hidden;
        user-select: none;
        transition: width 0.15s ease;
      }
      .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 9px; cursor: grab; }
      .panel.dragging .head { cursor: grabbing; }
      .dot {
        width: 8px; height: 8px; border-radius: 9999px; background: #F04438;
        box-shadow: 0 0 0 0 rgba(240, 68, 56, 0.45);
        animation: itest-pulse 1.2s ease-in-out infinite; flex-shrink: 0;
      }
      .dot.paused { background: #F79009; animation: none; box-shadow: none; }
      @keyframes itest-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(240, 68, 56, 0.45); }
        50% { box-shadow: 0 0 0 4px rgba(240, 68, 56, 0); }
      }
      .title { font-size: 12px; font-weight: 600; flex: 1; white-space: nowrap; }
      .count {
        font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 9999px;
        background: rgba(0, 107, 79, 0.10); color: #006b4f; white-space: nowrap;
      }
      .toggle {
        border: none; background: transparent; color: #9d9d9d; cursor: pointer;
        font-size: 13px; line-height: 1; padding: 0 2px;
      }
      .toggle:hover { color: #171717; }

      .body { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 6px; }
      .row { display: flex; gap: 6px; }
      .row .btn { flex: 1; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }

      .btn {
        padding: 6px 10px; font-size: 12px; border-radius: 5px; cursor: pointer;
        font-family: inherit; line-height: 1.4; text-align: center;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      }
      /* Primary action: green fill (consistent with platform buttons) */
      .btn.primary { background: #006b4f; color: #fff; border: 1px solid #006b4f; font-weight: 500; }
      .btn.primary:hover { background: #025e46; border-color: #025e46; }
      /* Secondary action: ghost — transparent background + light gray border */
      .btn.ghost { background: transparent; border: 1px solid #e2e2e2; color: #171717; }
      .btn.ghost:hover { background: #f4f4f4; border-color: #d0d0d0; }
      /* Danger: transparent + red border */
      .btn.danger { background: transparent; border: 1px solid #ae2e24; color: #ae2e24; }
      .btn.danger:hover { background: rgba(174, 46, 36, 0.08); }

      .panel.collapsed { width: auto; }
      .panel.collapsed .body { display: none; }
      .panel.collapsed .head { padding: 7px 10px; }
      .panel.collapsed .count { margin-right: 2px; }
      /* Two recording options side by side on one row (wraps as fallback when English labels get too long, no clipping) */
      .opts { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; padding: 2px 0; }
      .opts label {
        font-size: 11px; color: #6b6b6b; display: flex; align-items: center; gap: 6px;
        cursor: pointer; user-select: none;
      }
      .opts input[type=number] {
        width: 48px; padding: 2px 4px; font-size: 11px; font-family: inherit;
        border: 1px solid #e2e2e2; border-radius: 4px; background: #fff; color: #171717;
      }
      .opts input[type=number]:focus { outline: none; border-color: #006b4f; }
      .opts input[type=checkbox] { accent-color: #006b4f; cursor: pointer; }
      /* Status line for assertion/hover inline picking (v0.0.6: no longer opens the extension popup; results show directly in this panel) */
      .pick-status {
        display: none; font-size: 11px; line-height: 1.5; border-radius: 5px;
        padding: 6px 8px; word-break: break-all;
      }
      .pick-status.info { display: block; background: #f4f4f4; color: #171717; }
      .pick-status.ok { display: block; background: rgba(0, 107, 79, 0.10); color: #006b4f; }
      .pick-status.err { display: block; background: rgba(174, 46, 36, 0.08); color: #ae2e24; }
      /* Save-variable/AI inline form: fill directly in this panel after picking or via AI instruction (the popup path has been fully retired) */
      .pick-form { display: none; flex-direction: column; gap: 4px; }
      .pick-form.open { display: flex; }
      .form-hint { font-size: 11px; color: #6b6b6b; line-height: 1.5; word-break: break-all; }
      .form-row { display: flex; gap: 6px; }
      .form-input {
        flex: 1; min-width: 0; font-size: 12px; font-family: inherit;
        padding: 4px 8px; border: 1px solid #e2e2e2; border-radius: 5px;
        background: #fff; color: #171717;
      }
      .form-input:focus { outline: none; border-color: #006b4f; }
      .form-cancel { flex: 0 0 auto; padding: 6px 8px; }
      /* Assertion form: two dropdowns for target + match mode (shown only in assert mode) */
      .assert-row { display: none; gap: 6px; }
      .pick-form.mode-assert .assert-row { display: flex; }
      .form-select {
        flex: 1; min-width: 0; font-size: 12px; font-family: inherit;
        padding: 4px 4px; border: 1px solid #e2e2e2; border-radius: 5px;
        background: #fff; color: #171717;
      }
      .form-select:focus { outline: none; border-color: #006b4f; }
    </style>
    <div class="panel">
      <div class="head">
        <span class="dot"></span>
        <span class="title">${t('panelTitle')}</span>
        <span class="count">${t('stepCount', ['0'])}</span>
        <button class="toggle" title="${t('collapsePanel')}">—</button>
      </div>
      <div class="body">
        <div class="row">
          <button class="btn ghost pause">${t('pause')}</button>
          <button class="btn danger stop">${t('stopRecording')}</button>
        </div>
        <div class="opts">
          <label title="${t('autoCaptureHint')}"><input type="checkbox" class="opt-hover" /> ${t('recordHoverSteps')}</label>
          <label>${t('fillMergeWindow')}<input type="number" class="opt-fill-ms" min="50" max="2000" step="50" value="250" /></label>
        </div>
        <div class="grid">
          <button class="btn ghost feat" data-mode="variable">${t('modeSavingVariable')}</button>
          <button class="btn ghost feat" data-mode="assert">${t('modeAddAssertion')}</button>
          <button class="btn ghost feat" data-mode="hover" title="${t('manualHoverHint')}">${t('insertHoverStep')}</button>
          <button class="btn ghost feat" data-mode="ai">${t('aiNaturalLang')}</button>
        </div>
        <div class="pick-status"></div>
        <div class="pick-form">
          <div class="form-hint"></div>
          <div class="assert-row">
            <select class="form-select assert-target" title="${t('assertTarget')}"></select>
            <select class="form-select assert-match" title="${t('assertExpected')}"></select>
          </div>
          <div class="form-row">
            <input class="form-input" />
            <button class="btn primary form-ok"></button>
            <button class="btn ghost form-cancel" title="×">×</button>
          </div>
        </div>
        <button class="btn primary back">${t('backToCase')}</button>
      </div>
    </div>
  `;

  const panel = shadow.querySelector('.panel');
  const head = shadow.querySelector('.head');
  const dot = shadow.querySelector('.dot');
  const title = shadow.querySelector('.title');
  const countEl = shadow.querySelector('.count');
  const toggleBtn = shadow.querySelector('.toggle');
  const pauseBtn = shadow.querySelector('.pause');
  const stopBtn = shadow.querySelector('.stop');
  const backBtn = shadow.querySelector('.back');
  const featBtns = shadow.querySelectorAll('.feat');
  const hoverChk = shadow.querySelector('.opt-hover');
  const fillMsInput = shadow.querySelector('.opt-fill-ms');
  const statusEl = shadow.querySelector('.pick-status');
  const pickForm = shadow.querySelector('.pick-form');
  const formHint = shadow.querySelector('.form-hint');
  const formInput = shadow.querySelector('.form-input');
  const formOk = shadow.querySelector('.form-ok');
  const formCancel = shadow.querySelector('.form-cancel');
  const targetSel = shadow.querySelector('.assert-target');
  const matchSel = shadow.querySelector('.assert-match');

  const fillSelect = (sel, opts) => {
    for (const [v, label] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
  };
  fillSelect(targetSel, [
    ['specifiedElement', t('assertTargetElement')],
    ['page', t('assertTargetPage')],
    ['errorMessage', t('assertTargetError')],
    ['url', t('assertTargetUrl')],
  ]);
  fillSelect(matchSel, [
    ['equals', t('assertMatchEquals')],
    ['contains', t('assertMatchContains')],
    ['notContains', t('assertMatchNotContains')],
    ['regex', t('assertMatchRegex')],
  ]);

  let statusTimer = null;
  const hideStatus = () => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
    statusEl.className = 'pick-status';
    statusEl.textContent = '';
  };
  const showStatus = (text, kind = 'info') => {
    statusEl.textContent = text;
    statusEl.className = `pick-status ${kind}`;
    if (statusTimer) clearTimeout(statusTimer);
    // Success/failure notices auto-hide after 6s; pick hints don't auto-hide (overridden by callback or resolved before timeout)
    if (kind !== 'info') statusTimer = setTimeout(hideStatus, 6000);
    fitViewport();
  };

  // Assertion/hover/save-variable/AI all complete inside the panel: the extension popup loses focus and gets covered
  // when the user clicks the page under test (v0.0.4 always-on-top and v0.0.5 alwaysOnTop both failed); this panel is
  // part of the page and cannot be covered.
  // The dsl carries the frameChain bg attached to the pick result (iframe frame chain, 0.1.0); emit-step goes straight to bg.
  const emitInline = (dsl) => {
    chrome.runtime.sendMessage({ type: 'emit-step', dsl, url: location.href }, (resp) => {
      if (resp?.ok) showStatus(t('stepGenerated'), 'ok');
      else showStatus(t('failStatus', [resp?.error ?? t('unknownError')]), 'err');
    });
  };

  // ---- Inline forms (shared by save-variable/AI): submit after filling the value ----
  const suggestVarName = (r) => {
    const raw = r.id || r.nameAttr || '';
    if (!raw) return '';
    return raw.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
  };
  let formMode = null; // 'variable' | 'ai' | 'assert': which step kind the inline form currently serves
  let pendingPick = null; // pick result staged by variable/assert modes
  const closeForm = () => {
    formMode = null;
    pendingPick = null;
    pickForm.classList.remove('open');
    pickForm.classList.remove('mode-assert');
  };
  const openForm = (mode, hint, value) => {
    formMode = mode;
    hideStatus();
    formHint.textContent = hint;
    formInput.value = value;
    formOk.textContent = t('submit');
    pickForm.classList.toggle('mode-assert', mode === 'assert');
    pickForm.classList.add('open');
    formInput.focus();
    fitViewport();
  };
  const openVarForm = (r) => { pendingPick = r; openForm('variable', t('elementText', [r.text.slice(0, 60) || r.inputValue.slice(0, 60) || t('emptyText')]), suggestVarName(r)); };
  const openAiForm = () => openForm('ai', t('aiHint'), '');
  // Expected-value suggestions for assertions: element target = the element's current text/input value; page URL = current address;
  // page text/error message = empty (user writes it). When switching targets, if the expected input still holds the previous
  // "as-suggested prefill" (user hasn't touched it), swap in the new target's suggestion.
  let pristine = '';
  const suggestExpected = (target, r) => {
    if (target === 'url') return location.href;
    if (target === 'specifiedElement' && r) return r.text || r.inputValue || '';
    return '';
  };
  targetSel.addEventListener('change', () => {
    const v = suggestExpected(targetSel.value, pendingPick);
    if (formInput.value === pristine) formInput.value = v;
    pristine = v;
  });
  const openAssertForm = (r) => {
    pendingPick = r;
    targetSel.value = 'specifiedElement';
    matchSel.value = 'equals';
    pristine = suggestExpected('specifiedElement', r);
    openForm('assert', t('assertHint'), pristine);
  };
  const submitForm = () => {
    const value = formInput.value.trim();
    if (formMode === 'variable') {
      if (!value) { showStatus(t('enterVarName'), 'err'); return; }
      const r = pendingPick;
      closeForm();
      if (r) emitInline({ kind: 'extract', locator: r.locators, varName: value, ...chainField(r) });
    } else if (formMode === 'ai') {
      if (!value) { showStatus(t('enterInstruction'), 'err'); return; }
      closeForm();
      emitInline({ kind: 'aiTask', instruction: value });
    } else if (formMode === 'assert') {
      const target = targetSel.value;
      const match = matchSel.value;
      if (match === 'regex') {
        try { new RegExp(value); } catch { showStatus(t('regexInvalid'), 'err'); return; }
      }
      if (!value) {
        // Empty expected + element target + equals → degenerate to assertVisible (element on page = pass); other combos with empty values are blocked
        if (target === 'specifiedElement' && match === 'equals') {
          const r = pendingPick;
          closeForm();
          if (r) emitInline({ kind: 'assertVisible', locator: assertLocators(r), ...chainField(r) });
          return;
        }
        showStatus(t('assertValueNeeded'), 'err');
        return;
      }
      const r = pendingPick;
      closeForm();
      // locator only carried for the element target; page/errorMessage/url take values from the whole page at replay time — no candidates needed,
      // and no frame chain either (a page-level assertion semantically targets the top-level document)
      emitInline({
        kind: 'assertText',
        locator: target === 'specifiedElement' && r ? assertLocators(r) : [],
        target,
        match,
        equals: value,
        ...(target === 'specifiedElement' ? chainField(r) : {}),
      });
    }
  };
  formOk.addEventListener('click', submitForm);
  formCancel.addEventListener('click', () => { closeForm(); hideStatus(); });
  formInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitForm(); });

  // Assertion candidate ordering (asset-management asset-edit RCA: the assertion's sole candidate .has-gutter .el-table_1_column_4 > .cell
  // drifted across sessions to count=0, while the page text "主识别IP" was clearly there): css chains containing Element-UI runtime
  // positional classes (el-table_{instance}[_column_{col}] / has-gutter, same convention as modules/selector-filter.ts),
  // or chains not unique on the current page (headers of multi-sortable tables can't distinguish sibling columns once runtime classes
  // are stripped) — such chains can't be the first candidate, so text goes first; if the chain is unique and stable, css-first keeps
  // uniqueness with text as a tail fallback (unused while the chain is alive, matched by text when the chain dies).
  const assertLocators = (r) => {
    const locs = Array.isArray(r?.locators) ? r.locators.slice() : [];
    if (r?.text && !locs.some((l) => l.strategy === 'text' && l.value === r.text)) {
      const textLoc = { strategy: 'text', value: r.text };
      const cssChainFragile =
        locs.some((l) => l.strategy === 'css' && /el-table_\d+(?:_column_\d+)?|has-gutter/.test(l.value)) ||
        !locs.some((l) => {
          if (l.strategy !== 'css') return false;
          try { return document.querySelectorAll(l.value).length === 1; } catch { return false; }
        });
      cssChainFragile ? locs.unshift(textLoc) : locs.push(textLoc);
    }
    return locs;
  };

  // ---- Element pick (event-driven, 0.1.0) ----
  // pick-start carries an auto-incrementing pickId to bg → bg broadcasts pick to all frames → the clicked frame replies pick-result →
  // bg races (first wins), attaches the frame chain, broadcasts pick-stop, and forwards the result back to this panel. pickActive guards
  // against re-entry (double-clicking feature buttons mid-pick would open two picks), with a 90s timeout fallback (bg silent / user never clicks).
  // Stale results (a new pick round started / already timed out) are dropped by pickId check, never landing in the new form.
  const chainField = (r) => (Array.isArray(r?.frameChain) && r.frameChain.length > 0 ? { frameChain: r.frameChain } : {});
  let pickSeq = 0;
  let pickActive = null; // { pickId, mode, timer }
  const finishPick = (result, pickId) => {
    if (!pickActive || pickActive.pickId !== pickId) return;
    clearTimeout(pickActive.timer);
    const mode = pickActive.mode;
    pickActive = null;
    if (!result || result.canceled) {
      showStatus(t('canceled'));
      return;
    }
    if (mode === 'hover') {
      emitInline({ kind: 'hover', locator: result.locators, ...chainField(result) });
      return;
    }
    if (mode === 'variable') {
      openVarForm(result);
      return;
    }
    if (mode === 'assert') {
      // After picking, enter the assertion form first: target/match/expected all editable; generated only on submit (since v0.0.9,
      // the old "select = generate" behavior could only record element-text equals, not contains/page/URL assertions)
      openAssertForm(result);
    }
  };
  const startInlinePick = (mode) => {
    if (pickActive) return;
    closeForm();
    showStatus(t('pickHint'));
    const pickId = ++pickSeq;
    pickActive = { pickId, mode, timer: null };
    chrome.runtime.sendMessage({ type: 'pick-start', pickId }, (r) => {
      if (!pickActive || pickActive.pickId !== pickId) return; // already resolved by timeout: ignore the late error
      if (!r || r.ok === false) {
        pickActive = null;
        showStatus(t('pickFailed', [r?.error ?? t('notRecording')]), 'err');
        return;
      }
      pickActive.timer = setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'pick-cancel' });
        finishPick({ canceled: true }, pickId);
      }, 90000);
    });
  };

  const render = () => {
    panel.classList.toggle('collapsed', collapsed);
    dot.classList.toggle('paused', paused);
    title.textContent = paused ? t('panelPaused') : t('panelTitle');
    countEl.textContent = t('stepCount', [String(count)]);
    pauseBtn.textContent = paused ? t('resume') : t('pause');
    toggleBtn.textContent = collapsed ? '◼' : '—';
    toggleBtn.title = collapsed ? t('expandPanel') : t('collapsePanel');
  };

  // Option changes → pass through to content/recorder.js's manager. Sent via the set-options message for immediate effect.
  const sendOptions = () => {
    const fillMs = parseInt(fillMsInput.value, 10);
    chrome.runtime.sendMessage({
      type: 'set-options',
      options: {
        recordHover: hoverChk.checked,
        fillFlushMs: isNaN(fillMs) ? 250 : Math.max(50, Math.min(2000, fillMs)),
      },
    });
  };
  hoverChk.addEventListener('change', sendOptions);
  fillMsInput.addEventListener('change', sendOptions);

  toggleBtn.addEventListener('click', () => { collapsed = !collapsed; render(); });

  // Title-bar drag: the first drag converts the bottom/right anchor to top/left; afterwards follow the mouse, clamped to the viewport
  let dragging = false;
  let dragOffX = 0;
  let dragOffY = 0;
  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    dragOffX = e.clientX - rect.left;
    dragOffY = e.clientY - rect.top;
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    dragging = true;
    panel.classList.add('dragging');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.min(Math.max(e.clientX - dragOffX, 8), window.innerWidth - panel.offsetWidth - 8);
    const y = Math.min(Math.max(e.clientY - dragOffY, 8), window.innerHeight - panel.offsetHeight - 8);
    host.style.left = `${x}px`;
    host.style.top = `${y}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
  });

  // After content grows (pick status line / inline form appear), clamp the panel back into the viewport: once dragged, the anchor
  // becomes top/left, and growing downward pokes past the viewport bottom, clipping "back to console"; the default bottom anchoring
  // grows upward, but on very short viewports the top edge can also overflow — clamp by actual size here as well.
  const fitViewport = () => {
    const m = 8;
    const r = panel.getBoundingClientRect();
    if (r.bottom > window.innerHeight - m) {
      host.style.top = `${Math.max(m, Math.round(window.innerHeight - m - r.height))}px`;
      host.style.bottom = 'auto';
    }
    if (r.top < m) {
      host.style.top = `${m}px`;
      host.style.bottom = 'auto';
    }
    if (r.right > window.innerWidth - m) {
      host.style.left = `${Math.max(m, Math.round(window.innerWidth - m - r.width))}px`;
      host.style.right = 'auto';
    }
    if (r.left < m) {
      host.style.left = `${m}px`;
      host.style.right = 'auto';
    }
  };

  pauseBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: paused ? 'resume' : 'pause' }));
  // After stopping, conveniently switch back to the case detail page that started the recording (auto-jump once steps are written, sparing the user from finding the tab)
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stop', from: 'panel' });
    chrome.runtime.sendMessage({ type: 'open-console' });
  });
  backBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-console' }));
  featBtns.forEach((btn) => {
    const mode = btn.dataset.mode;
    btn.addEventListener('click', () => {
      // Assertion/hover/save-variable/AI all complete inline in this panel (AI opens the form directly, no pick step); no extension popup anymore
      if (mode === 'ai') { openAiForm(); return; }
      startInlinePick(mode);
    });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'step-count') {
      count = msg.count ?? count;
      render();
    } else if (msg?.type === 'pause') {
      paused = true;
      render();
    } else if (msg?.type === 'resume') {
      paused = false;
      render();
    } else if (msg?.type === 'stop') {
      host.remove();
    } else if (msg?.type === 'pick-result') {
      // Pick result forwarded after bg's race (frameChain already attached, if any); stale pickIds are dropped in finishPick
      finishPick(msg.result, msg.pickId);
    }
  });

  // After re-injection / SW revival, pull the session state once as a fallback: if onUpdated's step-count/pause pushes were lost to timing, level off here
  chrome.runtime.sendMessage({ type: 'get-state' }, (s) => {
    if (!s || !s.recording) return;
    count = s.stepCount ?? count;
    paused = !!s.paused;
    render();
  });

  (document.body || document.documentElement).appendChild(host);
  render();
})();
