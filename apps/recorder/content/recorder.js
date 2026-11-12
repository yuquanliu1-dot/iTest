(async () => {
  // Injection idempotence guard: the recorder now enters documents via scripting.registerContentScripts (all-frames
  // injection, see FRAME_SCRIPT_ID in background.js); background no longer injects this file imperatively into
  // recorder tabs; the guard is kept as a fallback.
  // One real click must not be received once each by N independent listeners: each has its own onClick closure and
  // an independent 200ms dedupe window, invisible to one another — a single click would produce N byte-identical
  // steps (2026-10-15 case: consecutive duplicates of 2/2/5/4).
  // Real navigation destroys the document along with the copies; the guard resets together with the isolated world,
  // so it never blocks a legitimate re-injection.
  if (globalThis.__itaRecorder) return;
  // Guard value set synchronously (same convention as before). The light layer (token-as-attribute + announce
  // listener) installs immediately; the heavy modules (manager/picker) sink into bootstrap — frames whose announce
  // reply says recording:false stay dormant at zero cost (this file is registered into all tabs for all frames,
  // so the dormant path must not import heavy modules).
  globalThis.__itaRecorder = 'loading';

  // ---- Frame token (the foundation of the iframe frame chain) ----
  // Written into a DOM attribute rather than a window variable: isolated worlds cannot see each other, but the DOM
  // is shared across worlds — only then can the parent frame's recorder.js instance (another world) read the child
  // frame's token, and background's SW revival re-probe can read it too.
  // A cross-origin parent frame throws on parent.document reads → parentToken=null → that frame records under the no-chain policy.
  const TOKEN_ATTR = 'data-ita-frame-token';
  // crypto.randomUUID only exists in secure contexts (intranet http systems like 192.168.x lack this API) — need a fallback
  const token = crypto.randomUUID
    ? crypto.randomUUID()
    : `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  document.documentElement.setAttribute(TOKEN_ATTR, token);

  let bootstrapped = false; // heavy modules loaded and listening
  let started = false; // manager.start called (a resumed session enters the paused state without starting; only the resume message starts it)
  let currentTabRef = 'tab#0';
  let lastComponentHint = null;
  let panelOptions = {};
  let pickPrevPaused = null;
  let manager = null;
  let picker = null;

  const sendStep = (step) => {
    if (lastComponentHint) {
      step.componentHint = lastComponentHint;
      lastComponentHint = null;
    }
    // Consume the background's receipt via callback: a step only counts once background confirms
    // "delivered to the server or queued for sending". The callback only swallows the response (avoids a
    // message port closed warning); failures are not retried —
    // when unreachable, background replies failure and the popup path surfaces it; the recording path can only be
    // observed via the panel counter. token lets background resolve this frame's frameChain (iframe frame chain).
    chrome.runtime.sendMessage({ type: 'step', step, tabRef: currentTabRef, token }, () => void chrome.runtime.lastError);
  };
  const startCapture = () => {
    if (started) return;
    started = true;
    manager.start(sendStep, panelOptions);
  };

  /** Loads the heavy modules and takes over recording. reply: the frame-announce receipt (guaranteed when recording:true). */
  const bootstrap = async (reply) => {
    if (bootstrapped) return;
    bootstrapped = true;
    let mod;
    let pickerMod;
    try {
      mod = await import(chrome.runtime.getURL('modules/recorder-manager.js'));
      pickerMod = await import(chrome.runtime.getURL('modules/picker.js'));
    } catch (e) {
      // Roll bootstrapped back on artifact corruption so the next start broadcast can retry
      bootstrapped = false;
      throw e;
    }
    manager = new mod.RecorderManager();
    picker = new pickerMod.ElementPicker();
    currentTabRef = reply?.tabRef ?? 'tab#0';

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
        // manager.start resets paused — same semantics as resume (bg broadcasts after re-injection; the pause message right after pushes it back to paused)
        startCapture();
      } else if (msg?.type === 'pause') {
        if (started) manager.setPaused(true);
      } else if (msg?.type === 'resume') {
        startCapture();
      } else if (msg?.type === 'set-options') {
        // Toggling recordHover / fillFlushMs / preferredDataAttribute in the panel: update this frame's manager live.
        panelOptions = msg.options ?? {};
        manager.setOptions(panelOptions);
        sendResponse({ ok: true });
        return;
      } else if (msg?.type === 'pick-start') {
        // Element pick initiated by the panel: this frame pauses event capture and starts the pick highlight; the result
        // goes through bg's race (first pick-result wins), then bg broadcasts pick-stop to wrap up uniformly, so N frames don't each push results into the panel form
        pickPrevPaused = started ? manager.isPaused() : false;
        if (started) manager.setPaused(true);
        picker.start((result) => {
          if (started) manager.setPaused(pickPrevPaused);
          pickPrevPaused = null;
          if (result && result.componentHint) {
            lastComponentHint = result.componentHint;
          }
          chrome.runtime.sendMessage(
            { type: 'pick-result', pickId: msg.pickId, token, result: result ?? { canceled: true } },
            () => void chrome.runtime.lastError,
          );
        });
      } else if (msg?.type === 'pick-stop') {
        // The winning frame already restored its paused state and sent its result; here we wrap up the remaining frames.
        // picker.stop does not fire onDone (picker's internal convention), so the winner never double-sends via stop.
        if (pickPrevPaused !== null) {
          if (started) manager.setPaused(pickPrevPaused);
          pickPrevPaused = null;
        }
        picker.stop();
      } else if (msg?.type === 'locate-frame') {
        // bg frame-chain drill-down: find "the host iframe element of this frame" and produce candidates. The isolated
        // world's window.frameElement is unobtainable (Chromium behavior, observed and confirmed); instead scan the parent
        // document and claim ourselves by contentWindow identity —
        // "child frame isolated world reading the parent document" is the same-origin-capable channel already proven by announce; cross-origin parent.document
        // throws → no chain, aligned with the policy.
        (async () => {
          let el = null;
          try {
            if (window.parent !== window) {
              const doc = window.parent.document;
              for (const cand of doc.querySelectorAll('iframe,frame')) {
                if (cand.contentWindow === window) { el = cand; break; }
              }
            }
          } catch { el = null; }
          if (!el) { sendResponse({ locators: null }); return; }
          try {
            // generateLocators comes from recorder-manager.js (the esbuild bundle): selector-core.js
            // contains bare module specifiers (@medv/finder) that the browser's dynamic import() cannot resolve — importing it directly would blow up.
            const mod = await import(chrome.runtime.getURL('modules/recorder-manager.js'));
            sendResponse({ locators: mod.generateLocators(el) });
          } catch {
            sendResponse({ locators: null });
          }
        })();
        return true;
      }
    });

    // If the announce reply says the session is paused, the manager does not start; startCapture when the resume message arrives.
    if (!reply?.paused) startCapture();
  };

  // ---- announce handshake: announce on load; bootstrap only once the reply says recording:true ----
  const announce = (attempt = 0) => {
    // Re-read the parent token on each attempt: a static iframe may finish injecting before the parent frame (parent attribute not yet set).
    // A cross-origin parent throws directly on parent.document reads — this must be distinguished from "parent frame not yet injected":
    // the former never becomes ready, retrying is pure waste (it also stretches this frame's startup across the full 5s retry window);
    // the latter resolves with a wait. Cross-origin bootstraps immediately under the no-chain policy.
    let parentToken = null;
    let parentCross = false;
    if (window.parent !== window) {
      try { parentToken = window.parent.document.documentElement.getAttribute(TOKEN_ATTR); } catch { parentCross = true; }
    }
    chrome.runtime.sendMessage({ type: 'frame-announce', token, parentToken }, (reply) => {
      if (chrome.runtime.lastError || !reply) {
        // SW cold-starting / being reclaimed: no one catches the message; back off and retry (500ms × 10 ≈ 5s window)
        if (attempt < 10) setTimeout(() => announce(attempt + 1), 500);
        return;
      }
      if (!reply.recording) return; // no active session: stay dormant (no heavy-module import, no page-event listeners)
      if (window.parent !== window && !parentToken && !parentCross && attempt < 10) {
        // Nested frame but the parent token is not yet in place (parent frame injected later than this frame): re-announce after
        // the parent sets its attribute, otherwise the chain is severed at this frame. Cross-origin parents (parentCross) don't wait —
        // never ready; start directly under the no-chain policy.
        setTimeout(() => announce(attempt + 1), 500);
        return;
      }
      void bootstrap(reply);
    });
  };
  announce();
  globalThis.__itaRecorder = 'ok';

  chrome.runtime.onMessage.addListener((msg) => {
    // Fallback: frames that missed the announce retry window (SW unavailable for a long time) re-handshake via the start broadcast.
    // The message broadcasts to all frames of the tab; each frame announces independently without affecting the others.
    if (msg?.type === 'start' && !bootstrapped) announce();
  });
})();
