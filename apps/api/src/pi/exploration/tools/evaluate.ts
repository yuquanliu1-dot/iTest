/**
 * evaluate 工具（pi 链路 D1）：在被测页面里跑一段 JS 做状态取证——读 React/Vue 内部状态、
 * 检查 DOM 结构、核对表单值这类「截图看不出来」的证据。
 *
 * 三层沙箱（页面里能跑 JS ≠ 能为所欲为；两层都不够就别给这工具）：
 * - L1 静态扫描：源码含网络/存储/弹窗/导航/动态执行的痕迹直接拒收，并列出命中的禁用项。
 *   导航类（location.href= / assign / replace）一并禁——evaluate 是绕过 navigate 范围闸的后门，
 *   2026-11-10 prod 越界事故的教训同样适用于这里。
 * - L2 词法遮蔽：脚本包在 IIFE 里，fetch/XHR/WebSocket/open/eval/Function 等标识符被局部
 *   「抛错桩」遮蔽——绕过 L1 的别名/大小写引用到它们时照样在运行期炸掉。刻意不劫持全局，
 *   不干扰被测系统自身的请求。
 * - L3 运行期限制：10s 竞速超时 + 返回值必须可 JSON 序列化且 ≤32KB（DOM 节点/循环引用判废）。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { toolErr, toolOk } from './result.js';
import { logger } from '../../../logger.js';

const EVAL_TIMEOUT_MS = 10_000;
const EVAL_RESULT_MAX = 32 * 1024;

/** L1 禁用项清单：命中即拒。 */
const EVAL_FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /\bfetch\s*\(/, why: 'fetch()（网络请求）' },
  { re: /XMLHttpRequest/, why: 'XMLHttpRequest（网络请求）' },
  { re: /WebSocket/, why: 'WebSocket（网络连接）' },
  { re: /sendBeacon/, why: 'sendBeacon（外发）' },
  { re: /document\.cookie/, why: 'document.cookie（凭据读取）' },
  { re: /localStorage/, why: 'localStorage' },
  { re: /sessionStorage/, why: 'sessionStorage' },
  { re: /indexedDB/, why: 'indexedDB' },
  { re: /\beval\s*\(/, why: 'eval()（动态执行）' },
  { re: /\bFunction\s*\(/, why: 'Function()（动态执行）' },
  { re: /importScripts/, why: 'importScripts' },
  { re: /location\s*(?:\.href|=|\.assign|\.replace)/, why: '页面导航（location）' },
  { re: /window\.open/, why: 'window.open（开新页）' },
];

export function createEvaluateTool(deps: { page: import('playwright-core').Page }) {
  return defineTool({
    name: 'evaluate',
    label: 'evaluate',
    description:
      '在当前页面执行一段 JS 表达式并返回 JSON 结果（读组件状态/DOM 结构/表单值等截图看不出的证据）。禁止网络、存储、cookie、页面导航、弹窗；返回值必须可 JSON 序列化且 ≤32KB；10s 超时。',
    promptGuidelines: ['只读取证用：优先读状态和值，不要试图修改页面；取证结论优先 report_finding 落库'],
    parameters: Type.Object({ expression: Type.String({ description: '单个 JS 表达式，如 document.querySelector("#app").__vue__.$data.length' }) }),
    executionMode: 'sequential',
    execute: async (_toolCallId, params) => {
      const expr = params.expression.trim();
      if (!expr) {
        return toolErr('表达式为空', 'evaluate: error expression 为空。');
      }
      // L1 静态扫描
      const hits = EVAL_FORBIDDEN.filter((p) => p.re.test(expr)).map((p) => p.why);
      if (hits.length > 0) {
        return toolErr(
          `表达式含禁用操作（${hits.join('、')}）`,
          `evaluate: error 表达式包含禁用操作（${hits.join('、')}）。本工具只做只读取证；需要导航用 navigate，需要点/填用 click/fill。`,
        );
      }
      // L2 词法遮蔽：局部标识符遮蔽为抛错桩（不劫持全局）。表达式以 return 包裹——语句形态
      // 解析失败会原样报语法错，模型自然改写成表达式。
      const src = `(async () => {
        const __deny = (n) => { throw new Error('evaluate 沙箱：禁止使用 ' + n); };
        const fetch = (...a) => __deny('fetch');
        const XMLHttpRequest = function () { __deny('XMLHttpRequest'); };
        const WebSocket = function () { __deny('WebSocket'); };
        const sendBeacon = (...a) => __deny('sendBeacon');
        const open = (...a) => __deny('window.open');
        const eval = (...a) => __deny('eval');
        const Function = (...a) => __deny('Function');
        return (${expr});
      })()`;
      // L3 运行期：10s 竞速 + 可序列化 + 封顶
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          deps.page.evaluate(src),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('evaluate 超时（10s）——表达式可能含长轮询或死循环')), EVAL_TIMEOUT_MS);
          }),
        ]);
        let json: string;
        try {
          json = JSON.stringify(result) ?? 'undefined';
        } catch {
          return toolErr(
            '返回值不可 JSON 序列化',
            'evaluate: error 返回值不可 JSON 序列化（DOM 节点/循环引用/BigInt）。请只返回可序列化的数据。',
          );
        }
        if (json.length > EVAL_RESULT_MAX) {
          return toolErr(
            `返回值过大（${json.length} 字符 > 32KB）`,
            `evaluate: error 返回值过大（${json.length} 字符 > 32KB）。缩小取值范围（如只取 length 或单个字段）。`,
          );
        }
        // 结果摘要 = 返回值本身（留痕正文要能看出「这脚本查出了什么」）。
        return toolOk(`返回 ${json.slice(0, 160)}`, `evaluate 结果：${json}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.info({ err: msg.slice(0, 120) }, 'exploration evaluate failed');
        return toolErr(
          `执行失败：${msg.slice(0, 120)}`,
          `evaluate: error ${msg.slice(0, 200)}。语法错时改写成单个表达式；引用不存在的变量会 ReferenceError，先确认对象存在。`,
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
}
