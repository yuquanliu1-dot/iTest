/**
 * 浏览器动作类工具（pi 链路）：navigate / click / fill / press / select / scroll / back / wait。
 *
 * 闸门移植（语义与 legacy aiTask 逐字一致，实现见 execute/gates.ts）：
 * - 范围闸：navigate origin 白名单 = 起点 origin 唯一，刻意不含环境 loginUrl origin——
 *   2026-11-10 prod 实证把它加进白名单等于重开「导航到真实系统 + 真凭据登录 + 写数据」路径。
 *   起点 origin 不可解析 → 白名单为空数组 = navigate 全拒（保守收口）。
 * - 破坏性闸：click 前按被点元素的可见文本判定（text+placeholder+value+selector 拼接，
 *   元素读不到时 selector 字符串仍参与判定）。默认拒；allow_destructive 显式开关是唯一
 *   授权来源，章程说辞不算授权。二次确认弹窗：Playwright 无 dialog 监听时自动 dismiss——
 *   刻意不注册任何 dialog 监听，保持这个默认（原生 confirm 永远不会被「确认」）。
 * - 凭据替换：fill 的占位符（哨兵/花括号形态）在工具内部替换为真实值；留痕 value 永远是
 *   替换前的字面量（trailStepOf 读工具入参原值）。EnvMissing/SecretMissing 是终止性错误：
 *   工具不 throw（铁律），改走 onFatal 回调让 runner 终止会话——重试只会烧轮次。
 * - 脆弱 selector 闸：XPath/位置链事前拒收（screenshot/read_text 同一口径）。
 *
 * 铁律（pi 工具层通用）：工具永不 throw；全部 executionMode:'sequential'（证据帧竞态防线）。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { isOpenDropdownFilter } from '../../../execute/dropdownFilter.js';
import { brittleSelectorReason, destructiveActionReason, scopeViolationReason } from '../../../execute/gates.js';
import { toolErr, toolOk } from './result.js';
import type { ToolDeps } from './index.js';

/** 动作后短暂稳定（与 legacy settleAfterAction 同参）：导航/重渲染落地后再进下一个动作。 */
async function settleAfterAction(page: ToolDeps['page']): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => undefined);
  await page.waitForTimeout(150);
}

/** 脆弱 selector 统一拒收文本（click/fill/screenshot/read_text 同一措辞）。 */
function brittleReject(tool: string, sel: string, reason: string): string {
  return `${tool} ${sel}: error 脆弱 selector 被拒（${reason}）。改用元素清单里给出的 selector。`;
}

