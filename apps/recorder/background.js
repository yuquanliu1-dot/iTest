import { DEFAULT_CONSOLE_ORIGIN, originToMatchPattern } from './modules/console-config.js';

let ws = null;
let recordingTabId = null;
let paused = false;
let sessionMode = 'fresh';
let sessionIncognito = false;
let sessionId = null;
// Recording step counter: pushed to the in-page control panel (content/panel.js) for display
let stepCount = 0;
// The web console tab that started the recording (case detail page): notified to wrap up after panel/popup stops;
// the pointer is kept after stopping so "open console" can switch back to the case detail page; the next start overwrites it
let webTabId = null;
// tab routing: tabIndex of opener-derived tabs; tab #0 is the main tab
const recordingTabs = new Map(); // tabId -> tabIndex
let nextTabIndex = 1;

// ---- iframe frame chain (same-origin iframe recording, 0.1.0) ----
// Frame mapping: tabId → Map<token, {frameId, parentToken}>. Registered when a frame script announces;
// after SW revival, re-probe all frames per session tab to rebuild (reprobeFrames — the DOM token attribute is readable across worlds).
const frameMap = new Map();
/** Frame-chain resolution cache: `${tabId}:${token}` → FrameChain|null. null = structural failure (cross-origin /
 *  shadow-embedded iframe etc.); caching avoids per-step retries. Frame navigation swaps documents and tokens,
 *  so the cache naturally invalidates. */
const chainCache = new Map();
const FRAME_TOKEN_ATTR = 'data-ita-frame-token';
const CHAIN_MAX_DEPTH = 5;
const FRAME_SCRIPT_ID = 'ita-recorder-frames';
/** In-flight element pick (one at a time from panel pick-start): {pickId, resolved, panelTabId}. First pick-result wins. */
let pickState = null;
let pickSeq = 0;

// ---- Recording session persistence (MV3 service workers get reclaimed by Chrome) ----
// After reclaim, all in-memory globals above reset to zero while the in-page panel is still alive → every subsequent
// step lands on the WS gate and gets dropped; the panel counter freezes at the last step and the recording looks alive
// while everything is lost (same family of symptoms as b0dbb886).
// Session state goes into chrome.storage.session: browser-session-level in-memory storage, readable only by the
// extension itself (hence the token never goes to sync); when a reclaimed SW wakes up it reconnects with the same
// sessionId — the server keeps the session in Redis for 1h and steps are RPUSH-appended, so reconnect resumes without overwriting.
const SESSION_KEY = 'recordingSession';
let wsUrl = null;
let sessionToken = null;
/** Steps not yet sent: queued when ws is not OPEN instead of dropped, re-flushed in order after the connection recovers. */
let pendingSteps = [];
/** Whether this recording ever connected successfully: only sessions that connected do reconnect-on-drop (first-connect failure keeps the old behavior: error out, no page created). */
let sessionLive = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
/** The in-flight connection attempt (the promise openSocket returns to callers): avoids duplicate connections and lets callers await "actually connected". */
let socketPromise = null;

function toDSL(step) {
  if (step.type === 'check') return { kind: 'check', locator: step.target, checked: !!step.checked, ...intentField(step) };
  if (step.type === 'select') return { kind: 'select', locator: step.target, value: step.value ?? '', ...intentField(step) };
  if (step.type === 'scroll') return { kind: 'scroll', locator: step.target, scrollTop: step.scrollTop ?? 0, scrollLeft: step.scrollLeft ?? 0, ...intentField(step) };
  if (step.type === 'upload') {
    // upload step's fileId is bound by the web side; placeholder only here
    return { kind: 'upload', locator: step.target, fileId: '__pending__', ...intentField(step) };
  }
  const dsl = { kind: step.type, locator: step.target, ...intentField(step) };
  if (dsl.kind === 'fill') {
    dsl.value = step.value ?? '';
    if (step.sensitive) dsl.sensitive = true;
  }
  if (dsl.kind === 'press') dsl.key = step.key ?? 'Enter';
  if (dsl.kind === 'aiTask') dsl.instruction = step.value ?? '';
  // dblclick upgrade artifact: 2=double click 3=triple click (plain click omits the field)
  if (dsl.kind === 'click' && (step.clickCount === 2 || step.clickCount === 3)) dsl.clickCount = step.clickCount;
  return dsl;
}

