const statusEl = document.getElementById('status');
const pauseBtn = document.getElementById('pause');
const panelBtns = document.querySelectorAll('.panel-btn');

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
  const { recording, paused } = state ?? { recording: false, paused: false };
  statusEl.textContent = recording ? (paused ? '已暂停' : '录制中') : '未在录制（从中台用例详情页发起）';
  pauseBtn.disabled = !recording;
  pauseBtn.dataset.paused = String(paused);
  pauseBtn.textContent = paused ? '继续录制' : '暂停录制';
  panelBtns.forEach((b) => (b.disabled = !recording));
}

chrome.runtime.sendMessage({ type: 'get-state' }, render);