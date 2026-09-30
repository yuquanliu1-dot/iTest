let ws = null;
let recordingTabId = null;
let paused = false;
let sessionMode = 'fresh';
let sessionIncognito = false;
let sessionId = null;
// tab 路由：opener 派生 tab 的 tabIndex；tab #0 是主 tab
const recordingTabs = new Map(); // tabId -> tabIndex
let nextTabIndex = 1;

function toDSL(step) {
  if (step.type === 'check') return { kind: 'check', locator: step.target, checked: !!step.checked };
  if (step.type === 'select') return { kind: 'select', locator: step.target, value: step.value ?? '' };
  if (step.type === 'upload') {
    // 上传步骤 fileId 由 web 端绑定；此处只占位
    return { kind: 'upload', locator: step.target, fileId: '__pending__' };
  }
  const dsl = { kind: step.type, locator: step.target };
  if (dsl.kind === 'fill') {
    dsl.value = step.value ?? '';
    if (step.sensitive) dsl.sensitive = true;
  }
  return dsl;
}

function attachTabInjector(tabIndex = 0) {
  const onUpdated = (tabId, changeInfo) => {
    if (tabId !== recordingTabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.scripting
      .executeScript({ target: { tabId }, files: ['content/recorder.js'] })
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'start', mode: sessionMode, tabRef: `${sessionId}|tab#${tabIndex}` }))
      .catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
}

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
  // 接管新 tab
  attachTabInjector(idx);
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start' && msg.session) {
    const { wsUrl, sessionId: sid, mode, incognito } = msg.session;
    sessionId = sid;
    sessionMode = mode || 'fresh';
    sessionIncognito = !!incognito;
    ws = new WebSocket(`${wsUrl}?sessionId=${sessionId}&token=${msg.session.token}`);
    ws.onopen = () => {
      sendResponse({ ok: true });
      const createOpts = { url: msg.targetUrl };
      if (sessionIncognito) createOpts.incognito = true;
      chrome.tabs.create(createOpts, (tab) => {
        recordingTabId = tab.id;
        nextTabIndex = 1;
        attachTabInjector(0);
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

  if (msg.type === 'get-state') {
    sendResponse({
      recording: recordingTabId !== null,
      paused,
      mode: sessionMode,
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

  if (msg.type === 'pick' || msg.type === 'emit-step') {
    if (recordingTabId === null) { sendResponse({ ok: false, error: '当前没有录制中的标签页' }); return; }
    chrome.tabs.sendMessage(recordingTabId, msg, (resp) => sendResponse(resp ?? { ok: false }));
    return true;
  }

  return false;
});