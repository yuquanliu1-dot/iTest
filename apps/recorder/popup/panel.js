const t = (k, s) => chrome.i18n.getMessage(k, s);

document.documentElement.lang = chrome.i18n.getUILanguage();

const mode = new URLSearchParams(location.search).get('mode') ?? 'ai';
const statusEl = document.getElementById('status');
const form = document.getElementById('form');
const closeBtn = document.getElementById('close');
const field1 = document.getElementById('field1');
const field2 = document.getElementById('field2');
const field2Label = document.getElementById('field2-label');

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
      statusEl.textContent = t('stepGenerated');
      form.classList.add('hidden');
      closeBtn.classList.remove('hidden');
    } else {
      statusEl.textContent = t('failStatus', [resp?.error ?? t('unknownError')]);
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
    hint: t('aiHint'),
    label1: t('labelInstruction'),
    value1: '',
    onSubmit: () => {
      const instruction = field1.value.trim();
      if (!instruction) {
        statusEl.textContent = t('enterInstruction');
        return;
      }
      emit({ kind: 'aiTask', instruction });
    },
  });
} else {
  statusEl.textContent = t('pickHint');
  chrome.runtime.sendMessage({ type: 'pick' }, (r) => {
    if (!r || r.ok === false) {
      statusEl.textContent = t('pickFailed', [r?.error ?? t('notRecording')]);
      closeBtn.classList.remove('hidden');
      return;
    }
    if (r.canceled) {
      statusEl.textContent = t('canceled');
      closeBtn.classList.remove('hidden');
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
            statusEl.textContent = t('enterVarName');
            return;
          }
          emit({ kind: 'extract', locator: r.locators, varName });
        },
      });
      return;
    }
    if (mode === 'assert') {
      showForm({
        hint: t('assertHint'),
        label1: t('assertType'),
        value1: 'text',
        label2: t('assertExpected'),
        value2: r.text || r.inputValue,
        onSubmit: () => {
          const type = field1.value.trim();
          const expected = field2.value;
          if (type === 'json') {
            let parsed;
            try {
              parsed = JSON.parse(expected);
            } catch {
              statusEl.textContent = t('invalidJson');
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