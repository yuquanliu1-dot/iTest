import { DEFAULT_CONSOLE_ORIGIN, originToMatchPattern } from './modules/console-config.js';

let ws = null;
let recordingTabId = null;
let paused = false;
let sessionMode = 'fresh';
let sessionIncognito = false;
let sessionId = null;
// 录制步骤计数：推送给页面内控制面板（content/panel.js）展示
let stepCount = 0;
// 发起录制的 web 中台标签页（用例详情页）：面板/弹窗停止录制后通知其收尾；
// 停止后保留指向，供「打开中台」切回用例详情页，下次 start 覆盖
let webTabId = null;
// tab 路由：opener 派生 tab 的 tabIndex；tab #0 是主 tab
const recordingTabs = new Map(); // tabId -> tabIndex
let nextTabIndex = 1;

function toDSL(step) {
  if (step.type === 'check') return { kind: 'check', locator: step.target, checked: !!step.checked, ...intentField(step) };
  if (step.type === 'select') return { kind: 'select', locator: step.target, value: step.value ?? '', ...intentField(step) };
  if (step.type === 'upload') {
    // 上传步骤 fileId 由 web 端绑定；此处只占位
    return { kind: 'upload', locator: step.target, fileId: '__pending__', ...intentField(step) };
  }
  const dsl = { kind: step.type, locator: step.target, ...intentField(step) };
  if (dsl.kind === 'fill') {
    dsl.value = step.value ?? '';
    if (step.sensitive) dsl.sensitive = true;
  }
  if (dsl.kind === 'aiTask') dsl.instruction = step.value ?? '';
  return dsl;
}

/** 把 recorder 端附带的 intentLocator 透传到 DSL——回放侧用它当 data-testid / name 的语义锚。 */
function intentField(step) {
  return step.intentLocator ? { intentLocator: step.intentLocator } : {};
}

// 录制中的 tab（主 tab 或接管的派生 tab）每次页面加载完成后重注入 recorder/panel：
// 同 tab 跳转新页面时内容脚本随文档销毁，不重注入则录制与面板都会丢失。
// 注入后重发 start 握手，并把当前步数/暂停态同步给全新的面板实例。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete' || recordingTabId === null) return;
  const isMain = tabId === recordingTabId;
  if (!isMain && !recordingTabs.has(tabId)) return;
  const tabIndex = isMain ? 0 : recordingTabs.get(tabId);
  chrome.scripting
    .executeScript({ target: { tabId }, files: ['content/recorder.js', 'content/panel.js'] })
    .then(() => {
      chrome.tabs.sendMessage(tabId, { type: 'start', mode: sessionMode, tabRef: `${sessionId}|tab#${tabIndex}` });
      chrome.tabs.sendMessage(tabId, { type: 'step-count', count: stepCount }, () => void chrome.runtime.lastError);
      if (paused) chrome.tabs.sendMessage(tabId, { type: 'pause' });
    })
    .catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  if (recordingTabId === null || tab.openerTabId !== recordingTabId) return;
  const idx = nextTabIndex++;
  recordingTabs.set(tab.id, idx);
  // 上报 tab-event
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'tab-event',
      event: { kind: 'opened', tabRef: `${sessionId}|tab#${idx}`, title: tab.title || '', url: tab.url || '' },
    }));
  }
  // 接管新 tab（页面加载完成后由全局 onUpdated 监听器注入）
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!recordingTabs.has(tabId)) return;
  const idx = recordingTabs.get(tabId);
  recordingTabs.delete(tabId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'tab-event',
      event: { kind: 'closed', tabRef: `${sessionId}|tab#${idx}` },
    }));
  }
});

// ---- 中台地址配置（popup 写 chrome.storage.sync，非默认时动态注册 bridge 注入）----

const BRIDGE_SCRIPT_ID = 'ita-bridge-dynamic';

async function getConsoleOrigin() {
  try {
    const { consoleOrigin } = await chrome.storage.sync.get('consoleOrigin');
    return consoleOrigin || DEFAULT_CONSOLE_ORIGIN;
  } catch {
    return DEFAULT_CONSOLE_ORIGIN;
  }
}

