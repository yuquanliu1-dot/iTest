(async () => {
  const src = chrome.runtime.getURL('modules/recorder-manager.js');
  const mod = await import(src);
  const manager = new mod.RecorderManager();

  const pickerMod = await import(chrome.runtime.getURL('modules/picker.js'));
  const picker = new pickerMod.ElementPicker();

  let currentTabRef = 'tab#0';
  let lastComponentHint = null;

  const sendStep = (step) => {
    if (lastComponentHint) {
      step.componentHint = lastComponentHint;
      lastComponentHint = null;
    }
    chrome.runtime.sendMessage({ type: 'step', step, tabRef: currentTabRef });
  };
  const startCapture = () => manager.start(sendStep);

  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'ita-web') return;
    if (e.data.type === 'start-recording') {
      startCapture();
    } else if (e.data.type === 'stop-recording') {
      manager.stop();
      picker.stop();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'stop') {
      manager.stop();
      picker.stop();
    } else if (msg?.type === 'start') {
      currentTabRef = msg.tabRef ?? 'tab#0';
      startCapture();
    } else if (msg?.type === 'pause') {
      manager.setPaused(true);
    } else if (msg?.type === 'resume') {
      manager.setPaused(false);
    } else if (msg?.type === 'pick') {
      const prevPaused = manager.isPaused();
      manager.setPaused(true);
      picker.start((result) => {
        manager.setPaused(prevPaused);
        if (result && result.componentHint) {
          lastComponentHint = result.componentHint;
        }
        sendResponse(result ?? { canceled: true });
      });
      return true;
    } else if (msg?.type === 'emit-step') {
      chrome.runtime.sendMessage({ type: 'step', dsl: msg.dsl, url: location.href, tabRef: currentTabRef });
      sendResponse({ ok: true });
    }
  });
})();