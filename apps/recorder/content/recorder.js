(async () => {
  // 注入幂等守卫：background 对录制 tab 每次 onUpdated('complete') 都会重复执行本脚本（同文档重注入，
  // 旧副本不会被移除）。已存在正在监听的副本时直接跳过——同一份真实点击不应被 N 份独立监听各收一次：
  // 每份有自己的 onClick 闭包与独立 200ms 去重窗口，互不感知，一次点击会产出 N 条逐字节相同的步骤
  // （2026-10-15 病例：同一用例出现 2/2/5/4 的连续重复）。与 bridge.js 的 __itaBridge 同模式；
  // 真实导航会销毁文档与副本，守卫随 isolated world 一起重置，不会误挡合法的重注入。
  if (globalThis.__itaRecorder) return;
  globalThis.__itaRecorder = true;
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
  // panel 里切换的录制选项：startCapture 时透传给 manager；页面内面板用 set-options 实时更新。
  let panelOptions = {};
  const startCapture = () => manager.start(sendStep, panelOptions);

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
    } else if (msg?.type === 'set-options') {
      // panel 里切换 recordHover / fillFlushMs / preferredDataAttribute：实时更新 manager。
      panelOptions = msg.options ?? {};
      manager.setOptions(panelOptions);
      sendResponse({ ok: true });
      return;
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