import { DEFAULT_CONSOLE_ORIGIN, originToMatchPattern } from './modules/console-config.js';

let ws = null;
let recordingTabId = null;
let paused = false;
let sessionMode = 'fresh';
let sessionIncognito = false;
let sessionId = null;
// 录制步骤计数：推送给页面内控制面板（content/panel.js）展示
let stepCount = 0;
// 发起录制的 web 中台标签页（用例详情页）：面板/弹窗停止录制后通知其收尾；
// 停止后保留指向，供「打开中台」切回用例详情页，下次 start 覆盖
let webTabId = null;
// tab 路由：opener 派生 tab 的 tabIndex；tab #0 是主 tab
const recordingTabs = new Map(); // tabId -> tabIndex
let nextTabIndex = 1;

// ---- 录制会话持久化（MV3 的 service worker 会被 Chrome 回收）----
// 回收后上面这些内存全局全部清零，而页面里的面板还活着 → 后续步骤全落在 WS 闸门上被丢弃，
// 面板计数器冻在最后一步，用户看着像「在录」实则全丢（b0dbb886 同族症状）。
// 会话状态写进 chrome.storage.session：浏览器会话级内存存储，只有扩展自身可读
// （token 因此不落 sync），SW 被回收再醒来时按同 sessionId 重连——
// 服务端会话在 Redis 存 1h、步骤走 RPUSH 追加，重连即续写不覆盖。
const SESSION_KEY = 'recordingSession';
let wsUrl = null;
let sessionToken = null;
/** 未送出的步骤载荷：ws 非 OPEN 时入队而不是丢弃，连接恢复后按序补发。 */
let pendingSteps = [];
/** 本次录制是否成功连上过：只有连上过的会话才做断线重连（首次连接失败仍是老行为：直接报错、不建页）。 */
let sessionLive = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
/** 在途的连接尝试（openSocket 返回给调用方的那个 promise）：避免重复开连接，也让调用方能等到「真的连上」。 */
let socketPromise = null;

function toDSL(step) {
  if (step.type === 'check') return { kind: 'check', locator: step.target, checked: !!step.checked, ...intentField(step) };
  if (step.type === 'select') return { kind: 'select', locator: step.target, value: step.value ?? '', ...intentField(step) };
  if (step.type === 'upload') {
    // 上传步骤 fileId 由 web 端绑定；此处只占位
    return { kind: 'upload', locator: step.target, fileId: '__pending__', ...intentField(step) };
  }
  const dsl = { kind: step.type, locator: step.target, ...intentField(step) };
  if (dsl.kind === 'fill') {
    dsl.value = step.value ?? '';
    if (step.sensitive) dsl.sensitive = true;
  }
  if (dsl.kind === 'press') dsl.key = step.key ?? 'Enter';
  if (dsl.kind === 'aiTask') dsl.instruction = step.value ?? '';
  return dsl;
}

/** 把 recorder 端附带的 intentLocator 透传到 DSL——回放侧用它当 data-testid / name 的语义锚。 */
function intentField(step) {
  return step.intentLocator ? { intentLocator: step.intentLocator } : {};
}

// ---- 会话持久化 ----

/** 当前会话快照：SW 被回收后据此恢复（不含 ws 实例本身）。 */
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

/** 落盘会话快照。无会话时清掉残留记录（SW 回收期间 stop 过、或首次连接失败）。 */
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
 * SW 醒来时恢复被回收前的录制会话。
 * 服务端按 sessionId 续写（appendStep 是 RPUSH 追加，不整包覆盖），这里只需把连接接回去。
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
  if (sessionId) return; // 本 SW 生命周期内已有会话（start 已接手），不恢复
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
  // 录制标签页可能已被用户关掉：查不到就说明录制已结束，收尾清会话。
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
  await openSocket();
  syncStepCount();
}

// ---- WS 连接：断开不丢步（入队 → 补发），会话存续期内自动重连 ----

