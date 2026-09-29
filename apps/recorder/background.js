let ws = null;
let recordingTabId = null;

function toDSL(step) {
  const dsl = { kind: step.type, locator: step.target };
  if (dsl.kind === 'fill') dsl.value = step.value ?? '';
  return dsl;
}

function attachTabInjector() {
  const onUpdated = (tabId, changeInfo) => {
    if (tabId !== recordingTabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.scripting.executeScript({ target: { tabId }, files: ['content/recorder.js'] });
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
    ws.send(JSON.stringify({ type: 'step', step: { action: toDSL(msg.step) } }));
  }
  if (msg.type === 'stop') {
    ws?.send(JSON.stringify({ type: 'finish' }));
    ws?.close();
    ws = null;
    if (recordingTabId !== null) {
      chrome.tabs.sendMessage(recordingTabId, { type: 'stop' });
      recordingTabId = null;
    }
  }
  return false;
});