export function createNavigateTool(deps: ToolDeps) {
  return defineTool({
    name: 'navigate',
    label: 'navigate',
    description: '导航到指定 URL。仅接受 http/https 绝对地址，且不得离开被测站点的起点域名——越界会被平台拒收。',
    promptGuidelines: ['起点页面打不开时如实结束并说明，不要改去任何其它站点或凭记忆换地址'],
    parameters: Type.Object({ url: Type.String({ description: '绝对地址，如 https://host/path' }) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const url = params.url.trim();
      if (!/^https?:\/\//.test(url)) {
        return toolErr('导航地址非法（只接受 http/https 绝对地址）', `navigate ${url}: error 仅接受 http/https 绝对地址。`);
      }
      const reason = scopeViolationReason(url, deps.scopeOrigins);
      if (reason) {
        return toolErr(
          `越界被拒：${reason}`,
          `navigate ${url}: error 探索范围被拒（${reason}）。只能在起点站点的域名内探索；若起点页面打不开，如实结束并说明，不要改去其它站点。`,
        );
      }
      try {
        await deps.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // 与 legacy init-goto 对齐：等 SPA hydrate，长连接页面 5s 兜底不阻塞。
        await deps.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
        return toolOk(
          `已打开 ${deps.page.url()}`,
          `navigate ${url}: ok（当前 URL：${deps.page.url()}）。下一步调用 observe 获取页面截图与元素清单。`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(
          `打开失败：${msg.slice(0, 120)}`,
          `navigate ${url}: error ${msg.slice(0, 200)}。起点页面打不开/不可达时如实结束并说明，不要改去其它站点。`,
        );
      }
    },
  });
}

export function createClickTool(deps: ToolDeps) {
  return defineTool({
    name: 'click',
    label: 'click',
    description: '点击页面元素。target 用元素清单里给出的 selector（不要自造 XPath/位置链，会被拒收）。',
    promptGuidelines: [
      '点击前确认目标在最近一次 observe 的元素清单里；点击后必先 observe 确认页面变化再决策',
      '被平台判为破坏性/不可逆的入口会被拒收——不要重试或改写措辞绕过，改为 report_finding 描述该入口的风险',
    ],
    parameters: Type.Object({ target: Type.String({ description: '目标元素 CSS selector（取自元素清单）' }) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const target = params.target.trim();
      const brittle = brittleSelectorReason(target);
      if (brittle) {
        return toolErr(`脆弱 selector 被拒（${brittle}）`, brittleReject('click', target, brittle));
      }
      // 破坏性闸：可见文本判定（text+placeholder+value+selector 拼接；元素读不到时 selector
      // 字符串仍参与判定——legacy 同口径）。判定读不到不误伤（放行）。
      let targetText = '';
      try {
        const info = await deps.page
          .locator(target)
          .first()
          .evaluate((el) => ({
            text: (el.textContent ?? '').trim().slice(0, 80),
            placeholder: el.getAttribute('placeholder') ?? '',
            value: (el as HTMLInputElement).value?.slice(0, 80) ?? '',
          }));
        targetText = [info?.text, info?.placeholder, info?.value, target].filter(Boolean).join(' ');
      } catch {
        targetText = target;
      }
      const reason = destructiveActionReason(targetText);
      if (reason && deps.allowDestructive !== true) {
        return toolErr(
          `破坏性操作被拒（${reason}）`,
          `click ${targetText.slice(0, 60)}: error 该目标被平台判为破坏性/不可逆操作（${reason}），已机械拒收。不要重试或改写措辞绕过；改为 report_finding 描述该入口的风险与缺失的确认机制。`,
        );
      }
      try {
        await deps.page.locator(target).first().click({ timeout: 5000, force: true });
        await settleAfterAction(deps.page);
        return toolOk(
          `已点击，当前页面 ${deps.page.url()}`,
          `click ${target}: ok（当前 URL：${deps.page.url()}）。先 observe 确认页面变化。`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(
          `点击失败：${msg.slice(0, 120)}`,
          `click ${target}: error ${msg.slice(0, 200)}。先 observe 核对当前页面（弹窗/跳转/加载中都会让目标消失）。`,
        );
      }
    },
  });
}

export function createFillTool(deps: ToolDeps) {
  return defineTool({
    name: 'fill',
    label: 'fill',
    description: '向输入框填入文本。登录凭据必须用平台给定的占位符字面量（平台替换为真实值），绝不要猜测或输出真实凭据。',
    promptGuidelines: ['填写后先确认返回的实际值与目标一致再继续；远程搜索下拉（已展开的过滤框）平台会自动跳过失焦'],
    parameters: Type.Object({
      target: Type.String({ description: '目标输入框 CSS selector（取自元素清单）' }),
      value: Type.String({ description: '要填入的文本（凭据用占位符字面量）' }),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const target = params.target.trim();
      const rawValue = params.value;
      const brittle = brittleSelectorReason(target);
      if (brittle) {
        return toolErr(`脆弱 selector 被拒（${brittle}）`, brittleReject('fill', target, brittle));
      }
      let realValue = rawValue;
      try {
        realValue = deps.valueSub ? deps.valueSub(rawValue) : rawValue;
      } catch (e) {
        // 凭据缺失是环境级硬错误（EnvMissing/SecretMissing，可行动的配置指引在 message 里）：
        // 反馈给模型只会让它换 selector 空转烧轮次——终止会话（onFatal），此处照常回错误行。
        const err = e instanceof Error ? e : new Error(String(e));
        deps.onFatal?.(err);
        return toolErr(`凭据缺失：${err.message.slice(0, 120)}`, `fill ${target}: error ${err.message}`);
      }
      const substituted = realValue !== rawValue;
      try {
        const loc = deps.page.locator(target).first();
        await loc.fill('', { timeout: 5000 });
        await loc.pressSequentially(realValue, { delay: 20 });
        // 已展开下拉的过滤输入框不能 blur：blur 会清空查询词、关掉候选面板（远程搜索下拉致命）。
        // 判定在打字之后——此时面板才可能处于展开态（legacy 同序）。
        const keepOpen = await isOpenDropdownFilter(loc);
        if (!keepOpen) {
          // React 受控表单常在 blur 时才提交 state / 触发校验。
          await deps.page.keyboard.press('Tab').catch(() => undefined);
          await deps.page.waitForTimeout(80);
        }
        // 回读确认：DOM value 与目标不一致 → 反馈实际值供下轮修正（替换发生时不回显，防密码泄漏）。
        const actual = await loc.inputValue({ timeout: 3000 }).catch(() => '');
        if (actual !== realValue) {
          const tail = substituted
            ? `实际值与目标不一致（实际值长度 ${actual.length}）。`
            : `实际值 "${actual.slice(0, 80)}" 与目标 "${rawValue.slice(0, 80)}" 不一致。`;
          return toolErr(
            '回读值与目标不一致',
            `fill ${target}: ${tail}先 observe 核对目标框是否正确，必要时换 selector 重填。`,
          );
        }
        await settleAfterAction(deps.page);
        return toolOk(
          substituted ? '已填入（占位符已替换）' : '已填入',
          `fill ${target}: ok（已填入${substituted ? '（占位符已替换）' : ''}）。`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(
          `填写失败：${msg.slice(0, 120)}`,
          `fill ${target}: error ${msg.slice(0, 200)}。先 observe 核对当前页面与元素清单。`,
        );
      }
    },
  });
}

export function createPressTool(deps: ToolDeps) {
  return defineTool({
    name: 'press',
    label: 'press',
    description: '按下键盘键（页面级）：Enter 提交、Escape 关弹窗、Tab 切焦点等。键名用 Playwright 键名（Enter/Escape/Tab/ArrowDown...）。',
    parameters: Type.Object({ key: Type.String({ description: '键名，如 Enter、Escape、ArrowDown' }) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const key = params.key.trim().slice(0, 30);
      try {
        await deps.page.keyboard.press(key as never);
        await settleAfterAction(deps.page);
        return toolOk(
          `已按键 ${key}，当前页面 ${deps.page.url()}`,
          `press ${key}: ok（当前 URL：${deps.page.url()}）。Enter/Escape 常触发提交或关弹窗，先 observe。`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(
          `按键失败：${msg.slice(0, 120)}`,
          `press ${key}: error ${msg.slice(0, 200)}（键名需是 Playwright 键名）。`,
        );
      }
    },
  });
}

export function createSelectTool(deps: ToolDeps) {
  return defineTool({
    name: 'select',
    label: 'select',
    description: '在原生 <select> 下拉框中按可见文本或 value 选中一项。组件库自绘下拉（Element UI/Ant Design）不支持本工具——用 click 展开后再 click 选项。',
    parameters: Type.Object({
      target: Type.String({ description: '<select> 元素 CSS selector（取自元素清单）' }),
      value: Type.String({ description: '要选中的选项文本或 value' }),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const target = params.target.trim();
      const value = params.value;
      const brittle = brittleSelectorReason(target);
      if (brittle) {
        return { content: [{ type: 'text', text: brittleReject('select', target, brittle) }], details: undefined, isError: true };
      }
      const loc = deps.page.locator(target).first();
      try {
        const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
        if (tag !== 'select') {
          return toolErr(
            `目标不是原生 <select>（是 ${tag}）`,
            `select ${target}: error 目标不是原生 <select>（是 ${tag}）。组件库自绘下拉请用 click 展开、再 click 点选选项。`,
          );
        }
        // 先按 value 选，失败回落按可见文本选（模型给的多半是界面文案）。
        try {
          await loc.selectOption(value, { timeout: 3000 });
        } catch {
          await loc.selectOption({ label: value }, { timeout: 3000 });
        }
        await settleAfterAction(deps.page);
        return toolOk(
          `已选「${value.slice(0, 40)}」`,
          `select ${target}: ok（已选「${value.slice(0, 60)}」）。先 observe 确认联动结果。`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(
          `选择失败：${msg.slice(0, 120)}`,
          `select ${target}: error ${msg.slice(0, 200)}。确认目标在元素清单里，且选项文本/value 存在于该下拉。`,
        );
      }
    },
  });
}

export function createScrollTool(deps: ToolDeps) {
  return defineTool({
    name: 'scroll',
    label: 'scroll',
    description: '小步滚动页面（50~150px）。用于把视口外但页内有目标滚进元素清单——不要用滚动代替探索整页。',
    parameters: Type.Object({
      direction: Type.Union([Type.Literal('up'), Type.Literal('down')], { description: '滚动方向' }),
      amount: Type.Optional(Type.Number({ description: '像素数，缺省 120（50~150）' })),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const amount = Math.min(150, Math.max(50, Math.round(params.amount ?? 120)));
      const dy = params.direction === 'up' ? -amount : amount;
      try {
        await deps.page.mouse.wheel(0, dy);
        await deps.page.waitForTimeout(200);
        return toolOk(
          `已滚动 ${params.direction} ${amount}px`,
          `scroll ${params.direction} ${amount}px: ok。视口变了，元素清单需重新 observe 获取。`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(`滚动失败：${msg.slice(0, 120)}`, `scroll: error ${msg.slice(0, 200)}`);
      }
    },
  });
}

export function createBackTool(deps: ToolDeps) {
  return defineTool({
    name: 'back',
    label: 'back',
    description: '浏览器后退（回到上一页）。',
    parameters: Type.Object({}),
    executionMode: 'sequential',
    execute: async () => {
      try {
        await deps.page.goBack({ timeout: 10_000 }).catch(() => undefined);
        await settleAfterAction(deps.page);
        return toolOk(
          `已后退，当前页面 ${deps.page.url()}`,
          `back: ok（当前 URL：${deps.page.url()}）。先 observe 重新获取页面状态。`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(`后退失败：${msg.slice(0, 120)}`, `back: error ${msg.slice(0, 200)}`);
      }
    },
  });
}

export function createWaitTool(deps: ToolDeps) {
  return defineTool({
    name: 'wait',
    label: 'wait',
    description: '等待：传 ms 睡指定时长（≤5000ms）；传 selector 等该元素可见（≤5000ms）。页面加载中/骨架屏时先等待再 observe。',
    parameters: Type.Object({
      ms: Type.Optional(Type.Number({ description: '等待毫秒数（100~5000）' })),
      selector: Type.Optional(Type.String({ description: '等该元素变为可见（取自元素清单）' })),
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const sel = params.selector?.trim();
      try {
        if (sel) {
          const brittle = brittleSelectorReason(sel);
          if (brittle) {
            return toolErr(`脆弱 selector 被拒（${brittle}）`, brittleReject('wait', sel, brittle));
          }
          await deps.page.locator(sel).first().waitFor({ state: 'visible', timeout: 5000 });
          return toolOk(`元素已可见：${sel}`, `wait ${sel}: ok（元素已可见）。`);
        }
        const ms = Math.min(5000, Math.max(100, Math.round(params.ms ?? 1000)));
        await deps.page.waitForTimeout(ms);
        return toolOk(`已等待 ${ms}ms`, `wait ${ms}ms: ok。时间到，先 observe 获取最新页面状态。`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolErr(
          `等待失败：${msg.slice(0, 120)}`,
          `wait: error ${msg.slice(0, 200)}。元素迟迟不出现就先 observe 看当前实际页面。`,
        );
      }
    },
  });
}
