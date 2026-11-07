(async () => {
  // 注入幂等守卫：录制器现在通过 scripting.registerContentScripts（全帧注入，见 background.js
  // FRAME_SCRIPT_ID）进入文档，background 不再对录制 tab 命令式注入本文件；守卫保留为兜底。
  // 同一份真实点击不应被 N 份独立监听各收一次：每份有自己的 onClick 闭包与独立 200ms 去重窗口，
  // 互不感知，一次点击会产出 N 条逐字节相同的步骤（2026-10-15 病例：2/2/5/4 的连续重复）。
  // 真实导航会销毁文档与副本，守卫随 isolated world 一起重置，不会误挡合法的重注入。
  if (globalThis.__itaRecorder) return;
  // 守卫值同步置位（口径同前）。轻量层（令牌落属性 + announce 监听）立即装好；
  // 重模块（manager/picker）下沉到 bootstrap——announce 回执 recording:false 的帧保持休眠
  // 零开销（本文件经全帧注册常驻所有 tab，休眠路径不能 import 重模块）。
  globalThis.__itaRecorder = 'loading';

  // ---- 帧令牌（iframe 帧链的地基）----
  // 写进 DOM 属性而不是 window 变量：各 isolated world 互不可见，但 DOM 是各 world 共享的——
  // 父帧的 recorder.js 实例（另一个 world）才能读到子帧的 token，background 的 SW 复活重探也读得到。
  // 跨源父帧读 parent.document 会抛异常 → parentToken=null → 该帧按无链政策录制。
  const TOKEN_ATTR = 'data-ita-frame-token';
  // crypto.randomUUID 只在 secure context 有（http 内网系统如 192.168.x 没有这个 API），要兜底
  const token = crypto.randomUUID
    ? crypto.randomUUID()
    : `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  document.documentElement.setAttribute(TOKEN_ATTR, token);

  let bootstrapped = false; // 重模块已装载并接管监听
  let started = false; // manager.start 已调用（会话恢复进暂停态时不启动，resume 消息才启动）
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
    // 带回调消费后台的接收结果：后台确认「已送达服务端或已入队待发」才算这步到手。
    // 回调只用于吞掉响应（避免 message port closed 告警），失败不重试——
    // 不可接收时后台会回失败，弹窗路径据此显示，录制路径只能靠面板计数器观察。
    // token 供 background 解析本帧的 frameChain（iframe 帧链）。
    chrome.runtime.sendMessage({ type: 'step', step, tabRef: currentTabRef, token }, () => void chrome.runtime.lastError);
  };
  const startCapture = () => {
    if (started) return;
    started = true;
    manager.start(sendStep, panelOptions);
  };

  /** 装载重模块并接管录制。reply：frame-announce 的回执（recording:true 时必达）。 */
  const bootstrap = async (reply) => {
    if (bootstrapped) return;
    bootstrapped = true;
    let mod;
    let pickerMod;
    try {
      mod = await import(chrome.runtime.getURL('modules/recorder-manager.js'));
      pickerMod = await import(chrome.runtime.getURL('modules/picker.js'));
    } catch (e) {
      // 产物损坏时把 bootstrapped 退回，下次 start 广播还能再试
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
        // manager.start 复位 paused，与 resume 同语义（bg 在重注入后广播，紧随的 pause 消息再压回暂停）
        startCapture();
      } else if (msg?.type === 'pause') {
        if (started) manager.setPaused(true);
      } else if (msg?.type === 'resume') {
        startCapture();
      } else if (msg?.type === 'set-options') {
        // panel 里切换 recordHover / fillFlushMs / preferredDataAttribute：实时更新本帧 manager。
        panelOptions = msg.options ?? {};
        manager.setOptions(panelOptions);
        sendResponse({ ok: true });
        return;
      } else if (msg?.type === 'pick-start') {
        // panel 发起的元素拾取：本帧暂停事件捕获、启动拾取高亮；结果经 bg 竞胜（首个 pick-result
        // 胜出）后由 bg 广播 pick-stop 统一收尾，避免 N 帧各自回结果打进面板表单
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
        // 胜者帧已自行恢复暂停态并回发结果；此处收尾其余帧。
        // picker.stop 不触发 onDone（picker 内部口径），胜者不会因 stop 双发。
        if (pickPrevPaused !== null) {
          if (started) manager.setPaused(pickPrevPaused);
          pickPrevPaused = null;
        }
        picker.stop();
      } else if (msg?.type === 'locate-frame') {
        // bg 帧链下钻：找「本帧的宿主 iframe 元素」出候选。隔离世界的 window.frameElement
        // 拿不到（Chromium 行为，实测确认），改扫父文档按 contentWindow 身份认领自己——
        // 「子帧隔离世界读父文档」是 announce 已验证的同源可用通道；跨源读 parent.document
        // 抛异常 → 无链，与政策对齐。
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
            // generateLocators 从 recorder-manager.js（esbuild 打包产物）拿：selector-core.js
            // 含裸模块说明符（@medv/finder），浏览器动态 import() 解析不了，直接 import 它必炸。
            const mod = await import(chrome.runtime.getURL('modules/recorder-manager.js'));
            sendResponse({ locators: mod.generateLocators(el) });
          } catch {
            sendResponse({ locators: null });
          }
        })();
        return true;
      }
    });

    // announce 回执若声明会话处于暂停，manager 不启动；resume 消息到达时 startCapture。
    if (!reply?.paused) startCapture();
  };

  // ---- announce 握手：装载即报户口，回执 recording:true 才 bootstrap ----
  const announce = (attempt = 0) => {
    // 每次尝试重读父 token：静态 iframe 可能早于父帧注入完成（父属性尚未落下）。
    // 跨源父帧读 parent.document 直接抛异常——这与「父帧还没注入」必须区分开：
    // 前者永远不会就绪，重试是纯浪费（还会把该帧的启动拖满 5s 重试窗口）；
    // 后者等一等就有了。跨源按无链政策立即 bootstrap。
    let parentToken = null;
    let parentCross = false;
    if (window.parent !== window) {
      try { parentToken = window.parent.document.documentElement.getAttribute(TOKEN_ATTR); } catch { parentCross = true; }
    }
    chrome.runtime.sendMessage({ type: 'frame-announce', token, parentToken }, (reply) => {
      if (chrome.runtime.lastError || !reply) {
        // SW 冷启动/被回收中：消息无人接住，退避重试（500ms × 10 ≈ 5s 窗口）
        if (attempt < 10) setTimeout(() => announce(attempt + 1), 500);
        return;
      }
      if (!reply.recording) return; // 无活跃会话：保持休眠（不 import 重模块、不监听页面事件）
      if (window.parent !== window && !parentToken && !parentCross && attempt < 10) {
        // 嵌套帧但父令牌未就位（父帧注入晚于本帧）：等父帧落属性后重报，否则链在该帧截断。
        // 跨源父帧（parentCross）不等——永远不会就绪，按无链政策直接启动。
        setTimeout(() => announce(attempt + 1), 500);
        return;
      }
      void bootstrap(reply);
    });
  };
  announce();
  globalThis.__itaRecorder = 'ok';

  chrome.runtime.onMessage.addListener((msg) => {
    // 兜底：错过 announce 重试窗口（SW 长时间不可用）的帧，靠 start 广播重新握手。
    // 消息广播到 tab 全帧，每帧各自 announce，互不影响。
    if (msg?.type === 'start' && !bootstrapped) announce();
  });
})();
