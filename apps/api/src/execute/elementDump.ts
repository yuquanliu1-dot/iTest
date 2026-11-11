/**
 * 页面可交互元素抽取（视口内清单 + 与截图对齐的归一化坐标框）。
 *
 * 抽自 aiTask.ts（坐标协议链路）——探索改用 pi 工具链后，元素清单被两条链路共用，
 * 不能各留一份：两份清单一旦漂移，同一页在「AI 相」与「探索」里会看到不同的控件集合。
 *
 * 注意：本模块的 evaluate 回调必须是**匿名箭头**——tsx/esbuild 的 keepNames 会给具名
 * 函数注入 __name 助手，而 evaluate 的函数体被序列化到浏览器上下文执行，那里没有
 * __name → 整个 evaluate 抛 ReferenceError，元素清单整体失效（dev/tsx 独有，tsc 产物无此注入）。
 */
import type { Page } from 'playwright-core';

export interface ElementInfo {
  selector: string;
  tag: string;
  /** 视口归一化 0-1000 坐标框 [x1,y1,x2,y2]——与截图对齐，模型据此指认目标。 */
  box: [number, number, number, number];
  text?: string;
  placeholder?: string;
  inputType?: string;
  /** input 当前值（密码型不打）——级联选中后 value=完整路径，是截图截断显示之外
   *  唯一可验证选中结果的通道。 */
  value?: string;
  disabled?: boolean;
}

/** 页面上下文内执行的选择器合成源码（函数表达式字符串）——dumpElements 与 resolveAtPoint
 *  经 evaluate 参数传入并在页面内 eval 还原，共用同一份（此前两处手抄副本，prod228 10-27
 *  实测 button>span 命中产出裸 span 即手抄链无上浮/无唯一性校验的后果）。
 *  基础优先级不变：#id → tag[name] → tag[placeholder] → [role] → tag.cls1.cls2 → 裸 tag；
 *  class 候选剔除激活态 class（router-link-active/is-active 由路由状态动态加减，固化后回放
 *  会因菜单未激活而落空——2026-10-28 prod228 实录 a.router-link-exact-active.router-link-active）。
 *  多命中时依次富化，保证机械回放命中唯一：
 *    1. 短文本（≤30 字符）尾缀 :has-text("…")——非标准 CSS，唯一性按「基础命中中
 *       textContent 含该文本」的个数模拟计数（与回放侧 getByText 的包含语义同向）；
 *    2. 父内同 tag 序号 :nth-of-type(k)——标准 CSS，可直接 querySelectorAll 验证。
 *  仍不唯一 → unique:false（上报链据此保持坐标形态，固化管线保守拒绝该步）。
 *  字符串源码对 tsx/esbuild 的 evaluate 嵌套函数 keepNames 陷阱免疫；Playwright evaluate
 *  走 DevTools 通道，不受页面 CSP 的 eval 限制。 */
export const SYNTH_SELECTOR_SRC = `function (el) {
  var tag = el.tagName.toLowerCase();
  var name = el.getAttribute('name');
  var ph = el.getAttribute('placeholder');
  var role = el.getAttribute('role');
  var selector = el.id ? '#' + CSS.escape(el.id) : '';
  if (!selector && name) selector = tag + '[name="' + name + '"]';
  if (!selector && ph) selector = tag + '[placeholder="' + ph + '"]';
  if (!selector && role) selector = '[role="' + role + '"]';
  if (!selector) {
    var cls = (el.className || '').toString().trim().split(/\\s+/).filter(Boolean)
      .filter(function (c) { return !/^(router-link-(exact-)?active|is-active)$/i.test(c); })
      .slice(0, 2).join('.');
    selector = cls ? tag + '.' + cls : tag;
  }
  function count(s) { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } }
  if (count(selector) === 1) return { selector: selector, unique: true };
  var text = (el.textContent || '').trim().replace(/["\\\\]/g, '').slice(0, 30);
  if (text) {
    var hits = document.querySelectorAll(selector);
    var m = 0;
    for (var i = 0; i < hits.length; i++) if ((hits[i].textContent || '').indexOf(text) >= 0) m++;
    if (m === 1) return { selector: selector + ':has-text("' + text + '")', unique: true };
  }
  var k = 1;
  for (var sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === el.tagName) k++;
  var nth = selector + ':nth-of-type(' + k + ')';
  if (count(nth) === 1) return { selector: nth, unique: true };
  return { selector: selector, unique: false };
}`;