/** Passes the intentLocator attached by the recorder side into the DSL — replay uses it as the semantic anchor for data-testid / name. */
function intentField(step) {
  return step.intentLocator ? { intentLocator: step.intentLocator } : {};
}

// ---- Session persistence ----

/** Snapshot of the current session: the SW restores from it after being reclaimed (the ws instance itself is not included).
 *  The frame mapping is not snapshotted: after restoreSession, reprobeFrames re-probes all frames to rebuild it — more
 *  authoritative than a persisted snapshot (frames navigated while the SW was dead have fresh tokens; persisted entries would be stale). */
function sessionSnapshot() {
  return {
    wsUrl,
    sessionId,
    token: sessionToken,
    mode: sessionMode,
    incognito: sessionIncognito,
    webTabId,
    recordingTabId,
    recordingTabs: [...recordingTabs.entries()],
    nextTabIndex,
    paused,
    stepCount,
    pending: pendingSteps,
  };
}

/** Persists the session snapshot. When there is no session, clears leftover records (stopped during SW reclaim, or first-connect failure). */
async function persistSession() {
  try {
    if (!sessionId) {
      await chrome.storage.session.remove(SESSION_KEY);
      return;
    }
    await chrome.storage.session.set({ [SESSION_KEY]: sessionSnapshot() });
  } catch (err) {
    console.warn('persistSession failed', err);
  }
}

/**
 * Restores the recording session from before reclaim when the SW wakes up.
 * The server resumes writing by sessionId (appendStep is an RPUSH append, not a full overwrite); here we only need to reconnect.
 */
async function restoreSession() {
  let raw;
  try {
    raw = await chrome.storage.session.get(SESSION_KEY);
  } catch {
    return;
  }
  const s = raw?.[SESSION_KEY];
  if (!s || !s.sessionId || !s.wsUrl || !s.token) return;
  if (sessionId) return; // a session already exists in this SW lifetime (start took over) — don't restore
  sessionId = s.sessionId;
  wsUrl = s.wsUrl;
  sessionToken = s.token;
  sessionMode = s.mode ?? 'fresh';
  sessionIncognito = !!s.incognito;
  webTabId = s.webTabId ?? null;
  recordingTabId = s.recordingTabId ?? null;
  recordingTabs.clear();
  for (const entry of s.recordingTabs ?? []) recordingTabs.set(entry[0], entry[1]);
  nextTabIndex = s.nextTabIndex ?? 1;
  paused = !!s.paused;
  stepCount = s.stepCount ?? 0;
  pendingSteps = Array.isArray(s.pending) ? s.pending : [];
  // The recording tab may already have been closed by the user: if it can't be found, recording is over — wrap up and clear the session.
  if (recordingTabId !== null) {
    const alive = await chrome.tabs.get(recordingTabId).then(() => true, () => false);
    if (!alive) recordingTabId = null;
  }
  if (recordingTabId === null) {
    sessionId = null;
    wsUrl = null;
    sessionToken = null;
    pendingSteps = [];
    await persistSession();
    return;
  }
  sessionLive = true;
  void reprobeFrames(); // SW revived: re-probe all frames of session tabs to rebuild the frame map (navigated-away frames are naturally absent)
  await openSocket();
  syncStepCount();
}

/**
 * After SW revival, re-probe all frames of session tabs to rebuild the frame map.
 * executeScript allFrames reads the DOM token attribute in each frame's isolated world (the DOM is shared across worlds),
 * fetching parent tokens along the way. Races between announce and the re-probe are handled by merge semantics — entries on both sides come from live frames.
 */
