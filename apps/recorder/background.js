let ws = null;
let activeTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start' && msg.session) {
    const { wsUrl, sessionId, token } = msg.session;
    ws = new WebSocket(`${wsUrl}?sessionId=${sessionId}&token=${token}`);
    activeTabId = sender.tab?.id;
    ws.onopen = () => {
      sendResponse({ ok: true });
      chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: ['content/recorder.js'],
      });
    };
    ws.onerror = () => sendResponse({ ok: false, error: 'ws failed' });
    return true;
  }
  if (msg.type === 'step' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'step', step: msg.step }));
  }
  if (msg.type === 'stop') {
    ws?.send(JSON.stringify({ type: 'finish' }));
    ws?.close();
    ws = null;
  }
  return false;
});