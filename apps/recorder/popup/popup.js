import { DEFAULT_CONSOLE_ORIGIN, normalizeConsoleOrigin } from '../modules/console-config.js';

document.documentElement.lang = chrome.i18n.getUILanguage();

// 打开中台：优先切回发起录制的用例详情页 tab，无会话或 tab 已关则新开配置的中台首页
document.getElementById('open').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'open-console' });
});

const input = document.getElementById('console-origin');
const saveBtn = document.getElementById('save');
const status = document.getElementById('save-status');

chrome.storage.sync.get('consoleOrigin').then(({ consoleOrigin }) => {
  input.value = consoleOrigin || DEFAULT_CONSOLE_ORIGIN;
});

let statusTimer = null;
function setStatus(text, ok) {
  status.textContent = text;
  status.classList.toggle('err', !ok);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = '';
  }, 2000);
}

saveBtn.addEventListener('click', async () => {
  const origin = normalizeConsoleOrigin(input.value);
  if (!origin) {
    setStatus(chrome.i18n.getMessage('needHttp'), false);
    return;
  }
  await chrome.storage.sync.set({ consoleOrigin: origin });
  input.value = origin;
  setStatus(chrome.i18n.getMessage('saved'), true);
});
