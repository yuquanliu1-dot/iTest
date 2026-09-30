(async () => {
  const src = chrome.runtime.getURL('modules/recorder-manager.js');
  const mod = await import(src);
  const manager = new mod.RecorderManager();

  const pickerMod = await import(chrome.runtime.getURL('modules/picker.js'));
  const picker = new pickerMod.ElementPicker();

  const sendStep = (step) => chrome.runtime.sendMessage({ type: 'step', step });
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
      // background 注入后显式启动（外部录制页没有 ita-web window 消息源）
      startCapture();
    } else if (msg?.type === 'pause') {
      manager.setPaused(true);
    } else if (msg?.type === 'resume') {
      manager.setPaused(false);
    } else if (msg?.type === 'pick') {
      // 面板发起的元素拾取：拾取期间暂停普通录制
      manager.setPaused(true);
      picker.start((result) => {
        manager.setPaused(false);
        sendResponse(result ?? { canceled: true });
      });
      return true;
    } else if (msg?.type === 'emit-step') {
      // 面板生成的步骤（extract/assertText/assertJson/hover/aiStep）直接以 DSL 上送
      chrome.runtime.sendMessage({ type: 'step', dsl: msg.dsl, url: location.href });
      sendResponse({ ok: true });
    }
  });
})();