import { DEFAULT_CONSOLE_ORIGIN, normalizeConsoleOrigin } from '../modules/console-config.js';

document.documentElement.lang = chrome.i18n.getUILanguage();

// Static __MSG_*__ literals in the HTML are not replaced by the _locales mechanism (that mechanism only handles
// manifest fields + runtime chrome.i18n.getMessage() calls), so text nodes in the DOM are replaced here.
// Order-sensitive: lang must be set before the replacement (otherwise i18n.getMessage returns empty).
function applyI18nToDocument() {
  const re = /__MSG_(\w+)__/g;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    if (!re.test(n.nodeValue)) continue;
    re.lastIndex = 0;
    n.nodeValue = n.nodeValue.replace(re, (_, key) => {
      const msg = chrome.i18n.getMessage(key);
      // Missing keys keep the original literal for easier debugging
      return msg ? msg : `__MSG_${key}__`;
    });
  }
}
applyI18nToDocument();

// Open the console: prefer switching back to the case-detail tab that started the recording; open the configured console home when there is no session or the tab is closed
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
