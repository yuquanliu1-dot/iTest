/**
 * Recorder extension package integrity guard.
 *
 * 2026-10-20 field gotcha on prod228: users installing the extension got
 *   "Default locale was specified, but _locales subtree is missing"
 * The root cause was api.Dockerfile's COPY list not copying apps/recorder/_locales, so the image's extension root
 * lacked that subtree while manifest.json declared default_locale:"zh_CN" — Chrome failed its load-time validation
 * and refused to install the entire extension.
 *
 * Two layers of defense here:
 *  1. Source tree: the _locales/<locale>/messages.json that manifest.default_locale points at must exist;
 *  2. Dockerfile: api.Dockerfile's COPY list must cover _locales, otherwise the image will certainly lack it.
 *
 * Item 2 is the critical one: with only item 1, the source is fine yet a released version still fails to install —
 * the regression happens at the "packaged into the image" layer.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(API_DIR, '..', '..');
const RECORDER_ROOT = path.join(REPO_ROOT, 'apps', 'recorder');
const API_DOCKERFILE = path.join(REPO_ROOT, 'infra', 'docker', 'api.Dockerfile');

interface Manifest {
  default_locale?: string;
  name?: string;
  description?: string;
}

describe('录制扩展 manifest 与 _locales 契约', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(RECORDER_ROOT, 'manifest.json'), 'utf8'),
  ) as Manifest;

  it('manifest 声明了 default_locale', () => {
    expect(manifest.default_locale).toBeTruthy();
  });

  it('default_locale 对应的 _locales/<locale>/messages.json 存在', () => {
    const locale = manifest.default_locale!;
    const msg = path.join(RECORDER_ROOT, '_locales', locale, 'messages.json');
    expect(fs.existsSync(msg), `缺少 ${msg}——Chrome 会拒绝安装扩展`).toBe(true);
    // The file itself must be valid JSON, otherwise Chrome errors while parsing _locales too
    expect(() => JSON.parse(fs.readFileSync(msg, 'utf8'))).not.toThrow();
  });

  it('manifest 用 __MSG_ 占位符的字段在 _locales 里有对应 key', () => {
    // description goes through __MSG_extDesc__; when the key is missing Chrome shows an empty description
    const locale = manifest.default_locale!;
    const messages = JSON.parse(
      fs.readFileSync(path.join(RECORDER_ROOT, '_locales', locale, 'messages.json'), 'utf8'),
    ) as Record<string, { message?: string }>;
    const placeholders = [manifest.description ?? ''].filter((s) => s.includes('__MSG_'));
    for (const ph of placeholders) {
      const key = /__MSG_([A-Za-z0-9_]+)__/.exec(ph)?.[1];
      expect(key, `无法从 ${ph} 解析出消息 key`).toBeTruthy();
      expect(messages[key!], `_locales/${locale}/messages.json 缺 key ${key}`).toBeTruthy();
      expect(messages[key!]?.message).toBeTruthy();
    }
  });

  it('api.Dockerfile 的 COPY 清单覆盖 _locales（否则镜像里必缺）', () => {
    const dockerfile = fs.readFileSync(API_DOCKERFILE, 'utf8');
    expect(dockerfile).toMatch(/COPY\s+apps\/recorder\/_locales\s/);
  });
});
