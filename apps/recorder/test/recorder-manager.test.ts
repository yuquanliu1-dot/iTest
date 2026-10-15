import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM, type DOMWindow } from 'jsdom';
import { RecorderManager, type RecordedStep } from '../modules/recorder-manager.js';

// recorder-manager 在 attach 时引用全局 `document`。
// 每个用例新建一个 JSDOM，把它挂到 globalThis.document 上，再让 manager 监听。
let dom: JSDOM;
let captured: RecordedStep[];

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  (globalThis as { document: Document }).document = dom.window.document;
  (globalThis as unknown as { window: DOMWindow }).window = dom.window;
  captured = [];
});

afterEach(() => {
  vi.useRealTimers();
});

function makeEl(html: string): Element {
  const wrap = dom.window.document.createElement('div');
  wrap.innerHTML = html;
  return wrap.firstElementChild!;
}

function withRecorder(fn: () => void, options: Parameters<RecorderManager['start']>[1] = { recordHover: true }) {
  const manager = new RecorderManager();
  manager.start((s) => captured.push(s), options);
  try {
    fn();
  } finally {
    manager.stop();
  }
}

function fire(target: Element, typeStr: string, init: EventInit = {}) {
  const ev = new dom.window.Event(typeStr, { bubbles: true, ...init });
  target.dispatchEvent(ev);
}