// manifest 静态只注入 localhost 的 bridge；中台配成其他地址时在此动态注册（先注销再注册，幂等）。
// SW 顶层执行是兜底：扩展更新会清空动态注册。
async function syncBridgeRegistration() {
  try {
    const origin = await getConsoleOrigin();
    const existing = await chrome.scripting.getRegisteredContentScripts();
    if (existing.some((s) => s.id === BRIDGE_SCRIPT_ID)) {
      await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
    }
    if (origin !== DEFAULT_CONSOLE_ORIGIN) {
      await chrome.scripting.registerContentScripts([{
        id: BRIDGE_SCRIPT_ID,
        matches: [originToMatchPattern(origin)],
        js: ['content/bridge.js'],
        runAt: 'document_start',
        persistAcrossSessions: true,
      }]);
    }
  } catch (err) {
    console.warn('syncBridgeRegistration failed', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  syncBridgeRegistration();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.consoleOrigin) syncBridgeRegistration();
});
syncBridgeRegistration();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start' && msg.session) {
    const { wsUrl, sessionId: sid, mode, incognito } = msg.session;
    sessionId = sid;
    sessionMode = mode || 'fresh';
    sessionIncognito = !!incognito;
    stepCount = 0;
    paused = false;
    webTabId = sender.tab?.id ?? null;
    ws = new WebSocket(`${wsUrl}?sessionId=${sessionId}&token=${msg.session.token}`);
    ws.onopen = () => {
      sendResponse({ ok: true });
      const createOpts = { url: msg.targetUrl };
      if (sessionIncognito) createOpts.incognito = true;
      chrome.tabs.create(createOpts, (tab) => {
        recordingTabId = tab.id;
        nextTabIndex = 1;
      });
    };
    ws.onerror = () => sendResponse({ ok: false, error: 'ws failed' });
    return true;
  }

  if (msg.type === 'step' && ws && ws.readyState === 1) {
    const dsl = msg.dsl ?? toDSL(msg.step);
    const url = msg.step?.url ?? msg.url ?? null;
    const tabRef = msg.step?.tabRef ?? msg.tabRef ?? `${sessionId}|tab#0`;
    const componentKind = msg.step?.componentKind ?? null;
    ws.send(JSON.stringify({
      type: 'step',
      step: { action: dsl, url, tabRef, componentKind },
    }));
    stepCount++;
    if (recordingTabId !== null) {
      // 面板不在时静默吞掉 lastError（无回调接收方）
      chrome.tabs.sendMessage(recordingTabId, { type: 'step-count', count: stepCount }, () => void chrome.runtime.lastError);
    }
  }

  if (msg.type === 'switch-tab') {
    if (recordingTabs.has(msg.tabId) || msg.tabId === recordingTabId) {
      chrome.tabs.update(msg.tabId, { active: true });
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'tab not in session' });
    }
    return;
  }

  if (msg.type === 'stop') {
    const stopTab = () => {
      if (recordingTabId !== null) {
        chrome.tabs.sendMessage(recordingTabId, { type: 'stop' });
        recordingTabId = null;
      }
      recordingTabs.clear();
      paused = false;
      sessionId = null;
      stepCount = 0;
      // 面板/弹窗发起的停止：通知 web 中台收尾（finish 会话、复位状态）
      if (msg.from === 'panel' && webTabId !== null) {
        chrome.tabs.sendMessage(webTabId, { type: 'recording-stopped' }, () => void chrome.runtime.lastError);
      }
    };
    const sock = ws;
    ws = null;
    if (sock && sock.readyState === 1) {
      let settled = false;
      const done = () => { if (settled) return; settled = true; stopTab(); sendResponse({ ok: true }); };
      sock.onclose = () => done();
      sock.send(JSON.stringify({ type: 'finish' }));
      setTimeout(() => { try { sock.close(); } catch {} done(); }, 3000);
    } else { stopTab(); sendResponse({ ok: true }); }
    return true;
  }

  if (msg.type === 'open-console') {
    // 打开中台：优先切回发起录制的用例详情页 tab（含窗口前置）；无会话或 tab 已关则新开中台首页。
    // 不回 sendResponse：目标窗口前置会立即关闭 popup，回调随之失效。
    const fallback = () => getConsoleOrigin().then((origin) => chrome.tabs.create({ url: `${origin}/` }));
    if (webTabId === null) { fallback(); return; }
    chrome.tabs
      .get(webTabId)
      .then((tab) => {
        chrome.tabs.update(tab.id, { active: true });
        chrome.windows.update(tab.windowId, { focused: true });
      })
      .catch(fallback);
    return;
  }

  if (msg.type === 'get-state') {
    sendResponse({
      recording: recordingTabId !== null,
      paused,
      mode: sessionMode,
      stepCount,
      tabs: Array.from(recordingTabs.entries()).map(([id, idx]) => ({ tabId: id, tabRef: `${sessionId}|tab#${idx}` })),
    });
    return;
  }

  if (msg.type === 'pause' || msg.type === 'resume') {
    paused = msg.type === 'pause';
    if (recordingTabId !== null) chrome.tabs.sendMessage(recordingTabId, { type: msg.type });
    sendResponse({ recording: recordingTabId !== null, paused });
    return;
  }

  if (msg.type === 'open-panel') {
    // 页面内控制面板的功能按钮：打开对应模式的录制面板窗口（与 action 弹窗同一路径）
    const height = msg.mode === 'assert' ? 420 : msg.mode === 'ai' ? 280 : 240;
    chrome.windows.create({
      url: chrome.runtime.getURL(`popup/panel.html?mode=${msg.mode}`),
      type: 'popup',
      width: 360,
      height,
    });
    return;
  }

  if (msg.type === 'pick' || msg.type === 'emit-step' || msg.type === 'set-options') {
    if (recordingTabId === null) { sendResponse({ ok: false, error: '当前没有录制中的标签页' }); return; }
    chrome.tabs.sendMessage(recordingTabId, msg, (resp) => sendResponse(resp ?? { ok: false }));
    return true;
  }

  return false;
});