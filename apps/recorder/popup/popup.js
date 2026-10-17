import { DEFAULT_CONSOLE_ORIGIN, normalizeConsoleOrigin } from '../modules/console-config.js';

document.documentElement.lang = chrome.i18n.getUILanguage();

// HTML 静态 __MSG_*__ 字面量不被 _locales 机制替换（该机制只处理 manifest 字段 +
// chrome.i18n.getMessage() 运行时调用），这里对 DOM 文本节点做替换。
// 顺序敏感：lang 必须先于替换（否则 i18n.getMessage 返回空）。
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
      // 缺失 key 保留原字面量便于排查
      return msg ? msg : `__MSG_${key}__`;
    });
  }
}
applyI18nToDocument();

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