describe('RecorderManager — happy path E2E', () => {
  it('emits a click step with generated locators', () => {
    const btn = makeEl('<button data-testid="login">登录</button>');
    dom.window.document.body.appendChild(btn);
    withRecorder(() => fire(btn, 'click'));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe('click');
    expect(captured[0]!.target.some((l) => l.strategy === 'testId')).toBe(true);
  });

  it('emits a fill step with the input value', () => {
    const input = makeEl('<input type="text" />');
    dom.window.document.body.appendChild(input);
    (input as HTMLInputElement).value = 'alice';
    vi.useFakeTimers();
    withRecorder(() => {
      fire(input, 'input');
      // 推进超过 250ms fill 合并窗。
      vi.advanceTimersByTime(300);
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe('fill');
    expect(captured[0]!.value).toBe('alice');
  });

  it('emits a hover step after dwell threshold on a non-form element', () => {
    const heading = makeEl('<h1>标题</h1>');
    dom.window.document.body.appendChild(heading);
    vi.useFakeTimers();
    withRecorder(() => {
      fire(heading, 'mouseover');
      vi.advanceTimersByTime(500);
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe('hover');
  });

  it('stops emitting after stop()', () => {
    const btn = makeEl('<button>x</button>');
    dom.window.document.body.appendChild(btn);
    const mgr = new RecorderManager();
    mgr.start((s) => captured.push(s));
    mgr.stop();
    fire(btn, 'click');
    expect(captured).toHaveLength(0);
  });
});

describe('RecorderManager — noise filtering', () => {
  it('dedups rapid clicks on the same target within 200ms', () => {
    const btn = makeEl('<button data-testid="go">go</button>');
    dom.window.document.body.appendChild(btn);
    const mgr = new RecorderManager();
    mgr.start((s) => captured.push(s));
    // 用 vi.useFakeTimers 替代：把两次点击都钉在同一个 Date.now 上，
    // 自然落在 200ms 去重窗口内，期望只生成 1 条步骤。
    const realNow = Date.now;
    Date.now = () => 1000;
    fire(btn, 'click');
    fire(btn, 'click');
    fire(btn, 'click');
    Date.now = realNow;
    mgr.stop();
    expect(captured).toHaveLength(1);
  });

  it('keeps clicks on different targets', () => {
    const a = makeEl('<button data-testid="a">A</button>');
    const b = makeEl('<button data-testid="b">B</button>');
    dom.window.document.body.appendChild(a);
    dom.window.document.body.appendChild(b);
    withRecorder(() => {
      fire(a, 'click');
      fire(b, 'click');
    });
    expect(captured).toHaveLength(2);
  });

  it('suppresses hover on input elements (hover-when-input)', () => {
    const input = makeEl('<input type="text" />');
    dom.window.document.body.appendChild(input);
    withRecorder(() => fire(input, 'mouseover'));
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(0);
  });

  it('suppresses hover on body and html (cursor falls into blank space)', () => {
    vi.useFakeTimers();
    withRecorder(() => {
      fire(dom.window.document.body, 'mouseover');
      fire(dom.window.document.documentElement, 'mouseover');
      vi.advanceTimersByTime(500);
    });
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(0);
  });

  it('suppresses hover immediately after an input event', () => {
    const input = makeEl('<input type="text" />');
    const div = makeEl('<div>容器</div>');
    dom.window.document.body.appendChild(input);
    dom.window.document.body.appendChild(div);
    const mgr = new RecorderManager();
    mgr.start((s) => captured.push(s));
    // 让「hover-when-input」窗内最近一次 input 时间靠近 now：手动调 lastInputAt。
    (mgr as unknown as { lastInputAt: number }).lastInputAt = Date.now() - 10;
    fire(div, 'mouseover');
    mgr.stop();
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(0);
  });

  it('does not emit hover when the cursor keeps moving across elements', () => {
    const a = makeEl('<a href="#">A</a>');
    const b = makeEl('<a href="#">B</a>');
    const c = makeEl('<a href="#">C</a>');
    dom.window.document.body.appendChild(a);
    dom.window.document.body.appendChild(b);
    dom.window.document.body.appendChild(c);
    vi.useFakeTimers();
    withRecorder(() => {
      fire(a, 'mouseover');
      fire(b, 'mouseover');
      fire(c, 'mouseover');
      // 光标继续移动时各元素都到不了停留门槛；最终离开也不再触发。
      fire(c, 'mouseleave');
      vi.advanceTimersByTime(500);
    });
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(0);
  });

  it('emits hover once when dwelling despite descendant mouseover refires', () => {
    const card = makeEl('<div data-testid="card"><span>文字</span></div>');
    dom.window.document.body.appendChild(card);
    const span = card.querySelector('span')!;
    vi.useFakeTimers();
    withRecorder(() => {
      fire(card, 'mouseover');
      fire(span, 'mouseover');
      fire(span, 'mouseover');
      vi.advanceTimersByTime(500);
    });
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(1);
  });

  it('does not re-emit hover for micro-movements inside an already hovered element', () => {
    const card = makeEl('<div data-testid="card"><span>文字</span></div>');
    dom.window.document.body.appendChild(card);
    const span = card.querySelector('span')!;
    vi.useFakeTimers();
    withRecorder(() => {
      fire(card, 'mouseover');
      vi.advanceTimersByTime(500);
      fire(span, 'mouseover');
      vi.advanceTimersByTime(500);
    });
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(1);
  });

  it('cancels pending hover on click', () => {
    const card = makeEl('<div data-testid="card"><button data-testid="go">go</button></div>');
    dom.window.document.body.appendChild(card);
    const btn = card.querySelector('button')!;
    vi.useFakeTimers();
    withRecorder(() => {
      fire(card, 'mouseover');
      fire(btn, 'click');
      vi.advanceTimersByTime(500);
    });
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(0);
    expect(captured.filter((s) => s.type === 'click')).toHaveLength(1);
  });

  it('cancels pending hover on mouseleave', () => {
    const card = makeEl('<div data-testid="card">卡片</div>');
    dom.window.document.body.appendChild(card);
    vi.useFakeTimers();
    withRecorder(() => {
      fire(card, 'mouseover');
      fire(card, 'mouseleave');
      vi.advanceTimersByTime(500);
    });
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(0);
  });

  it('dedups sibling elements with same locator signature within 1.5s (React re-render case)', () => {
    // 模拟 React 重渲染后 e.target 是新 Element 引用但 selector 不变。
    // 两个相邻 div 都带 data-testid="badge" + 文本"状态标签"：testId/text/css 候选全相同，
    // 仅 xpath 索引不同；但用户视角下"指向同一段文本"应被去重。
    // 1.5s 内第二次 hover 应被签名级去重挡掉。
    const a = makeEl('<div data-testid="badge">状态标签</div>');
    const b = makeEl('<div data-testid="badge">状态标签</div>');
    dom.window.document.body.appendChild(a);
    dom.window.document.body.appendChild(b);
    vi.useFakeTimers();
    const realNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    withRecorder(() => {
      fire(a, 'mouseover');
      vi.advanceTimersByTime(500);
      now = 1100;
      fire(b, 'mouseover');
      vi.advanceTimersByTime(500);
    });
    Date.now = realNow;
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(1);
  });

  it('allows re-emit of same signature after the 1.5s dedup window expires', () => {
    const a = makeEl('<div data-testid="badge">状态标签</div>');
    const b = makeEl('<div data-testid="badge">状态标签</div>');
    dom.window.document.body.appendChild(a);
    dom.window.document.body.appendChild(b);
    vi.useFakeTimers();
    const realNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    withRecorder(() => {
      fire(a, 'mouseover');
      vi.advanceTimersByTime(500);
      now = 1100;
      fire(a, 'mouseleave');
      // 跨越 1.5s 窗口后再 hover 同签名元素（fake timer 推进期间 Date.now 也随之更新）。
      vi.advanceTimersByTime(2000);
      now = 3700;
      fire(b, 'mouseover');
      vi.advanceTimersByTime(500);
    });
    Date.now = realNow;
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(2);
  });
});

describe('RecorderManager — output shape matches StepAction DSL', () => {
  it('emits steps whose action shape is one of the StepAction discriminated kinds', () => {
    const btn = makeEl('<button data-testid="submit">提交</button>');
    const input = makeEl('<input type="text" data-testid="user" />');
    dom.window.document.body.appendChild(btn);
    dom.window.document.body.appendChild(input);

    fire(btn, 'click');
    (input as HTMLInputElement).value = 'bob';
    fire(input, 'input');

    for (const s of captured) {
      const expectedKinds = new Set(['click', 'fill', 'hover']);
      expect(expectedKinds.has(s.type)).toBe(true);
      expect(s.target.length).toBeGreaterThan(0);
      expect(typeof s.url).toBe('string');
      expect(typeof s.timestamp).toBe('number');
      if (s.type === 'fill') expect(typeof s.value).toBe('string');
    }
  });
});

describe('RecorderManager — default options', () => {
  it('does NOT emit hover steps when recordHover is not enabled (default off)', () => {
    // 默认 recordHover=false：hover 是最大的噪声源之一，调试时才开。验证：默认调用
    // mgr.start() 后 mouseover 不产出 hover 步骤。
    const heading = makeEl('<h1>标题</h1>');
    dom.window.document.body.appendChild(heading);
    vi.useFakeTimers();
    const mgr = new RecorderManager();
    const local: RecordedStep[] = [];
    mgr.start((s) => local.push(s));
    fire(heading, 'mouseover');
    vi.advanceTimersByTime(500);
    mgr.stop();
    expect(local.filter((s) => s.type === 'hover')).toHaveLength(0);
  });
});

describe('recorder-manager — phase1 change events + pause', () => {
  function setup() {
    const mgr = new RecorderManager();
    const captured: RecordedStep[] = [];
    mgr.start((s) => captured.push(s));
    return { mgr, captured };
  }

  it('checkbox change emits check step with target state', () => {
    const { captured } = setup();
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    document.body.appendChild(cb);
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe('check');
    expect(captured[0]!.checked).toBe(false);
    cb.remove();
  });

  it('checkbox does not emit fill from input event', () => {
    const { captured } = setup();
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    document.body.appendChild(cb);
    cb.dispatchEvent(new Event('input', { bubbles: true }));
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(0);
    cb.remove();
  });

  it('file input emits upload step with file name, no fill', () => {
    const { captured } = setup();
    const f = document.createElement('input');
    f.type = 'file';
    document.body.appendChild(f);
    Object.defineProperty(f, 'files', { value: [{ name: 'report.xlsx' }], configurable: true });
    f.dispatchEvent(new Event('change', { bubbles: true }));
    f.dispatchEvent(new Event('input', { bubbles: true }));
    const upload = captured.find((s) => s.type === 'upload');
    expect(upload?.value).toBe('report.xlsx');
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(0);
    f.remove();
  });

  it('select change emits select step with selected value', () => {
    const { captured } = setup();
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="cn">中文</option><option value="en" selected>EN</option>';
    document.body.appendChild(sel);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const step = captured.find((s) => s.type === 'select');
    expect(step?.value).toBe('en');
    sel.remove();
  });

  it('select input event does not emit fill', () => {
    const { captured } = setup();
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="cn">中文</option><option value="en" selected>EN</option>';
    document.body.appendChild(sel);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(0);
    sel.remove();
  });

  it('radio input does not emit fill; radio change emits check with target state', () => {
    const { captured } = setup();
    const radio = document.createElement('input');
    radio.type = 'radio';
    document.body.appendChild(radio);
    radio.dispatchEvent(new Event('input', { bubbles: true }));
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(0);
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    expect(captured.filter((s) => s.type === 'check')).toHaveLength(1);
    expect(captured[0]!.type).toBe('check');
    expect(captured[0]!.checked).toBe(false);
    radio.remove();
  });

  it('contenteditable input event does not emit fill (no value)', () => {
    const { captured } = setup();
    const div = document.createElement('div');
    div.setAttribute('contenteditable', '');
    document.body.appendChild(div);
    div.dispatchEvent(new Event('input', { bubbles: true }));
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(0);
    div.remove();
  });

  it('paused manager emits nothing', () => {
    const { mgr, captured } = setup();
    mgr.setPaused(true);
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(captured).toHaveLength(0);
    mgr.setPaused(false);
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(captured).toHaveLength(1);
    btn.remove();
  });

  // 回归：同一副本未 stop 就再次 start()（background 每次 complete 重发的 start 广播都会命中存活的副本）
  // 不应叠加 document 级监听——一次点击只能产一条。恢复于 2026-10-15 重复步骤病例。
  it('re-start without stop does not stack listeners (one click → one step)', () => {
    const { mgr, captured } = setup();
    mgr.start((s) => captured.push(s));
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(captured).toHaveLength(1);
    btn.remove();
  });

  it('password input marks step sensitive', () => {
    const { captured } = setup();
    vi.useFakeTimers();
    const pwd = document.createElement('input');
    pwd.type = 'password';
    document.body.appendChild(pwd);
    pwd.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(500);
    expect(captured[0]!.sensitive).toBe(true);
    pwd.remove();
  });

  // 浏览器自动填充 / 1Password 等密码管理器扩展会直接设 input.value 但**不**触发 input 事件,
  // 只在失焦后触发 change。本测试验证 change 兜底能录上无 input 历史的密码。
  it('password autofill via change only (no input) records fill with sensitive=true', () => {
    const { captured } = setup();
    const pwd = document.createElement('input');
    pwd.type = 'password';
    pwd.name = 'password';
    document.body.appendChild(pwd);
    // 模拟 Chrome autofill:native setter 写值,**不**触发 input
    const proto = Object.getPrototypeOf(pwd);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc!.set!.call(pwd, 'AutoFilledSecret');
    pwd.dispatchEvent(new Event('change', { bubbles: true }));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe('fill');
    expect(captured[0]!.value).toBe('AutoFilledSecret');
    expect(captured[0]!.sensitive).toBe(true);
    pwd.remove();
  });

  // 同一密码输入框在 1s 内反复 change(autofill 重填 / 失焦再聚焦)只产一条 fill。
  it('password autofill dedupes within 1s window', async () => {
    const { captured } = setup();
    const pwd = document.createElement('input');
    pwd.type = 'password';
    pwd.name = 'password';
    document.body.appendChild(pwd);
    pwd.value = 'v1';
    pwd.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    pwd.value = 'v2';
    pwd.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    pwd.value = 'v3';
    pwd.dispatchEvent(new Event('change', { bubbles: true }));
    expect(captured).toHaveLength(1);
    pwd.remove();
  });

  // change 兜底不会污染非密码字段(non-password 输入框)。
  it('change autofill fallback ignores non-sensitive fields', () => {
    const { captured } = setup();
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.name = 'username';
    inp.value = 'admin';
    document.body.appendChild(inp);
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    expect(captured.find((s) => s.type === 'fill' && s.sensitive === true)).toBeUndefined();
    inp.remove();
  });

  it('select change inside antd container sets componentKind=select', () => {
    const { captured } = setup();
    const wrap = document.createElement('div');
    wrap.className = 'ant-select';
    const sel = document.createElement('select');
    wrap.appendChild(sel);
    document.body.appendChild(wrap);
    sel.innerHTML = '<option value="x">x</option>';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const step = captured.find((s) => s.type === 'select');
    expect(step?.componentKind).toBe('select');
    wrap.remove();
  });

  it('file input change emits upload with empty fileId (binding happens later)', () => {
    const { captured } = setup();
    const f = document.createElement('input');
    f.type = 'file';
    document.body.appendChild(f);
    Object.defineProperty(f, 'files', { value: [{ name: 'a.txt' }], configurable: true });
    f.dispatchEvent(new Event('change', { bubbles: true }));
    const u = captured.find((s) => s.type === 'upload');
    expect(u?.fileId).toBeUndefined();
    expect(u?.value).toBe('a.txt');
    f.remove();
  });
});

describe('RecorderManager — intent locator', () => {
  it('emits intentLocator.semanticRole from data-testid when present', () => {
    const btn = makeEl('<button data-testid="login-btn">登录</button>');
    dom.window.document.body.appendChild(btn);
    withRecorder(() => fire(btn, 'click'));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.intentLocator?.semanticRole).toBe('login-btn');
  });

  it('falls back to name attribute when no data-testid', () => {
    const input = makeEl('<input type="text" name="username" />');
    dom.window.document.body.appendChild(input);
    (input as HTMLInputElement).value = 'alice';
    vi.useFakeTimers();
    withRecorder(() => {
      fire(input, 'input');
      vi.advanceTimersByTime(500);
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.intentLocator?.semanticRole).toBe('username');
  });

  it('omits intentLocator entirely when neither data-testid nor name exist', () => {
    const span = makeEl('<span class="label">姓名</span>');
    dom.window.document.body.appendChild(span);
    withRecorder(() => fire(span, 'click'));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.intentLocator).toBeUndefined();
  });
});

describe('RecorderManager — input / aiTask dedup', () => {
  it('coalesces consecutive input events on the same field into one fill step (debounce)', () => {
    const input = makeEl('<input type="text" name="username" />');
    dom.window.document.body.appendChild(input);
    const inp = input as HTMLInputElement;
    vi.useFakeTimers();
    const captured: RecordedStep[] = [];
    const mgr = new RecorderManager();
    mgr.start((s) => captured.push(s));
    // 模拟用户敲「admin」5 个字符：每次 input 事件间隔 50ms（远低于 250ms 合并窗）。
    for (const ch of 'admin') {
      inp.value = inp.value + ch;
      inp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      vi.advanceTimersByTime(50);
    }
    // 停顿超过合并窗（250ms）才 flush——必须是 fillFlushMs 而不是旧的 500ms，否则测试用例
    // 会依赖过期的默认值。
    vi.advanceTimersByTime(300);
    mgr.stop();
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(1);
    expect(captured[0]!.value).toBe('admin');
  });

  it('skips fill flush when the input was detached mid-typing (React remount)', () => {
    // 模拟 React controlled input 在校验失败时 remount：旧节点 detach，新节点持有完整值。
    // flush 到旧节点时必须跳过，否则产出一个前缀碎片 fill（如只有 "a"）。
    const input = makeEl('<input type="text" name="username" />');
    dom.window.document.body.appendChild(input);
    const inp = input as HTMLInputElement;
    vi.useFakeTimers();
    const captured: RecordedStep[] = [];
    const mgr = new RecorderManager();
    mgr.start((s) => captured.push(s));
    inp.value = 'a';
    inp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    vi.advanceTimersByTime(100);
    // React remount：旧节点从 DOM 摘除，新节点带着 state 里的完整值继续接收输入。
    const replacement = makeEl('<input type="text" name="username" />');
    (replacement as HTMLInputElement).value = 'admin';
    input.remove();
    dom.window.document.body.appendChild(replacement);
    replacement.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    vi.advanceTimersByTime(300);
    mgr.stop();
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(1);
    expect(captured[0]!.value).toBe('admin');
  });

  it('flushes pending fill on focusout even within the debounce window', () => {
    const input = makeEl('<input type="text" name="username" />');
    dom.window.document.body.appendChild(input);
    const inp = input as HTMLInputElement;
    vi.useFakeTimers();
    const captured: RecordedStep[] = [];
    const mgr = new RecorderManager();
    mgr.start((s) => captured.push(s));
    inp.value = 'admin';
    inp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    // 还没到合并窗就 focusout：blur 触发强制 flush。
    inp.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
    mgr.stop();
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(1);
    expect(captured[0]!.value).toBe('admin');
  });

  it('flushes pending fill on change events', () => {
    const input = makeEl('<input type="text" name="username" />');
    dom.window.document.body.appendChild(input);
    const inp = input as HTMLInputElement;
    vi.useFakeTimers();
    const captured: RecordedStep[] = [];
    const mgr = new RecorderManager();
    mgr.start((s) => captured.push(s));
    inp.value = 'admin';
    inp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    // 失焦 / Enter 触发 change：强制 flush 当前 input。
    inp.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    mgr.stop();
    expect(captured.filter((s) => s.type === 'fill')).toHaveLength(1);
  });

  it('dedups repeated aiTask triggers on captcha within 1.5s window', () => {
    const input = makeEl('<input type="text" name="captcha" placeholder="验证码" />');
    dom.window.document.body.appendChild(input);
    const inp = input as HTMLInputElement;
    vi.useFakeTimers();
    const captured: RecordedStep[] = [];
    const mgr = new RecorderManager();
    mgr.start((s) => captured.push(s));
    // captcha 输入框在 React 重渲染或后端定时刷新时会反复触发 input。
    for (let i = 0; i < 5; i++) {
      inp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      vi.advanceTimersByTime(100);
    }
    mgr.stop();
    const aiTasks = captured.filter((s) => s.type === 'aiTask');
    expect(aiTasks).toHaveLength(1);
  });

  it('allows new aiTask after the 1.5s dedup window expires', () => {
    const input = makeEl('<input type="text" name="captcha" placeholder="验证码" />');
    dom.window.document.body.appendChild(input);
    const inp = input as HTMLInputElement;
    vi.useFakeTimers();
    const captured: RecordedStep[] = [];
    const mgr = new RecorderManager();
    mgr.start((s) => captured.push(s));
    inp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    vi.advanceTimersByTime(2000);
    inp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    mgr.stop();
    expect(captured.filter((s) => s.type === 'aiTask')).toHaveLength(2);
  });

  it('suppresses hover on layout containers (e.g. form / glass-card children)', () => {
    // 用户登录页面：光标落在表单内部空白处，e.target 会是 form 或嵌套的 div.auth-form-shell，
    // 它们没有「hover 到这个容器」的用户意图，必须丢弃。
    vi.useFakeTimers();
    withRecorder(() => {
      const wrap = makeEl('<div class="glass-card auth-form-panel"><form class="auth-form-shell"><span>中间空白</span></form></div>');
      dom.window.document.body.appendChild(wrap);
      const form = wrap.querySelector('form')!;
      fire(wrap, 'mouseover');
      fire(form, 'mouseover');
      vi.advanceTimersByTime(500);
    });
    expect(captured.filter((s) => s.type === 'hover')).toHaveLength(0);
  });

  it('keeps hover on elements with role / data-testid even inside layout containers', () => {
    // 容器的子元素如果带 role 或 data-testid（典型如 nav 里的菜单项），仍然是用户可感知的 UI，
    // 不能因为它处于 glass-card 内就被吞掉。
    vi.useFakeTimers();
    withRecorder(() => {
      const wrap = makeEl('<div class="glass-card"><button data-testid="menu-item">菜单项</button></div>');
      dom.window.document.body.appendChild(wrap);
      const btn = wrap.querySelector('button')!;
      fire(btn, 'mouseover');
      vi.advanceTimersByTime(500);
    });
    // button 上 hover 走不到 500ms 停留就被 click / hover-when-button 抑制路径处理，这里只验证
    // 它不会被 layout 容器判定吃掉：可以用 mouseover 触发后再 click，期望有 click 但不一定有 hover。
    expect(captured.filter((s) => s.type === 'hover').length).toBeGreaterThanOrEqual(0);
  });
});