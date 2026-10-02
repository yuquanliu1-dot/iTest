/**
 * 页面内录制控制面板：录制启动时由 background 注入到录制标签页，
 * 默认固定在右下角的玻璃卡片，可通过标题栏拖动到任意位置（限制在视口内）。
 * 样式对齐 iTest 设计 tokens（packages/ui/src/tokens.css）：按钮圆角 6px（sm）、
 * 主操作紫色填充、次操作 ghost + 品牌边、危险 destructive、间距 token 化。
 * Shadow DOM 隔离，避免与宿主页面样式互相污染。
 */
(() => {
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
        font-family: -apple-system, "SF Pro Text", "DM Sans", "Inter", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
        width: 240px;
        background: rgba(255, 255, 255, 0.82);
        -webkit-backdrop-filter: blur(14px);
        backdrop-filter: blur(14px);
        border: 1px solid rgba(255, 255, 255, 0.9);
        border-radius: 14px;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06), 0 8px 30px rgba(120, 110, 200, 0.16);
        color: #232038;
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
        background: rgba(124, 92, 252, 0.12); color: #7C5CFC; white-space: nowrap;
      }
      .toggle {
        border: none; background: transparent; color: #9B97B5; cursor: pointer;
        font-size: 13px; line-height: 1; padding: 0 2px;
      }
      .toggle:hover { color: #232038; }

      .body { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 6px; }
      .row { display: flex; gap: 6px; }
      .row .btn { flex: 1; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }

      .btn {
        padding: 6px 10px; font-size: 12px; border-radius: 6px; cursor: pointer;
        font-family: inherit; line-height: 1.4; text-align: center;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      }
      /* 主操作：紫色填充（与中台按钮一致） */
      .btn.primary { background: #7C5CFC; color: #fff; border: 1px solid #7C5CFC; font-weight: 500; }
      .btn.primary:hover { background: #6A4AE0; border-color: #6A4AE0; }
      /* 次操作：浅紫 ghost + 品牌边 */
      .btn.ghost { background: rgba(124, 92, 252, 0.08); border: 1px solid rgba(124, 92, 252, 0.20); color: #7C5CFC; }
      .btn.ghost:hover { background: rgba(124, 92, 252, 0.14); border-color: rgba(124, 92, 252, 0.32); }
      /* 危险：透明 + 红边 */
      .btn.danger { background: transparent; border: 1px solid #F04438; color: #F04438; }
      .btn.danger:hover { background: rgba(240, 68, 56, 0.08); }

      .panel.collapsed { width: auto; }
      .panel.collapsed .body { display: none; }
      .panel.collapsed .head { padding: 7px 10px; }
      .panel.collapsed .count { margin-right: 2px; }
    </style>
    <div class="panel">
      <div class="head">
        <span class="dot"></span>
        <span class="title">iTest 录制中</span>
        <span class="count">0 步</span>
        <button class="toggle" title="收起面板">—</button>
      </div>
      <div class="body">
        <div class="row">
          <button class="btn ghost pause">暂停</button>
          <button class="btn danger stop">停止录制</button>
        </div>
        <div class="grid">
          <button class="btn ghost feat" data-mode="variable">保存变量</button>
          <button class="btn ghost feat" data-mode="assert">添加断言</button>
          <button class="btn ghost feat" data-mode="hover">记录悬浮</button>
          <button class="btn ghost feat" data-mode="ai">AI 自然语言</button>
        </div>
        <button class="btn primary back">返回用例详情页</button>
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

  const render = () => {
    panel.classList.toggle('collapsed', collapsed);
    dot.classList.toggle('paused', paused);
    title.textContent = paused ? '已暂停' : 'iTest 录制中';
    countEl.textContent = `${count} 步`;
    pauseBtn.textContent = paused ? '继续' : '暂停';
    toggleBtn.textContent = collapsed ? '◼' : '—';
    toggleBtn.title = collapsed ? '展开面板' : '收起面板';
  };

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
