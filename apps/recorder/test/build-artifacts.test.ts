import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 两个内容脚本模块图根：content/recorder.js 用 chrome.runtime.getURL() 动态 import 它们。
 *  content script 跑在 isolated world 里，没有 node_modules 解析器——模块图里只要出现
 *  裸说明符（'@medv/finder'），import 就抛 ERR_MODULE_NOT_FOUND，整个 IIFE 死掉，
 *  manager 永不 start，页面面板永远停在「0 步」。
 *  2026-10-20 病例：tsc 的平铺产物覆盖了 esbuild 的 bundle，而 vitest 能解析 node_modules，
 *  所以单测全绿却录不到任何步骤。这条断言直接盯「Chromium 实际会加载的那份文件」。 */
const ENTRIES = ['modules/recorder-manager.js', 'modules/picker.js'];

const SPEC_RE = /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/** 从入口沿相对说明符递归走完整个模块图，收集不可解析的裸说明符。 */
function reachableBareSpecifiers(entryRel: string): string[] {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const walk = (abs: string): void => {
    if (seen.has(abs)) return;
    seen.add(abs);
    let src: string;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      return;
    }
    const specifiers = [
      ...Array.from(src.matchAll(SPEC_RE), (m) => m[1]!),
      ...Array.from(src.matchAll(BARE_IMPORT_RE), (m) => m[1]!),
    ];
    for (const spec of specifiers) {
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(abs), spec));
      else if (!spec.startsWith('/')) bare.add(spec);
    }
  };
  walk(path.join(ROOT, entryRel));
  return Array.from(bare).sort();
}

describe('内容脚本产物自包含', () => {
  for (const entry of ENTRIES) {
    it(`${entry} 的模块图不含裸说明符`, () => {
      const abs = path.join(ROOT, entry);
      expect(
        existsSync(abs),
        `${entry} 不存在——先跑 pnpm --filter @itest/recorder build`,
      ).toBe(true);
      expect(reachableBareSpecifiers(entry)).toEqual([]);
    });
  }
});