async function reprobeFrames() {
  const tabIds = [recordingTabId, ...recordingTabs.keys()].filter((id) => id !== null);
  for (const tabId of tabIds) {
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (attr) => {
          let parentToken = null;
          try { parentToken = window.parent === window ? null : window.parent.document.documentElement.getAttribute(attr); } catch { /* cross-origin */ }
          return { token: document.documentElement.getAttribute(attr), parentToken };
        },
        args: [FRAME_TOKEN_ATTR],
      });
    } catch {
      continue; // tab closed / not injectable: skip
    }
    const frames = frameMap.get(tabId) ?? new Map();
    for (const r of results ?? []) {
      if (r.result?.token) frames.set(r.result.token, { frameId: r.frameId, parentToken: r.result.parentToken ?? null });
    }
    if (frames.size > 0) frameMap.set(tabId, frames);
  }
}

// ---- Frame chain resolution: the frame a step came from → full FrameChain (top-down, outermost iframe first) ----

/**
 * Asks the child frame (frameId) for candidate locator chains of "this frame's host iframe element". recorder.js scans
 * the parent document inside the child frame and claims itself by contentWindow identity (see the locate-frame handler).
 * 3s timeout counts as failure.
 */
function locateFrameElement(tabId, frameId) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, 3000);
    chrome.tabs.sendMessage(
      tabId,
      { type: 'locate-frame' },
      { frameId },
      (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(chrome.runtime.lastError ? null : resp?.locators ?? null);
      },
    );
  });
}

/**
 * Resolves a frame's full frame chain. Bottom-up, asking the parent frame at each level for "candidates of that iframe
 * element within the parent", then reverses once the top is reached. Any level failing / exceeding the depth cap →
 * the whole chain is abandoned and null returned (prefer failure over wrong location: a wrong frame chain sends replay into the wrong document).
 */
async function resolveFrameChain(tabId, token) {
  const cacheKey = `${tabId}:${token}`;
  if (chainCache.has(cacheKey)) return chainCache.get(cacheKey);
  const frames = frameMap.get(tabId);
  const start = frames?.get(token);
  if (!frames || !start) return null;
  const levels = [];
  let cur = start;
  let curToken = token;
  let failed = false;
  let depth = 0;
  while (cur.parentToken && depth < CHAIN_MAX_DEPTH) {
    const parent = frames.get(cur.parentToken);
    if (!parent) { failed = true; break; }
    // Ask this frame (cur) for candidates of its host iframe element (recorder.js scans the parent document inside
    // the child frame and claims itself by contentWindow; the two routes for cross-frame element reads from isolated
    // worlds — parent reading child's contentDocument, child reading parent's frameElement — both dead ends, observed and confirmed).
    const locs = await locateFrameElement(tabId, cur.frameId);
    if (!locs || locs.length === 0) { failed = true; break; }
    levels.push({ locator: locs });
    curToken = cur.parentToken;
    cur = parent;
    depth += 1;
  }
  if (failed || (cur.parentToken && depth >= CHAIN_MAX_DEPTH)) {
    chainCache.set(cacheKey, null);
    return null;
  }
  const chain = levels.length > 0 ? levels.reverse() : null;
  chainCache.set(cacheKey, chain);
  return chain;
}

// ---- WS connection: drops lose no steps (queue → re-flush), auto-reconnect while the session lives ----

/**
 * Establishes (or re-establishes) the recording WS connection; returns whether this connection attempt succeeded.
 * A dropped connection discards nothing: pendingSteps stays in place and is re-flushed in order once reconnected.
 */
