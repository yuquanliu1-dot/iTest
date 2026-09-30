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
    const stopTab = () => {
      if (recordingTabId !== null) {
        chrome.tabs.sendMessage(recordingTabId, { type: 'stop' });
        recordingTabId = null;
      }
    };
    const sock = ws;
    ws = null;
    if (sock && sock.readyState === 1) {
      // flush 握手：发 finish 后等服务端处理完队列里的 step 并关闭连接，
      // 再通知页面去调 finish HTTP——否则尾部步骤可能还没落到 session.steps。
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
  return false;
});
