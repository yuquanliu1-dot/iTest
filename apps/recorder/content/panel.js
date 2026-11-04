/**
 * 页面内录制控制面板：录制启动时由 background 注入到录制标签页，
 * 默认固定在右下角的玻璃卡片，可通过标题栏拖动到任意位置（限制在视口内）。
 * 样式对齐 iTest 设计 tokens（packages/ui/src/tokens.css，CRM shadcn 风）：按钮圆角 5px、
 * 主操作绿色填充（#006b4f）、次操作 ghost、危险 destructive、间距 token 化。
 * Shadow DOM 隔离，避免与宿主页面样式互相污染。
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
  // all:initial 防止宿主页面的全局样式（font/line-height 等）渗入
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
      /* 主操作：绿色填充（与中台按钮一致） */
      .btn.primary { background: #006b4f; color: #fff; border: 1px solid #006b4f; font-weight: 500; }
      .btn.primary:hover { background: #025e46; border-color: #025e46; }
      /* 次操作：ghost — 透明底 + 浅灰边 */
      .btn.ghost { background: transparent; border: 1px solid #e2e2e2; color: #171717; }
      .btn.ghost:hover { background: #f4f4f4; border-color: #d0d0d0; }
      /* 危险：透明 + 红边 */
      .btn.danger { background: transparent; border: 1px solid #ae2e24; color: #ae2e24; }
      .btn.danger:hover { background: rgba(174, 46, 36, 0.08); }

      .panel.collapsed { width: auto; }
      .panel.collapsed .body { display: none; }
      .panel.collapsed .head { padding: 7px 10px; }
      .panel.collapsed .count { margin-right: 2px; }
      /* 两个录制选项并排一行（英文标签过长时 wrap 兜底换行，不裁切） */
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
      /* 断言/悬停内联拾取的状态行（v0.0.6：不再开扩展弹窗，结果直接显示在本面板） */
      .pick-status {
        display: none; font-size: 11px; line-height: 1.5; border-radius: 5px;
        padding: 6px 8px; word-break: break-all;
      }
      .pick-status.info { display: block; background: #f4f4f4; color: #171717; }
      .pick-status.ok { display: block; background: rgba(0, 107, 79, 0.10); color: #006b4f; }
      .pick-status.err { display: block; background: rgba(174, 46, 36, 0.08); color: #ae2e24; }
      /* 存变量/AI 内联表单：拾取完成后或 AI 指令直接在本面板填写（弹窗路径已整体退役） */
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
    // 成功/失败提示 6s 后自动收起；拾取提示不自动收（由回调覆盖或超时前完成）
    if (kind !== 'info') statusTimer = setTimeout(hideStatus, 6000);
    fitViewport();
  };

  // 断言/悬停/存变量/AI 全部在面板内完成：扩展弹窗在用户点选被测页面后失焦被盖
  // （v0.0.4 置顶、v0.0.5 alwaysOnTop 两轮均失效），本面板是页面的一部分，盖不住。
  const emitInline = (dsl) => {
    chrome.runtime.sendMessage({ type: 'emit-step', dsl }, (resp) => {
      if (resp?.ok) showStatus(t('stepGenerated'), 'ok');
      else showStatus(t('failStatus', [resp?.error ?? t('unknownError')]), 'err');
    });
  };

  // ---- 内联表单（存变量/AI 共用）：填值后确定提交 ----
  const suggestVarName = (r) => {
    const raw = r.id || r.nameAttr || '';
    if (!raw) return '';
    return raw.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
  };
  let formMode = null; // 'variable' | 'ai'：内联表单当前服务哪种步骤
  let pendingPick = null; // variable 模式暂存的拾取结果
  const closeForm = () => {
    formMode = null;
    pendingPick = null;
    pickForm.classList.remove('open');
  };
  const openForm = (mode, hint, value) => {
    formMode = mode;
    hideStatus();
    formHint.textContent = hint;
    formInput.value = value;
    formOk.textContent = t('submit');
    pickForm.classList.add('open');
    formInput.focus();
    fitViewport();
  };
  const openVarForm = (r) => { pendingPick = r; openForm('variable', t('elementText', [r.text.slice(0, 60) || r.inputValue.slice(0, 60) || t('emptyText')]), suggestVarName(r)); };
  const openAiForm = () => openForm('ai', t('aiHint'), '');
  const submitForm = () => {
    const value = formInput.value.trim();
    if (formMode === 'variable') {
      if (!value) { showStatus(t('enterVarName'), 'err'); return; }
      const r = pendingPick;
      closeForm();
      if (r) emitInline({ kind: 'extract', locator: r.locators, varName: value });
    } else if (formMode === 'ai') {
      if (!value) { showStatus(t('enterInstruction'), 'err'); return; }
      closeForm();
      emitInline({ kind: 'aiTask', instruction: value });
    }
  };
  formOk.addEventListener('click', submitForm);
  formCancel.addEventListener('click', () => { closeForm(); hideStatus(); });
  formInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitForm(); });

  const startInlinePick = (mode) => {
    closeForm();
    showStatus(t('pickHint'));
    chrome.runtime.sendMessage({ type: 'pick' }, (r) => {
      if (!r || r.ok === false) {
        showStatus(t('pickFailed', [r?.error ?? t('notRecording')]), 'err');
        return;
      }
      if (r.canceled) {
        showStatus(t('canceled'));
        return;
      }
      if (mode === 'hover') {
        emitInline({ kind: 'hover', locator: r.locators });
        return;
      }
      if (mode === 'variable') {
        openVarForm(r);
        return;
      }
      // assert：选中即生成（期望值=元素当前文本/输入值，皆空退化 assertVisible），与原弹窗逻辑一致
      const expected = r.text || r.inputValue;
      emitInline(expected ? { kind: 'assertText', locator: r.locators, equals: expected } : { kind: 'assertVisible', locator: r.locators });
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

  // 选项变更 → 透传到 content/recorder.js 的 manager。用 set-options 消息实时生效。
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

  // 标题栏拖拽：首次拖动把 bottom/right 锚点换算成 top/left，之后跟随鼠标并钳制在视口内
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

  // 内容增高（拾取状态行/内联表单出现）后把面板钳回视口：拖动过锚点变 top/left，
  // 向下生长会探出视口底把「回中台」裁掉；默认 bottom 锚定虽向上生长，但视口过矮时
  // 顶边也可能越界，这里一并按实际尺寸收回。
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
  // 停止后顺手切回发起录制的用例详情页（步骤写入完成后自动跳转，免去用户手动找标签）
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stop', from: 'panel' });
    chrome.runtime.sendMessage({ type: 'open-console' });
  });
  backBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-console' }));
  featBtns.forEach((btn) => {
    const mode = btn.dataset.mode;
    btn.addEventListener('click', () => {
      // 断言/悬停/存变量/AI 全部内联在本面板完成（AI 直接开表单，无拾取环节），不再开任何扩展弹窗
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
    }
  });

  (document.body || document.documentElement).appendChild(host);
  render();
})();
