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
