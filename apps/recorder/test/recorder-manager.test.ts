import { describe, it, expect, beforeEach } from 'vitest';
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

function makeEl(html: string): Element {
  const wrap = dom.window.document.createElement('div');
  wrap.innerHTML = html;
  return wrap.firstElementChild!;
}

function withRecorder(fn: () => void) {
  const manager = new RecorderManager();
  manager.start((s) => captured.push(s));
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
    withRecorder(() => fire(input, 'input'));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.type).toBe('fill');
    expect(captured[0]!.value).toBe('alice');
  });

  it('emits a hover step for non-form elements', () => {
    const heading = makeEl('<h1>标题</h1>');
    dom.window.document.body.appendChild(heading);
    withRecorder(() => fire(heading, 'mouseover'));
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