function openSocket() {
  if (!wsUrl || !sessionId || !sessionToken) return Promise.resolve(false);
  if (ws && ws.readyState === 1) return Promise.resolve(true); // already connected
  if (socketPromise) return socketPromise; // an attempt is in flight — await its result (don't open another)
  let sock;
  try {
    sock = new WebSocket(`${wsUrl}?sessionId=${sessionId}&token=${sessionToken}`);
  } catch (err) {
    console.warn('ws connect threw', err);
    return Promise.resolve(false);
  }
  ws = sock;
  const holder = { promise: null };
  const p = new Promise((resolve) => {
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      if (socketPromise === holder.promise) socketPromise = null;
      resolve(ok);
    };
    sock.onopen = () => {
      reconnectAttempt = 0;
      flushPending();
      settle(true);
    };
    sock.onclose = () => {
      // Only reconnect when the current connection dropped: a late close from an old session's socket must not trigger a new reconnect round
      if (ws === sock) {
        ws = null;
        if (sessionLive) scheduleReconnect();
      }
      settle(false);
    };
    sock.onerror = () => {
      // The real failure signal is the onclose that follows; here we only guarantee the promise always settles
      settle(false);
    };
  });
  holder.promise = p;
  socketPromise = p;
  return p;
}

/** Re-flushes queued steps in original order once the connection is usable. */
function flushPending() {
  if (!ws || ws.readyState !== 1 || pendingSteps.length === 0) return;
  const batch = pendingSteps;
  pendingSteps = [];
  for (let i = 0; i < batch.length; i++) {
    try {
      ws.send(JSON.stringify(batch[i]));
    } catch {
      pendingSteps = batch.slice(i).concat(pendingSteps);
      break;
    }
  }
  void persistSession();
}

/**
 * Sends one recording message to the server. Queued (not dropped) when the connection is unavailable — re-flushed in order after recovery.
 * Returns true = handed to WS; false = queued for sending (still counts as received by background).
 */
function sendOrQueue(payload) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      // Falls to the queue
    }
  }
  pendingSteps.push(payload);
  void persistSession();
  return false;
}

/** Reconnect on disconnect: exponential backoff (1s→2s→4s→8s→10s cap). The server resumes by the same sessionId; no new session needed. */
function scheduleReconnect() {
  if (reconnectTimer || !sessionId || !sessionLive) return;
  const delay = Math.min(10000, 1000 * 2 ** Math.min(reconnectAttempt, 4));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openSocket();
  }, delay);
}

/** Syncs the current step count to the in-page panel (after SW restore the panel counter may be stuck at an old value). */
function syncStepCount() {
  if (recordingTabId === null) return;
  chrome.tabs.sendMessage(recordingTabId, { type: 'step-count', count: stepCount }, () => void chrome.runtime.lastError);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every branch that depends on session state must await this before running — otherwise messages arriving during the
// restore window hit empty globals. Unregistering when there is no session must also be awaited inside the chain:
// a fire-and-forget unregister races start's registerFrameScript (the unregister callback reads the freshly registered
// entry late and deletes the new session's frame script registration — hit for real in diag2).
const ready = restoreSession()
  .catch((err) => {
    console.warn('restoreSession failed', err);
  })
  .then(async () => {
    // No session (or it expired): clear leftover frame script registration. A dormant frame script is harmless,
    // but there is no reason to keep one registered browser-wide.
    if (!sessionId) await unregisterFrameScript();
  });

// Re-inject the panel after each page load in recording tabs (main tab or adopted derived tabs):
// navigating the same tab to a new page destroys content scripts along with the document; without re-injection the panel is lost.
// recorder.js is NOT injected here — it is injected into all frames via the FRAME_SCRIPT_ID registration (incl. iframe/about:blank);
// once loaded it announces on its own and starts when the reply says recording:true. The start broadcast here is only the fallback
// handshake for frames that missed the announce retry window (broadcast to all frames, each responding on its own),
// and it syncs the current step count / paused state to the new panel instance.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void (async () => {
    // When the SW wakes up reclaimed, restore the session first (recordingTabId is null until restore completes);
    // must wait for restore to land before deciding — otherwise navigation inside the restore window misses re-injection
    // → that page never gets a content script again.
    await ready;
    if (recordingTabId === null) return;
    const isMain = tabId === recordingTabId;
    if (!isMain && !recordingTabs.has(tabId)) return;
    const tabIndex = isMain ? 0 : recordingTabs.get(tabId);
    chrome.scripting
      .executeScript({ target: { tabId }, files: ['content/panel.js'] })
      .then(() => {
        chrome.tabs.sendMessage(tabId, { type: 'start', mode: sessionMode, tabRef: `${sessionId}|tab#${tabIndex}` });
        chrome.tabs.sendMessage(tabId, { type: 'step-count', count: stepCount }, () => void chrome.runtime.lastError);
        if (paused) chrome.tabs.sendMessage(tabId, { type: 'pause' });
      })
      .catch(() => {});
  })();
});

