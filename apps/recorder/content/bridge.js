// Idempotence guard: when the console address is configured as localhost, static + dynamic registration double-inject; extension
// content scripts in the same isolated world skip the second injection directly, avoiding duplicate start messages (double WS, double recording tab).
(() => {
  if (globalThis.__itaBridge) return;
  globalThis.__itaBridge = true;

  // chrome.runtime.id becomes undefined after the extension is unloaded/reloaded; sendMessage throws
  // "Extension context invalidated". Detect early and swallow silently to avoid spraying console red on every heartbeat.
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
    // Probe handshake: the web top bar sends ping on mount, the extension replies pong + manifest version.
    // No background call, no WS opened — answered within the content script alone.
    // An empty version → context invalidated (extension just reloaded); the web side can prompt a page refresh.
    if (e.data.type === 'ping') {
      let version = null;
      if (isContextAlive()) {
        try { version = chrome.runtime.getManifest().version ?? null; } catch { /* ignore */ }
      }
      window.postMessage({ source: 'ita-ext', type: 'pong', id: e.data.id, version }, '*');
      return;
    }

    if (e.data.type === 'start-recording') {
      chrome.runtime.sendMessage(
        { type: 'start', session: e.data.session, targetUrl: e.data.targetUrl },
        (resp) => {
          if (chrome.runtime.lastError) {
            // The extension was unloaded/reloaded mid-flight: report ok=false so the console stops waiting and prompts a refresh.
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

  // Stop initiated from the panel/popup: background notifies the web page to wrap up
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'recording-stopped') {
      window.postMessage({ source: 'ita-ext', type: 'recording-stopped' }, '*');
    }
  });
})();
