const t = (k, s) => chrome.i18n.getMessage(k, s);

document.documentElement.lang = chrome.i18n.getUILanguage();

// HTML 静态 __MSG_*__ 字面量不被 _locales 机制替换，DOM 加载后替换 submit/close
// 两个按钮的文本（title 已在下方被 TITLES[mode] 覆盖，无需处理）。
for (const el of [document.getElementById('submit'), document.getElementById('close')]) {
  if (el) el.textContent = el.textContent.replace(/__MSG_(\w+)__/, (_, key) => t(key) || `__MSG_${key}__`);
}

const mode = new URLSearchParams(location.search).get('mode') ?? 'ai';
const statusEl = document.getElementById('status');
const form = document.getElementById('form');
const closeBtn = document.getElementById('close');
const field1 = document.getElementById('field1');
const field2 = document.getElementById('field2');
const field2Label = document.getElementById('field2-label');

/**
 * 窗口高度跟随内容：按容器实际高度收敛窗口，状态变化后再收敛一次，
 * 固定高度会在下方留一大片空白。
 */
function fitWindow() {
  const container = document.querySelector('.container');
  if (!container) return;
  const contentH = Math.ceil(container.getBoundingClientRect().height);
  chrome.windows.getCurrent((win) => {
    // 只调整扩展自己开的 popup 窗口：面板页若被直接开在普通标签页里，
    // getCurrent 返回的是浏览器主窗口，不能去改它的高度
    if (!win || win.type !== 'popup') return;
    // 窗口边框/标题栏占的高度 = 外框高 − 内容视口高
    const frame = Math.max(0, win.height - document.documentElement.clientHeight);
    chrome.windows.update(win.id, { height: contentH + frame });
  });
}

/** 改状态文案并顺带按新内容收敛窗口高度。 */
function setStatus(text) {
  statusEl.textContent = text;
  fitWindow();
}

const TITLES = {
  variable: t('modeSavingVariable'),
  assert: t('modeAddAssertion'),
  hover: t('modeRecordHover'),
  ai: t('modeAiStep'),
};
document.getElementById('title').textContent = TITLES[mode] ?? t('recordingPanel');

closeBtn.addEventListener('click', () => window.close());

function emit(dsl) {
  chrome.runtime.sendMessage({ type: 'emit-step', dsl }, (resp) => {
    if (resp?.ok) {
      form.classList.add('hidden');
      closeBtn.classList.remove('hidden');
      setStatus(t('stepGenerated'));
    } else {
      setStatus(t('failStatus', [resp?.error ?? t('unknownError')]));
    }
  });
}

function showForm(html) {
  document.getElementById('field1-label').textContent = html.label1;
  field1.value = html.value1 ?? '';
  if (html.label2) {
    field2Label.textContent = html.label2;
    field2Label.classList.remove('hidden');
    field2.classList.remove('hidden');
    field2.value = html.value2 ?? '';
  }
  form.classList.remove('hidden');
  document.getElementById('submit').onclick = html.onSubmit;
  setStatus(html.hint);
}

// v0.0.6 起本页只服务 AI 模式：断言/悬停/存变量已改在页面内控制面板内联拾取——
// 扩展弹窗在用户点选被测页面元素后失焦，会被被测系统窗口盖住（置顶/拉回均不可靠），
// 而页面内面板是页面的一部分，任何外部窗口都盖不住。AI 模式无拾取环节，开窗即聚焦，保留弹窗。
if (mode === 'ai') {
  showForm({
    hint: t('aiHint'),
    label1: t('labelInstruction'),
    value1: '',
    onSubmit: () => {
      const instruction = field1.value.trim();
      if (!instruction) {
        setStatus(t('enterInstruction'));
        return;
      }
      emit({ kind: 'aiTask', instruction });
    },
  });
}