/** 提取视口内可交互元素清单（selector + 与截图对齐的归一化坐标框）。
 *  坐标协议下清单的定位职能降为「对齐锚点 + selector 兜底」，box 才是主要信息。 */
export async function dumpElements(page: Page): Promise<ElementInfo[]> {
  const raw = (await page.evaluate((src: string) => {
    const synth = eval('(' + src + ')') as (el: HTMLElement) => { selector: string; unique: boolean };
    const out: Array<Record<string, unknown>> = [];
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const els = document.querySelectorAll(
      'button, input, textarea, select, a[href], [role="button"], [role="link"], [role="textbox"], [role="combobox"], [tabindex]:not([tabindex="-1"])',
    );
    for (const el of Array.from(els).slice(0, 200)) {
      const he = el as HTMLElement;
      const r = he.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // 只保留与视口相交的元素：截图只有视口，清单与截图不对齐会误导坐标指认。
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      const style = window.getComputedStyle(he);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const s = synth(he);
      let text = (he.textContent ?? '').trim().slice(0, 40);
      // 行首单选/复选 input 自身无文本（Element-UI 级联 checkStrictly 下 radio 是唯一
      // 选中路径），清单里有坐标却无从指认是哪一行——取所在行容器的行文字。
      // 级联的下级列嵌套在父 li 内（子面板是 li 的子节点），不能用整行 textContent，
      // 只取行自己的标签 span。
      if (!text && he.tagName === 'INPUT') {
        const row = he.closest('li.el-cascader-node, tr, label');
        if (row) {
          const t = row.matches('li.el-cascader-node')
            ? ((row.querySelector(':scope > .el-cascader-node__label') as HTMLElement | null)?.textContent ?? '')
            : (row.textContent ?? '');
          text = t.trim().slice(0, 40);
        }
      }
      const item: Record<string, unknown> = {
        selector: s.selector,
        tag: he.tagName.toLowerCase(),
        // 归一化不用具名箭头函数赋值：tsx/esbuild 的 keepNames 会给它注入 __name 助手，
        // 而 evaluate 的函数体被序列化到浏览器上下文执行，那里没有 __name → 整个
        // evaluate 抛 ReferenceError，元素清单整体失效（dev/tsx 独有，tsc 产物无此注入）。
        box: [
          Math.round(Math.min(1000, Math.max(0, (r.left / vw) * 1000))),
          Math.round(Math.min(1000, Math.max(0, (r.top / vh) * 1000))),
          Math.round(Math.min(1000, Math.max(0, (r.right / vw) * 1000))),
          Math.round(Math.min(1000, Math.max(0, (r.bottom / vh) * 1000))),
        ],
      };
      if (text) item.text = text;
      const ph = he.getAttribute('placeholder');
      if (ph) item.placeholder = ph;
      const it = (he as HTMLInputElement).type;
      if (he.tagName === 'INPUT' && it) item.inputType = it;
      // 选中/填写结果的验证通道：级联选中后 value 是完整路径，截图窄框截断显示
      // 前缀会让模型误判「选错单位」而空转到轮次耗尽（prod228 11-08 实录：radio 已
      // 选上、abort 时值是对的，模型因截图只见前缀始终不敢判 done）。密码型不外泄。
      if (he.tagName === 'INPUT' && it !== 'password') {
        const v = (he as HTMLInputElement).value;
        if (v) item.value = v.slice(0, 60);
      }
      if ((he as HTMLButtonElement).disabled) item.disabled = true;
      out.push(item);
      if (out.length >= 60) break;
    }
    return out;
  }, SYNTH_SELECTOR_SRC)) as Array<Record<string, unknown>>;
  return raw as unknown as ElementInfo[];
}
