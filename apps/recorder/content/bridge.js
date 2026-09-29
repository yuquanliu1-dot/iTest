window.addEventListener('message', (e) => {
  if (e.data?.source !== 'ita-web') return;
  chrome.runtime.sendMessage({ type: 'start', session: e.data.session }, (resp) => {
    window.postMessage({ source: 'ita-ext', type: 'start-result', ok: resp?.ok }, '*');
  });
});