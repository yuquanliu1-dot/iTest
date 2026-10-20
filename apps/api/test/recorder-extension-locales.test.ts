/**
 * 录制扩展包完整性守卫。
 *
 * 2026-10-20 prod228 实测踩坑：用户装扩展报
 *   "Default locale was specified, but _locales subtree is missing"
 * 根因是 api.Dockerfile 的 COPY 清单没拷 apps/recorder/_locales，镜像里扩展根目录
 * 缺该子树，而 manifest.json 声明了 default_locale:"zh_CN"——Chrome 装载时校验失败，
 * 整个扩展拒绝安装。
 *
 * 这里从两个层面各挡一道：
 *  1. 源码树：manifest.default_locale 指向的 _locales/<locale>/messages.json 必须存在；
 *  2. Dockerfile：api.Dockerfile 的 COPY 清单必须覆盖 _locales，否则镜像里必然缺。
 *
 * 第 2 条是关键：光有第 1 条，源码明明齐全却照样发出版本装不上——回归就发生在
 * 「打包进镜像」这一层。
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
    // 文件本身得是合法 JSON，否则 Chrome 解析 _locales 时同样报错
    expect(() => JSON.parse(fs.readFileSync(msg, 'utf8'))).not.toThrow();
  });

  it('manifest 用 __MSG_ 占位符的字段在 _locales 里有对应 key', () => {
    // description 走 __MSG_extDesc__，缺 key 时 Chrome 显示空描述
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
