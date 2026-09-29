(async () => {
  const src = chrome.runtime.getURL('modules/recorder-manager.js');
  const mod = await import(src);
  const manager = new mod.RecorderManager();

  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'ita-web') return;
    if (e.data.type === 'start-recording') {
      manager.start((step) => {
        chrome.runtime.sendMessage({ type: 'step', step });
      });
    } else if (e.data.type === 'stop-recording') {
      manager.stop();
    }
  });
})();