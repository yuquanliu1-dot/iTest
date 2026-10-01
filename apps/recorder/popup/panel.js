const mode = new URLSearchParams(location.search).get('mode') ?? 'ai';
const statusEl = document.getElementById('status');
const form = document.getElementById('form');
const closeBtn = document.getElementById('close');
const field1 = document.getElementById('field1');
const field2 = document.getElementById('field2');
const field2Label = document.getElementById('field2-label');

const TITLES = {
  variable: '保存变量',
  assert: '添加断言',
  hover: '记录悬浮',
  ai: 'AI 自然语言步骤',
};
document.getElementById('title').textContent = TITLES[mode] ?? '录制面板';

closeBtn.addEventListener('click', () => window.close());

function emit(dsl) {
  chrome.runtime.sendMessage({ type: 'emit-step', dsl }, (resp) => {
    if (resp?.ok) {
      statusEl.textContent = '已生成步骤 ✓';
      form.classList.add('hidden');
      closeBtn.classList.remove('hidden');
    } else {
      statusEl.textContent = `失败: ${resp?.error ?? '未知错误'}`;
    }
  });
}

function showForm(html) {
  statusEl.textContent = html.hint;
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
}

function suggestVarName(r) {
  const raw = r.id || r.nameAttr || '';
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
}

if (mode === 'ai') {
  showForm({
    hint: '描述要执行的操作，可用 #cssSelector 引用页面元素（如识别图片 #captchaImg），保存用例时会编译成具体步骤：',
    label1: '指令',
    value1: '',
    onSubmit: () => {
      const instruction = field1.value.trim();
      if (!instruction) {
        statusEl.textContent = '请输入指令';
        return;
      }
      emit({ kind: 'aiStep', instruction, compiled: null });
    },
  });
} else {
  statusEl.textContent = '请在页面中点击目标元素（Esc 取消）...';
  chrome.runtime.sendMessage({ type: 'pick' }, (r) => {
    if (!r || r.ok === false) {
      statusEl.textContent = `无法拾取: ${r?.error ?? '扩展未在录制中'}`;
      closeBtn.classList.remove('hidden');
      return;
    }
    if (r.canceled) {
      statusEl.textContent = '已取消';
      closeBtn.classList.remove('hidden');
      return;
    }
    if (mode === 'hover') {
      emit({ kind: 'hover', locator: r.locators });
      return;
    }
    if (mode === 'variable') {
      showForm({
        hint: `元素文本: ${r.text.slice(0, 60) || r.inputValue.slice(0, 60) || '（空）'}`,
        label1: '变量名',
        value1: suggestVarName(r),
        onSubmit: () => {
          const varName = field1.value.trim();
          if (!varName) {
            statusEl.textContent = '请输入变量名';
            return;
          }
          emit({ kind: 'extract', locator: r.locators, varName });
        },
      });
      return;
    }
    if (mode === 'assert') {
      showForm({
        hint: '选择断言类型并填写期望值：',
        label1: '断言类型（text / json）',
        value1: 'text',
        label2: '期望值（默认已填入元素当前文本）',
        value2: r.text || r.inputValue,
        onSubmit: () => {
          const type = field1.value.trim();
          const expected = field2.value;
          if (type === 'json') {
            let parsed;
            try {
              parsed = JSON.parse(expected);
            } catch {
              statusEl.textContent = '期望值不是合法 JSON';
              return;
            }
            emit({ kind: 'assertJson', locator: r.locators, equals: parsed });
          } else {
            emit({ kind: 'assertText', locator: r.locators, equals: expected });
          }
        },
      });
    }
  });
}