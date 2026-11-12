/**
 * evaluate tool (pi chain D1): runs a JS snippet inside the SUT page for state forensics —
 * reading React/Vue internal state, checking DOM structure, verifying form values, i.e. evidence
 * that screenshots cannot reveal.
 *
 * Three sandbox layers (able to run JS in the page ≠ free rein; two layers would not suffice):
 * - L1 static scan: source containing traces of network/storage/dialog/navigation/dynamic
 *   execution is rejected outright, listing the matched forbidden items. Navigation forms
 *   (location.href= / assign / replace) are banned too — evaluate would be a backdoor around
 *   the navigate scope gate; the 2026-11-10 prod boundary incident applies here equally.
 * - L2 lexical shadowing: the script is wrapped in an IIFE where identifiers such as
 *   fetch/XHR/WebSocket/open/eval/Function are shadowed by local throw-stubs — alias/case
 *   workarounds of L1 still blow up at runtime. Globals are deliberately not hijacked so the
 *   SUT's own requests stay untouched.
 * - L3 runtime limits: 10s race timeout + return value must be JSON-serializable and ≤32KB
 *   (DOM nodes/circular refs are rejected).
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { toolErr, toolOk } from './result.js';
import { logger } from '../../../logger.js';

const EVAL_TIMEOUT_MS = 10_000;
const EVAL_RESULT_MAX = 32 * 1024;

/** L1 forbidden-item list: any hit rejects. */
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
      // L1 static scan
      const hits = EVAL_FORBIDDEN.filter((p) => p.re.test(expr)).map((p) => p.why);
      if (hits.length > 0) {
        return toolErr(
          `表达式含禁用操作（${hits.join('、')}）`,
          `evaluate: error 表达式包含禁用操作（${hits.join('、')}）。本工具只做只读取证；需要导航用 navigate，需要点/填用 click/fill。`,
        );
      }
      // L2 lexical shadowing: local identifiers shadowed as throw-stubs (globals untouched). The
      // expression is wrapped in return — statement-form input surfaces as a syntax error as-is.
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
      // L3 runtime: 10s race + serializable + size cap
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
        // Result summary = the return value itself (the trail body must show what the script found).
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
