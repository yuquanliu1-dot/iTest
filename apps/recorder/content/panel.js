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
      /* 断言表单：对象 + 匹配方式两个下拉（仅 assert 模式显示） */
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
    // 成功/失败提示 6s 后自动收起；拾取提示不自动收（由回调覆盖或超时前完成）
    if (kind !== 'info') statusTimer = setTimeout(hideStatus, 6000);
    fitViewport();
  };

  // 断言/悬停/存变量/AI 全部在面板内完成：扩展弹窗在用户点选被测页面后失焦被盖
  // （v0.0.4 置顶、v0.0.5 alwaysOnTop 两轮均失效），本面板是页面的一部分，盖不住。
  // dsl 带上 bg 附在拾取结果里的 frameChain（iframe 帧链，0.1.0）；emit-step 直发 bg。
  const emitInline = (dsl) => {
    chrome.runtime.sendMessage({ type: 'emit-step', dsl, url: location.href }, (resp) => {
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
  let formMode = null; // 'variable' | 'ai' | 'assert'：内联表单当前服务哪种步骤
  let pendingPick = null; // variable/assert 模式暂存的拾取结果
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
  // 断言期望值建议：元素对象=元素当前文本/输入值；页面 URL=当前地址；页面文本/错误提示=空（用户自己写）。
  // 切换对象时若期望值输入框仍是上一次的「原样预填」（用户没动过），跟着换成新对象的建议值。
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
        // 空期望 + 元素对象 + 等于 → 退化 assertVisible（元素在页面上=通过）；其余组合空值拦截
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
      // locator 只在元素对象时携带；page/errorMessage/url 由回放端从页面整体取值，不需要候选，
      // 也不带帧链（页级断言的语义就是顶层文档）
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

  // 断言候选排序（资产管理-资产编辑 RCA：断言唯一候选 .has-gutter .el-table_1_column_4 > .cell 跨会话
  // 漂移 count=0，而页面文本「主识别IP」明明在）：css 链含 Element-UI 运行时位置类
  // （el-table_{实例号}[_column_{列序}] / has-gutter，口径同 modules/selector-filter.ts），
  // 或链在当前页面就不唯一（多可排序列的表头剥掉运行时类后无法区分兄弟列）——这两种链当不了
  // 首候选，text 放首位；链唯一且稳定则 css-first 保唯一性，text 排链尾兜底
  // （链活时轮不到，链死时按文本命中）。
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

  // ---- 元素拾取（事件驱动，0.1.0）----
  // pick-start 带自增 pickId 发 bg → bg 广播全帧拾取 → 被点击帧回 pick-result →
  // bg 竞胜（首个）、附帧链、广播 pick-stop、把结果转发回本面板。pickActive 守卫防重入
  // （拾取中连点功能按钮会开两个拾取），90s 超时兜底（bg 零响应/用户一直不点）。
  // 过期结果（新一轮拾取已开/已超时收场）按 pickId 校验丢弃，不落进新表单。
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
      // 拾取后先进断言表单：对象/匹配方式/期望值都可改，确定才生成（v0.0.9 起，
      // 旧行为「选中即生成」只能录元素文本等于，录不了 contains/页面断言/URL 断言）
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
      if (!pickActive || pickActive.pickId !== pickId) return; // 已被超时收场：忽略迟到的错误
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
    } else if (msg?.type === 'pick-result') {
      // bg 竞胜后转发的拾取结果（已附 frameChain，如有）；过期 pickId 在 finishPick 里丢弃
      finishPick(msg.result, msg.pickId);
    }
  });

  // 重注入/SW 复活后兜底拉一次会话态：onUpdated 的 step-count/pause 推送若因时序丢失，这里拉平
  chrome.runtime.sendMessage({ type: 'get-state' }, (s) => {
    if (!s || !s.recording) return;
    count = s.stepCount ?? count;
    paused = !!s.paused;
    render();
  });

  (document.body || document.documentElement).appendChild(host);
  render();
})();
