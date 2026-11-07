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

// ---- iframe 帧链（同源 iframe 录制，0.1.0）----
// 帧映射：tabId → Map<token, {frameId, parentToken}>。帧脚本 announce 时登记；
// SW 复活后按会话内 tab 重探全帧重建（reprobeFrames，DOM 令牌属性各 world 共享读得到）。
const frameMap = new Map();
/** 帧链解析缓存：`${tabId}:${token}` → FrameChain|null。null = 跨源/shadow 内嵌 iframe 等
 *  结构性失败，缓存避免每步重试；帧导航换文档会换新 token，缓存天然失效。 */
const chainCache = new Map();
const FRAME_TOKEN_ATTR = 'data-ita-frame-token';
const CHAIN_MAX_DEPTH = 5;
const FRAME_SCRIPT_ID = 'ita-recorder-frames';
/** 在途的元素拾取（panel pick-start 起一处）：{pickId, resolved, panelTabId}。首个 pick-result 竞胜。 */
let pickState = null;
let pickSeq = 0;

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
  if (step.type === 'scroll') return { kind: 'scroll', locator: step.target, scrollTop: step.scrollTop ?? 0, scrollLeft: step.scrollLeft ?? 0, ...intentField(step) };
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
  // dblclick 升级产物：2=双击 3=三连击（缺省单击不带字段）
  if (dsl.kind === 'click' && (step.clickCount === 2 || step.clickCount === 3)) dsl.clickCount = step.clickCount;
  return dsl;
}

/** 把 recorder 端附带的 intentLocator 透传到 DSL——回放侧用它当 data-testid / name 的语义锚。 */
function intentField(step) {
  return step.intentLocator ? { intentLocator: step.intentLocator } : {};
}

// ---- 会话持久化 ----

/** 当前会话快照：SW 被回收后据此恢复（不含 ws 实例本身）。
 *  帧映射不入快照：restoreSession 后 reprobeFrames 全帧重探重建，比持久化快照更权威
 *  （SW 死亡期间导航过的帧 token 已换新，持久化条目反而是陈旧的）。 */
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
  void reprobeFrames(); // SW 复活：重探会话内所有 tab 的全帧重建帧映射（导航过期帧自然缺席）
  await openSocket();
  syncStepCount();
}

/**
 * SW 复活后重探会话内所有 tab 的全帧，重建帧映射。
 * executeScript allFrames 在各帧 isolated world 里读 DOM 令牌属性（各 world 共享 DOM），
 * 父令牌一并取回。announce 与重探的竞态按合并口径处理——两边条目都来自活帧。
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
          try { parentToken = window.parent === window ? null : window.parent.document.documentElement.getAttribute(attr); } catch { /* 跨源 */ }
          return { token: document.documentElement.getAttribute(attr), parentToken };
        },
        args: [FRAME_TOKEN_ATTR],
      });
    } catch {
      continue; // tab 已关/无法注入：跳过
    }
    const frames = frameMap.get(tabId) ?? new Map();
    for (const r of results ?? []) {
      if (r.result?.token) frames.set(r.result.token, { frameId: r.frameId, parentToken: r.result.parentToken ?? null });
    }
    if (frames.size > 0) frameMap.set(tabId, frames);
  }
}

// ---- 帧链解析：步骤所在帧 → 完整 FrameChain（自顶向下，最外层 iframe 在前）----

