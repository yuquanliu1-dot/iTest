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
 * 窗口高度跟随内容：各模式内容差很多（断言只有一行提示，变量/AI 模式带表单），
 * 固定高度会在下方留一大片空白。这里按容器实际高度收敛窗口，状态变化后再收敛一次。
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

function suggestVarName(r) {
  const raw = r.id || r.nameAttr || '';
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
}

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
} else {
  setStatus(t('pickHint'));
  chrome.runtime.sendMessage({ type: 'pick' }, (r) => {
    if (!r || r.ok === false) {
      closeBtn.classList.remove('hidden');
      setStatus(t('pickFailed', [r?.error ?? t('notRecording')]));
      return;
    }
    if (r.canceled) {
      closeBtn.classList.remove('hidden');
      setStatus(t('canceled'));
      return;
    }
    if (mode === 'hover') {
      emit({ kind: 'hover', locator: r.locators });
      return;
    }
    if (mode === 'variable') {
      showForm({
        hint: t('elementText', [r.text.slice(0, 60) || r.inputValue.slice(0, 60) || t('emptyText')]),
        label1: t('labelVarName'),
        value1: suggestVarName(r),
        onSubmit: () => {
          const varName = field1.value.trim();
          if (!varName) {
            setStatus(t('enterVarName'));
            return;
          }
          emit({ kind: 'extract', locator: r.locators, varName });
        },
      });
      return;
    }
    if (mode === 'assert') {
      // 2026-11-04: 选中即生成，不再弹表单——原表单流程用户选完元素直接关窗，「确定」没点
      // emit 从未发生，断言就丢了（b0dbb886 RCA）。期望值沿用原表单默认：元素当前文本/输入值。
      // 两者皆空（图标按钮等）退化为元素级 assertVisible，不依赖文案。
      const expected = r.text || r.inputValue;
      if (expected) {
        emit({ kind: 'assertText', locator: r.locators, equals: expected });
      } else {
        emit({ kind: 'assertVisible', locator: r.locators });
      }
    }
  });
}