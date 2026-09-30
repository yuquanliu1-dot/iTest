let ws = null;
let recordingTabId = null;
let paused = false;

function toDSL(step) {
  if (step.type === 'check') return { kind: 'check', locator: step.target, checked: !!step.checked };
  if (step.type === 'select') return { kind: 'select', locator: step.target, value: step.value ?? '' };
  if (step.type === 'upload') {
    const dsl = { kind: 'upload', locator: step.target };
    if (step.value) dsl.fileName = step.value;
    return dsl;
  }
  const dsl = { kind: step.type, locator: step.target };
  if (dsl.kind === 'fill') dsl.value = step.value ?? '';
  return dsl;
}

function attachTabInjector() {
  const onUpdated = (tabId, changeInfo) => {
    if (tabId !== recordingTabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.scripting
      .executeScript({ target: { tabId }, files: ['content/recorder.js'] })
      // 修复启动链路：新 tab 里没有任何 ita-web window 消息源，注入完成后由 background 显式启动采集。
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'start' }))
      .catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start' && msg.session) {
    const { wsUrl, sessionId, token } = msg.session;
    ws = new WebSocket(`${wsUrl}?sessionId=${sessionId}&token=${token}`);
    ws.onopen = () => {
      sendResponse({ ok: true });
      attachTabInjector();
      chrome.tabs.create({ url: msg.targetUrl }, (tab) => {
        recordingTabId = tab.id;
      });
    };
    ws.onerror = () => sendResponse({ ok: false, error: 'ws failed' });
    return true;
  }
  if (msg.type === 'step' && ws && ws.readyState === 1) {
    // 事件步骤：msg.step 是 RecordedStep，需转换；面板步骤：msg.dsl 已是 DSL。
    const dsl = msg.dsl ?? toDSL(msg.step);
    const url = msg.step?.url ?? msg.url ?? null;
    ws.send(JSON.stringify({ type: 'step', step: { action: dsl, url } }));
  }
  if (msg.type === 'stop') {
    const stopTab = () => {
      if (recordingTabId !== null) {
        chrome.tabs.sendMessage(recordingTabId, { type: 'stop' });
        recordingTabId = null;
        paused = false;
      }
    };
    const sock = ws;
    ws = null;
    if (sock && sock.readyState === 1) {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        stopTab();
        sendResponse({ ok: true });
      };
      sock.onclose = () => done();
      sock.send(JSON.stringify({ type: 'finish' }));
      setTimeout(() => {
        try { sock.close(); } catch { /* already closed */ }
        done();
      }, 3000);
    } else {
      stopTab();
      sendResponse({ ok: true });
    }
    return true;
  }
  // —— 录制面板（popup / panel 窗口）消息 ——
  if (msg.type === 'get-state') {
    sendResponse({ recording: recordingTabId !== null, paused });
    return;
  }
  if (msg.type === 'pause' || msg.type === 'resume') {
    paused = msg.type === 'pause';
    if (recordingTabId !== null) chrome.tabs.sendMessage(recordingTabId, { type: msg.type });
    sendResponse({ recording: recordingTabId !== null, paused });
    return;
  }
  if (msg.type === 'pick' || msg.type === 'emit-step') {
    if (recordingTabId === null) {
      sendResponse({ ok: false, error: '当前没有录制中的标签页' });
      return;
    }
    chrome.tabs.sendMessage(recordingTabId, msg, (resp) => {
      sendResponse(resp ?? { ok: false });
    });
    return true;
  }
  return false;
});