chrome.tabs.onCreated.addListener((tab) => {
  if (recordingTabId === null || tab.openerTabId !== recordingTabId) return;
  const idx = nextTabIndex++;
  recordingTabs.set(tab.id, idx);
  void persistSession();
  // Report the tab-event
  sendOrQueue({
    type: 'tab-event',
    event: { kind: 'opened', tabRef: `${sessionId}|tab#${idx}`, title: tab.title || '', url: tab.url || '' },
  });
  // Adopt the new tab (injected by the global onUpdated listener once the page finishes loading)
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!recordingTabs.has(tabId)) return;
  const idx = recordingTabs.get(tabId);
  recordingTabs.delete(tabId);
  void persistSession();
  sendOrQueue({
    type: 'tab-event',
    event: { kind: 'closed', tabRef: `${sessionId}|tab#${idx}` },
  });
});

// ---- Console address config (popup writes chrome.storage.sync; when non-default, bridge injection is registered dynamically) ----

const BRIDGE_SCRIPT_ID = 'ita-bridge-dynamic';

async function getConsoleOrigin() {
  try {
    const { consoleOrigin } = await chrome.storage.sync.get('consoleOrigin');
    return consoleOrigin || DEFAULT_CONSOLE_ORIGIN;
  } catch {
    return DEFAULT_CONSOLE_ORIGIN;
  }
}

// manifest static registration only injects the bridge for localhost; when the console is set to another address,
// register dynamically here (unregister first, then register — idempotent).
// Top-level SW execution is the fallback: extension updates clear dynamic registrations.
async function syncBridgeRegistration() {
  try {
    const origin = await getConsoleOrigin();
    const existing = await chrome.scripting.getRegisteredContentScripts();
    if (existing.some((s) => s.id === BRIDGE_SCRIPT_ID)) {
      await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
    }
    if (origin !== DEFAULT_CONSOLE_ORIGIN) {
      await chrome.scripting.registerContentScripts([{
        id: BRIDGE_SCRIPT_ID,
        matches: [originToMatchPattern(origin)],
        js: ['content/bridge.js'],
        runAt: 'document_start',
        persistAcrossSessions: true,
      }]);
    }
  } catch (err) {
    console.warn('syncBridgeRegistration failed', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  syncBridgeRegistration();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.consoleOrigin) syncBridgeRegistration();
});
syncBridgeRegistration();

// ---- Recording frame script registration: inject recorder.js into all frames of <all_urls> for the session duration ----
// Imperative executeScript only reaches the top-level document; recording inside iframes is only possible via registered
// all-frames injection. about:blank/srcdoc are covered by matchOriginAsFallback (webNavigation doesn't fire for them and
// carrying it triggered install warnings — dropped).
// The recorder.js that loads is dormant: if the announce reply says recording:false it never loads the heavy modules.
// Leftover registrations are harmless in themselves, but they are still registered/unregistered per session lifecycle,
// so the whole browser doesn't carry one extra injected script for nothing.
async function registerFrameScript() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    if (existing.some((s) => s.id === FRAME_SCRIPT_ID)) return;
    await chrome.scripting.registerContentScripts([{
      id: FRAME_SCRIPT_ID,
      matches: ['<all_urls>'],
      js: ['content/recorder.js'],
      allFrames: true,
      // matchOriginAsFallback (119+): injects into opaque-origin frames like about:blank/srcdoc too
      // (registerContentScripts has no matchAboutBlank key — passing it fails the whole registration)
      matchOriginAsFallback: true,
      runAt: 'document_idle',
    }]);
  } catch (err) {
    console.warn('registerFrameScript failed', err);
  }
}

