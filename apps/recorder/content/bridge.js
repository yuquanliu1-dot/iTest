// 幂等守卫：中台地址配成 localhost 时静态+动态注册会双注入，同扩展 content script 共享隔离世界，
// 二次注入直接跳过，避免双 start 消息（双 WS、双录制 tab）。
(() => {
  if (globalThis.__itaBridge) return;
  globalThis.__itaBridge = true;

  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'ita-web') return;
    if (e.data.type === 'start-recording') {
      chrome.runtime.sendMessage(
        { type: 'start', session: e.data.session, targetUrl: e.data.targetUrl },
        (resp) => {
          window.postMessage({ source: 'ita-ext', type: 'start-result', ok: resp?.ok }, '*');
        }
      );
    } else if (e.data.type === 'stop-recording') {
      chrome.runtime.sendMessage({ type: 'stop' }, (resp) => {
        window.postMessage({ source: 'ita-ext', type: 'stop-result', ok: resp?.ok }, '*');
      });
    }
  });

  // 面板/弹窗发起的停止：background 通知 web 页收尾
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'recording-stopped') {
      window.postMessage({ source: 'ita-ext', type: 'recording-stopped' }, '*');
    }
  });
})();