/**
 * 建立（或重建）录制 WS 连接，返回本次连接尝试是否成功。
 * 连接断开不丢弃任何东西：pendingSteps 原地保留，重连成功后按序补发。
 */
function openSocket() {
  if (!wsUrl || !sessionId || !sessionToken) return Promise.resolve(false);
  if (ws && ws.readyState === 1) return Promise.resolve(true); // 已连上
  if (socketPromise) return socketPromise; // 连接尝试在途，等它的结果（别再开一条）
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
      // 只有当前连接掉了才重连：旧会话的连接晚到的 close 不该带起新一轮重连
      if (ws === sock) {
        ws = null;
        if (sessionLive) scheduleReconnect();
      }
      settle(false);
    };
    sock.onerror = () => {
      // 真正的失败信号是随后的 onclose；这里只保证 promise 一定收敛
      settle(false);
    };
  });
  holder.promise = p;
  socketPromise = p;
  return p;
}

/** 连接可用时把排队的步骤按原序补发。 */
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
 * 送一条录制消息到服务端。连接不可用时入队（不丢弃）——连接恢复后按序补发。
 * 返回 true = 已交给 WS；false = 已入队待发（仍算后台接收成功）。
 */
function sendOrQueue(payload) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      // 落到队列
    }
  }
  pendingSteps.push(payload);
  void persistSession();
  return false;
}

/** 断线重连：指数退避（1s→2s→4s→8s→10s 封顶）。服务端按同 sessionId 续写，无需新会话。 */
function scheduleReconnect() {
  if (reconnectTimer || !sessionId || !sessionLive) return;
  const delay = Math.min(10000, 1000 * 2 ** Math.min(reconnectAttempt, 4));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openSocket();
  }, delay);
}