async function unregisterFrameScript() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    if (existing.some((s) => s.id === FRAME_SCRIPT_ID)) {
      await chrome.scripting.unregisterContentScripts({ ids: [FRAME_SCRIPT_ID] });
    }
  } catch (err) {
    console.warn('unregisterFrameScript failed', err);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Frame script announce handshake: registers the frame mapping and replies with session state; frames whose reply is recording:false stay dormant without loading heavy modules.
  if (msg.type === 'frame-announce') {
    void (async () => {
      await ready;
      const tabId = sender.tab?.id;
      const frameId = sender.frameId ?? 0;
      if (tabId === undefined || !sessionId) { sendResponse({ recording: false }); return; }
      const isMain = tabId === recordingTabId;
      if (!isMain && !recordingTabs.has(tabId)) { sendResponse({ recording: false }); return; }
      let frames = frameMap.get(tabId);
      if (!frames) { frames = new Map(); frameMap.set(tabId, frames); }
      frames.set(msg.token, { frameId, parentToken: msg.parentToken ?? null });
      const tabIndex = isMain ? 0 : recordingTabs.get(tabId);
      sendResponse({ recording: true, mode: sessionMode, tabRef: `${sessionId}|tab#${tabIndex}`, paused, stepCount });
    })();
    return true;
  }

  if (msg.type === 'start' && msg.session) {
    void (async () => {
      await ready;
      // New session takes over: kill the previous round's connection (e.g. one restored by the SW) so two connections never co-write the same extension
      sessionLive = false;
      const staleSock = ws;
      ws = null;
      socketPromise = null;
      if (staleSock) { try { staleSock.close(); } catch { /* ignore */ } }
      const { wsUrl: url, sessionId: sid, mode, incognito, token } = msg.session;
      sessionId = sid;
      wsUrl = url;
      sessionToken = token;
      sessionMode = mode || 'fresh';
      sessionIncognito = !!incognito;
      stepCount = 0;
      paused = false;
      pendingSteps = [];
      sessionLive = false;
      webTabId = sender.tab?.id ?? null;
      frameMap.clear();
      chainCache.clear();
      pickState = null;
      await persistSession();
      const ok = await openSocket();
      if (!ok) {
        // First connect failed: old behavior — error out, no recording page created, no session left for restore
        sessionId = null;
        wsUrl = null;
        sessionToken = null;
        await persistSession();
        sendResponse({ ok: false, error: 'ws failed' });
        return;
      }
      sessionLive = true;
      // Register the frame script before opening the page: target page frames can be injected and announce from load time
      await registerFrameScript();
      await persistSession();
      const createOpts = { url: msg.targetUrl };
      if (sessionIncognito) createOpts.incognito = true;
      chrome.tabs.create(createOpts, (tab) => {
        recordingTabId = tab.id;
        nextTabIndex = 1;
        void persistSession();
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'step') {
    void (async () => {
      await ready;
      if (!sessionId) {
        // No active session: this step has nowhere to go — reply failure explicitly so popup/panel show failure instead of a false success
        sendResponse({ ok: false, error: chrome.i18n.getMessage('notRecording') });
        return;
      }
      const dsl = msg.dsl ?? toDSL(msg.step);
      // iframe frame chain: when the step comes from a frame script it carries a token; resolve that frame's full chain and attach it to the DSL.
      // Resolution failure (cross-origin / too deep / unregistered) records without a chain per policy — prefer failure over wrong location.
      if (msg.token && sender?.tab && !('frameChain' in dsl)) {
        const chain = await resolveFrameChain(sender.tab.id, msg.token);
        if (chain) dsl.frameChain = chain;
      }
      const url = msg.step?.url ?? msg.url ?? null;
      const tabRef = msg.step?.tabRef ?? msg.tabRef ?? `${sessionId}|tab#0`;
      const componentKind = msg.step?.componentKind ?? null;
      sendOrQueue({ type: 'step', step: { action: dsl, url, tabRef, componentKind } });
      stepCount++;
      await persistSession();
      syncStepCount();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'emit-step') {
    void (async () => {
      await ready;
      if (!sessionId) {
        sendResponse({ ok: false, error: chrome.i18n.getMessage('notRecording') });
        return;
      }
      // Steps generated inline in the panel (assert/save-variable/AI/hover): frameChain was already attached to the dsl by bg
      // at pick race time; no resolution here. The panel only exists in the main tab, so tabRef is fixed to tab#0.
      sendOrQueue({ type: 'step', step: { action: msg.dsl, url: msg.url ?? null, tabRef: `${sessionId}|tab#0`, componentKind: null } });
      stepCount++;
      await persistSession();
      syncStepCount();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'set-options') {
    void (async () => {
      await ready;
      if (recordingTabId === null) { sendResponse({ ok: false, error: chrome.i18n.getMessage('notRecordingTab') }); return; }
      // Broadcast to every tab in the session: each frame's manager must receive the latest recording options
      for (const tid of [recordingTabId, ...recordingTabs.keys()]) {
        chrome.tabs.sendMessage(tid, { type: 'set-options', options: msg.options ?? {} }, () => void chrome.runtime.lastError);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'switch-tab') {
    void (async () => {
      await ready;
      if (recordingTabs.has(msg.tabId) || msg.tabId === recordingTabId) {
        chrome.tabs.update(msg.tabId, { active: true });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'tab not in session' });
      }
    })();
    return true;
  }

  if (msg.type === 'stop') {
    void (async () => {
      await ready;
      const stopTab = async () => {
        if (recordingTabId !== null) {
          chrome.tabs.sendMessage(recordingTabId, { type: 'stop' }, () => void chrome.runtime.lastError);
          recordingTabId = null;
        }
        recordingTabs.clear();
        paused = false;
        sessionId = null;
        wsUrl = null;
        sessionToken = null;
        pendingSteps = [];
        sessionLive = false;
        stepCount = 0;
        frameMap.clear();
        chainCache.clear();
        pickState = null;
        await unregisterFrameScript(); // session over: retract the all-frames script registration (dormant script is harmless, but shouldn't persist; await prevents a race with the next start's registration)
        await persistSession(); // sessionId cleared → also clears the session record in storage.session
        // Stop initiated from the panel/popup: notify the web console to wrap up (finish the session, reset state)
        if (msg.from === 'panel' && webTabId !== null) {
          chrome.tabs.sendMessage(webTabId, { type: 'recording-stopped' }, () => void chrome.runtime.lastError);
        }
      };
      /** Best-effort delivery of queued steps before stopping: one reconnect + flush; if it can't be delivered, log a warning instead of dropping silently. */
      const flushBeforeStop = async () => {
        if (pendingSteps.length === 0) return;
        const ok = await Promise.race([openSocket(), sleep(2000).then(() => false)]);
        if (ok) flushPending();
        if (pendingSteps.length > 0) {
          console.warn('stop: 仍有步骤未送达服务端', pendingSteps.length);
        }
        const tmp = ws; // the temporary connection used for the flush is discarded right after
        ws = null;
        if (tmp && tmp.readyState <= 1) { try { tmp.close(); } catch { /* ignore */ } }
      };
      const sock = ws;
      ws = null;
      if (sock && sock.readyState === 1) {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          void stopTab().then(() => sendResponse({ ok: true }));
        };
        sock.onclose = () => done();
        try {
          flushPending();
          sock.send(JSON.stringify({ type: 'finish' }));
        } catch {
          // Connection already dead: same handling as below — best-effort flush of queued steps, then wrap up
          void flushBeforeStop().then(done);
        }
        setTimeout(() => { try { sock.close(); } catch {} done(); }, 3000);
      } else {
        await flushBeforeStop();
        await stopTab();
        sendResponse({ ok: true });
      }
    })();
    return true;
  }

  if (msg.type === 'open-console') {
    void (async () => {
      await ready;
      // Open the console: prefer switching back to the case detail tab that started the recording (focusing its window too);
      // with no session or a closed tab, open the console home page instead.
      // No sendResponse: focusing the target window immediately closes the popup, killing the callback.
      const fallback = () => getConsoleOrigin().then((origin) => chrome.tabs.create({ url: `${origin}/` }));
      if (webTabId === null) { fallback(); return; }
      chrome.tabs
        .get(webTabId)
        .then((tab) => {
          chrome.tabs.update(tab.id, { active: true });
          chrome.windows.update(tab.windowId, { focused: true });
        })
        .catch(fallback);
    })();
    return true;
  }

  if (msg.type === 'get-state') {
    void (async () => {
      await ready;
      sendResponse({
        recording: recordingTabId !== null,
        paused,
        mode: sessionMode,
        stepCount,
        tabs: Array.from(recordingTabs.entries()).map(([id, idx]) => ({ tabId: id, tabRef: `${sessionId}|tab#${idx}` })),
      });
    })();
    return true;
  }

  if (msg.type === 'pause' || msg.type === 'resume') {
    void (async () => {
      await ready;
      paused = msg.type === 'pause';
      await persistSession();
      if (recordingTabId !== null) chrome.tabs.sendMessage(recordingTabId, { type: msg.type }, () => void chrome.runtime.lastError);
      sendResponse({ recording: recordingTabId !== null, paused });
    })();
    return true;
  }

  if (msg.type === 'pick-start' || msg.type === 'pick-result' || msg.type === 'pick-cancel') {
    void (async () => {
      await ready;
      // Element pick (event-driven, 0.1.0): panel sends pick-start{pickId} → bg broadcasts pick-start to all frames,
      // the clicked frame replies pick-result{pickId, token, result}, first one wins: bg attaches the frame chain,
      // broadcasts pick-stop to wrap up the remaining frames, and forwards the result to the panel; late results from
      // other frames are swallowed once the race is decided.
      if (msg.type === 'pick-start') {
        if (recordingTabId === null) { sendResponse({ ok: false, error: chrome.i18n.getMessage('notRecordingTab') }); return; }
        const pickId = ++pickSeq;
        pickState = { pickId, resolved: false, panelTabId: sender.tab?.id ?? recordingTabId };
        for (const tid of [recordingTabId, ...recordingTabs.keys()]) {
          chrome.tabs.sendMessage(tid, { type: 'pick-start', pickId }, () => void chrome.runtime.lastError);
        }
        sendResponse({ ok: true, pickId });
        return;
      }
      if (msg.type === 'pick-result') {
        if (!pickState || pickState.resolved || msg.pickId !== pickState.pickId) return; // loser / stale result: swallow
        pickState.resolved = true;
        const result = msg.result ?? { canceled: true };
        // Broadcast wrap-up first (remaining frames exit pick mode and resume capture), then resolve the frame chain
        // (independent of per-frame pick state), finally forward to the panel
        for (const tid of [recordingTabId, ...recordingTabs.keys()].filter((id) => id !== null)) {
          chrome.tabs.sendMessage(tid, { type: 'pick-stop' }, () => void chrome.runtime.lastError);
        }
        if (!result.canceled && msg.token && sender.tab) {
          const chain = await resolveFrameChain(sender.tab.id, msg.token);
          if (chain) result.frameChain = chain;
        }
        const panelTabId = pickState.panelTabId;
        pickState = null;
        chrome.tabs.sendMessage(panelTabId, { type: 'pick-result', pickId: msg.pickId, result }, () => void chrome.runtime.lastError);
        return;
      }
      // pick-cancel: panel timeout fallback (bg silent / user never clicks), settled as canceled
      pickState = null;
      for (const tid of [recordingTabId, ...recordingTabs.keys()].filter((id) => id !== null)) {
        chrome.tabs.sendMessage(tid, { type: 'pick-stop' }, () => void chrome.runtime.lastError);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});
