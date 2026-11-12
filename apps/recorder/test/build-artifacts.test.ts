import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Two content-script module graph roots: content/recorder.js dynamically imports them via chrome.runtime.getURL().
 *  Content scripts run in an isolated world with no node_modules resolver — as soon as a bare
 *  specifier ('@medv/finder') appears in the module graph, the import throws ERR_MODULE_NOT_FOUND, the whole IIFE dies,
 *  the manager never starts, and the on-page panel is stuck at "0 steps" forever.
 *  2026-10-20 incident: tsc's flattened output overwrote esbuild's bundle, and since vitest can resolve node_modules,
 *  all unit tests stayed green while no steps were ever recorded. This assertion watches exactly "the file Chromium will actually load". */
const ENTRIES = ['modules/recorder-manager.js', 'modules/picker.js'];

const SPEC_RE = /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/** Walks the entire module graph from the entry along relative specifiers, collecting unresolvable bare specifiers. */
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