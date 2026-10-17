import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = fileURLToPath(new URL('../src/i18n/locales/', import.meta.url));
const namespaces = ['common', 'auth', 'settings', 'projects', 'members', 'cases', 'groups', 'plans', 'reports'];

function flatKeys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? flatKeys(v, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

let failed = false;
for (const ns of namespaces) {
  const zh = JSON.parse(readFileSync(join(localesDir, `zh-CN/${ns}.json`), 'utf8'));
  const en = JSON.parse(readFileSync(join(localesDir, `en-US/${ns}.json`), 'utf8'));
  const zhKeys = new Set(flatKeys(zh));
  const enKeys = new Set(flatKeys(en));
  const missing = [...zhKeys].filter((k) => !enKeys.has(k));
  if (missing.length) {
    failed = true;
    console.error(`[i18n] ${ns}: en 缺少 ${missing.length} 个 key:`);
    for (const k of missing) console.error(`  - ${k}`);
  }
}
if (failed) process.exit(1);
console.log('[i18n] 所有命名空间 en ⊇ zh,key 完整。');