/**
 * 向子帧（frameId）要「本帧的宿主 iframe 元素」候选定位链。recorder.js 在子帧里扫父文档、
 * 按 contentWindow 身份认领自己（详见 locate-frame 处理器）。3s 超时按失败计。
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
 * 解析某帧的完整帧链。自底向上逐级向父帧要「该 iframe 元素在父帧中的候选」，走满到顶层后反转。
 * 任一级失败/超过深度上限 → 整链放弃返回 null（宁失败不误定位：错误帧链会把回放打进错误的文档）。
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
    // 问本帧（cur）要它的宿主 iframe 元素候选（recorder.js 在子帧里扫父文档按
    // contentWindow 认领自己；隔离世界跨帧读元素的两条路——父读子 contentDocument、
    // 子读父 frameElement——都走不通，实测确认）。
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
// 无会话时的注册清理必须 await 在链内：fire-and-forget 的注销会和 start 的 registerFrameScript
// 竞态（注销回调晚读到已注册好的表项，把新会话的帧脚本注册删掉——diag2 实测踩中）。
const ready = restoreSession()
  .catch((err) => {
    console.warn('restoreSession failed', err);
  })
  .then(async () => {
    // 会话不存在（或已失效）：清掉残留的帧脚本注册。休眠帧脚本无害，但没必要常驻全浏览器。
    if (!sessionId) await unregisterFrameScript();
  });

// 录制中的 tab（主 tab 或接管的派生 tab）每次页面加载完成后重注入 panel：
// 同 tab 跳转新页面时内容脚本随文档销毁，不重注入面板会丢失。
// recorder.js 不在这里注入——它由 FRAME_SCRIPT_ID 注册式全帧注入（含 iframe/about:blank），
// 装载后自行 announce，回执 recording:true 即启动；这里的 start 广播只是错过 announce
// 重试窗口的帧的兜底握手（广播到全帧，每帧各自响应），并把当前步数/暂停态同步给新面板实例。
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

// ---- 录制帧脚本注册：会话期间对 <all_urls> 全帧注入 recorder.js ----
// 命令式 executeScript 只能打顶层文档，iframe 内的录制只能靠注册式全帧注入；
// about:blank/srcdoc 由 matchAboutBlank 覆盖（webNavigation 对它们不触发且带安装警告，弃用）。
// 装进来的 recorder.js 是休眠态的：announce 回执 recording:false 就不装载重模块，
// 残留注册本身无害，但仍按会话生命周期注册/注销，不让全浏览器平白多注入一份脚本。
async function registerFrameScript() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    if (existing.some((s) => s.id === FRAME_SCRIPT_ID)) return;
    await chrome.scripting.registerContentScripts([{
      id: FRAME_SCRIPT_ID,
      matches: ['<all_urls>'],
      js: ['content/recorder.js'],
      allFrames: true,
      // matchOriginAsFallback（119+）：about:blank/srcdoc 等不透明源帧也注入
      // （registerContentScripts 没有 matchAboutBlank 这个键——传了会整条注册报错）
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
  // 帧脚本 announce 握手：登记帧映射，回执会话态；recording:false 的帧保持休眠不装载重模块。
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
      frameMap.clear();
      chainCache.clear();
      pickState = null;
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
      // 先落帧脚本注册再开页：目标页的帧从加载起就能注入并 announce
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
        // 没有活动会话：这一步无处可去，明确回失败——弹窗/面板据此显示失败而不是假成功
        sendResponse({ ok: false, error: chrome.i18n.getMessage('notRecording') });
        return;
      }
      const dsl = msg.dsl ?? toDSL(msg.step);
      // iframe 帧链：步骤来自帧脚本时带 token，解析该帧的完整链附进 DSL；
      // 解析失败（跨源/超深/未登记）按无链政策照录——宁失败不误定位。
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
      // 面板内联生成的步骤（断言/存变量/AI/悬停）：frameChain 已在拾取竞胜时由 bg 附进 dsl，
      // 这里不再解析；panel 只在主 tab 存在，tabRef 固定 tab#0。
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
      // 广播到会话内所有 tab：每个帧的 manager 都要拿到最新录制选项
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
        await unregisterFrameScript(); // 会话结束：撤掉全帧脚本注册（休眠脚本无害，但不常驻；await 防与下次 start 的注册竞态）
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

  if (msg.type === 'pick-start' || msg.type === 'pick-result' || msg.type === 'pick-cancel') {
    void (async () => {
      await ready;
      // 元素拾取（事件驱动，0.1.0）：panel 发 pick-start{pickId} → bg 广播全帧 pick-start，
      // 被点击帧回 pick-result{pickId, token, result}，首个竞胜：bg 附帧链、广播 pick-stop
      // 收尾其余帧、把结果转发给面板；其余帧的迟到结果按已竞胜吞掉。
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
        if (!pickState || pickState.resolved || msg.pickId !== pickState.pickId) return; // 败者/过期结果：吞掉
        pickState.resolved = true;
        const result = msg.result ?? { canceled: true };
        // 先广播收尾（其余帧退出拾取、恢复捕获），再解析帧链（与帧拾取状态无关），最后转发面板
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
      // pick-cancel：面板超时兜底（bg 零响应/用户一直不点），按取消收场
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
