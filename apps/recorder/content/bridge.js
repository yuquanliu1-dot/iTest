// 幂等守卫：中台地址配成 localhost 时静态+动态注册会双注入，同扩展 content script 共享隔离世界，
// 二次注入直接跳过，避免双 start 消息（双 WS、双录制 tab）。
(() => {
  if (globalThis.__itaBridge) return;
  globalThis.__itaBridge = true;

  // chrome.runtime.id 在扩展被卸载/重新加载后变为 undefined；sendMessage 会抛
  // "Extension context invalidated"。提前检测并静默吞掉，避免每次心跳都往 console 喷红。
  const isContextAlive = () => {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'ita-web') return;
    if (!isContextAlive()) {
      window.postMessage({ source: 'ita-ext', type: 'start-result', ok: false, error: 'context_invalidated' }, '*');
      return;
    }
    if (e.data.type === 'start-recording') {
      chrome.runtime.sendMessage(
        { type: 'start', session: e.data.session, targetUrl: e.data.targetUrl },
        (resp) => {
          if (chrome.runtime.lastError) {
            // 扩展中途被卸载/重载：回报 ok=false 让中台停止等待并提示刷新。
            window.postMessage({ source: 'ita-ext', type: 'start-result', ok: false, error: 'context_invalidated' }, '*');
            return;
          }
          window.postMessage({ source: 'ita-ext', type: 'start-result', ok: resp?.ok }, '*');
        }
      );
    } else if (e.data.type === 'stop-recording') {
      chrome.runtime.sendMessage({ type: 'stop' }, (resp) => {
        if (chrome.runtime.lastError) {
          window.postMessage({ source: 'ita-ext', type: 'stop-result', ok: false, error: 'context_invalidated' }, '*');
          return;
        }
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
