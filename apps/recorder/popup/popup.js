const statusEl = document.getElementById('status');
const modeEl = document.getElementById('mode');
const pauseBtn = document.getElementById('pause');
const panelBtns = document.querySelectorAll('.panel-btn');
const tabsEl = document.getElementById('tabs');

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:5173/' });
});

function openPanel(mode) {
  chrome.windows.create({
    url: chrome.runtime.getURL(`popup/panel.html?mode=${mode}`),
    type: 'popup',
    width: 380,
    height: mode === 'assert' ? 460 : mode === 'ai' ? 300 : 240,
  });
}

panelBtns.forEach((btn) => {
  btn.addEventListener('click', () => openPanel(btn.dataset.mode));
});

pauseBtn.addEventListener('click', () => {
  const next = pauseBtn.dataset.paused === 'true' ? 'resume' : 'pause';
  chrome.runtime.sendMessage({ type: next }, render);
});

function render(state) {
  const { recording, paused, mode, tabs } = state ?? { recording: false, paused: false, mode: 'fresh', tabs: [] };
  statusEl.textContent = recording ? (paused ? '已暂停' : '录制中') : '未在录制（从中台用例详情页发起）';
  modeEl.textContent = recording ? `模式：${mode}` : '';
  pauseBtn.disabled = !recording;
  pauseBtn.dataset.paused = String(paused);
  pauseBtn.textContent = paused ? '继续录制' : '暂停录制';
  panelBtns.forEach((b) => (b.disabled = !recording));
  tabsEl.innerHTML = '';
  (tabs ?? []).forEach((t) => {
    const li = document.createElement('li');
    li.textContent = `${t.tabRef}`;
    li.style.cursor = 'pointer';
    li.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'switch-tab', tabId: t.tabId });
    });
    tabsEl.appendChild(li);
  });
}

chrome.runtime.sendMessage({ type: 'get-state' }, render);