/** 把当前步数同步给页面内面板（SW 恢复后面板的计数可能停在旧值）。 */
function syncStepCount() {
  if (recordingTabId === null) return;
  chrome.tabs.sendMessage(recordingTabId, { type: 'step-count', count: stepCount }, () => void chrome.runtime.lastError);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 恢复完成前所有依赖会话状态的分支都要先等它——否则恢复窗口内的消息会打到空的全局上。
const ready = restoreSession().catch((err) => {
  console.warn('restoreSession failed', err);
});

// 录制中的 tab（主 tab 或接管的派生 tab）每次页面加载完成后重注入 recorder/panel：
// 同 tab 跳转新页面时内容脚本随文档销毁，不重注入则录制与面板都会丢失。
// 注入后重发 start 握手，并把当前步数/暂停态同步给全新的面板实例。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void (async () => {
    // SW 被回收后醒来时先恢复会话（恢复完成前 recordingTabId 是 null），
    // 这里必须等恢复落地再判断，否则恢复窗口内的导航会漏掉重注入 → 该页从此没有 content script。
    await ready;
    if (recordingTabId === null) return;
    const isMain = tabId === recordingTabId;
    if (!isMain && !recordingTabs.has(tabId)) return;
    const tabIndex = isMain ? 0 : recordingTabs.get(tabId);
    chrome.scripting
      .executeScript({ target: { tabId }, files: ['content/recorder.js', 'content/panel.js'] })
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
  // 上报 tab-event
  sendOrQueue({
    type: 'tab-event',
    event: { kind: 'opened', tabRef: `${sessionId}|tab#${idx}`, title: tab.title || '', url: tab.url || '' },
  });
  // 接管新 tab（页面加载完成后由全局 onUpdated 监听器注入）
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

// ---- 中台地址配置（popup 写 chrome.storage.sync，非默认时动态注册 bridge 注入）----

const BRIDGE_SCRIPT_ID = 'ita-bridge-dynamic';

async function getConsoleOrigin() {
  try {
    const { consoleOrigin } = await chrome.storage.sync.get('consoleOrigin');
    return consoleOrigin || DEFAULT_CONSOLE_ORIGIN;
  } catch {
    return DEFAULT_CONSOLE_ORIGIN;
  }
}

// manifest 静态只注入 localhost 的 bridge；中台配成其他地址时在此动态注册（先注销再注册，幂等）。
// SW 顶层执行是兜底：扩展更新会清空动态注册。
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

/** 面板窗口初高（各模式内容实际高度）：断言/悬停只有标题+一行提示，变量/AI 模式带表单。 */
const PANEL_INITIAL_HEIGHT = { assert: 130, hover: 130, variable: 240, ai: 240 };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start' && msg.session) {
    void (async () => {
      await ready;
      // 新会话接管：掐掉上一轮连接（如 SW 恢复出来的），避免两条连接并存写同一个扩展
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
      await persistSession();
      const ok = await openSocket();
      if (!ok) {
        // 首次连不上：老行为——报错、不建录制页，也不留待恢复的会话
        sessionId = null;
        wsUrl = null;
        sessionToken = null;
        await persistSession();
        sendResponse({ ok: false, error: 'ws failed' });
        return;
      }
      sessionLive = true;
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
        // 没有活动会话：这一步无处可去，明确回失败——弹窗/面板据此显示失败而不是假成功
        sendResponse({ ok: false, error: chrome.i18n.getMessage('notRecording') });
        return;
      }
      const dsl = msg.dsl ?? toDSL(msg.step);
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
        await persistSession(); // sessionId 已清 → 顺带清掉 storage.session 里的会话记录
        // 面板/弹窗发起的停止：通知 web 中台收尾（finish 会话、复位状态）
        if (msg.from === 'panel' && webTabId !== null) {
          chrome.tabs.sendMessage(webTabId, { type: 'recording-stopped' }, () => void chrome.runtime.lastError);
        }
      };
      /** 停止前把排队的步骤尽力送出去：重连一次 + flush；补不上就记警告，而不是静默丢。 */
      const flushBeforeStop = async () => {
        if (pendingSteps.length === 0) return;
        const ok = await Promise.race([openSocket(), sleep(2000).then(() => false)]);
        if (ok) flushPending();
        if (pendingSteps.length > 0) {
          console.warn('stop: 仍有步骤未送达服务端', pendingSteps.length);
        }
        const tmp = ws; // 补发用的临时连接用完即弃
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
          // 连接已断：与下面同款处理——尽力补发排队步骤后收尾
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
      // 打开中台：优先切回发起录制的用例详情页 tab（含窗口前置）；无会话或 tab 已关则新开中台首页。
      // 不回 sendResponse：目标窗口前置会立即关闭 popup，回调随之失效。
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

  if (msg.type === 'open-panel') {
    // 页面内控制面板的功能按钮：打开对应模式的录制面板窗口（与 action 弹窗同一路径）
    // 高度只是初值：断言/悬停模式只有一行提示（断言改为选中即生成后不再有表单），
    // 固定 420 会让窗口下方留一大片空白。panel.js 载入后按实际内容高度再收敛一次。
    const height = PANEL_INITIAL_HEIGHT[msg.mode] ?? 220;
    chrome.windows.create(
      {
        url: chrome.runtime.getURL(`popup/panel.html?mode=${msg.mode}`),
        type: 'popup',
        width: 360,
        height,
      },
      (win) => {
        // 置顶：拾取断言元素要点击被测页面，本窗口随之失焦；不置顶会被被测系统窗口盖住，
        // 「已生成步骤 ✓」的结果用户根本看不到。
        if (win) chrome.windows.update(win.id, { alwaysOnTop: true });
      },
    );
    return;
  }

  if (msg.type === 'pick' || msg.type === 'emit-step' || msg.type === 'set-options') {
    void (async () => {
      await ready;
      if (recordingTabId === null) { sendResponse({ ok: false, error: chrome.i18n.getMessage('notRecordingTab') }); return; }
      chrome.tabs.sendMessage(recordingTabId, msg, (resp) => sendResponse(resp ?? { ok: false }));
    })();
    return true;
  }

  return false;
});
