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
      .opts { display: flex; flex-direction: column; gap: 4px; padding: 2px 0; }
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

  pauseBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: paused ? 'resume' : 'pause' }));
  // 停止后顺手切回发起录制的用例详情页（步骤写入完成后自动跳转，免去用户手动找标签）
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'stop', from: 'panel' });
    chrome.runtime.sendMessage({ type: 'open-console' });
  });
  backBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-console' }));
  featBtns.forEach((btn) => {
    btn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-panel', mode: btn.dataset.mode }));
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
