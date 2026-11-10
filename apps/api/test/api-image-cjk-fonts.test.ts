/**
 * api 镜像的中文字体守卫。
 *
 * 2026-11-10 prod228 实录：探索式测试会话的证据截图由容器内 chromium 渲染，
 * 而 api.Dockerfile 没装任何 CJK 字体 → 中文全渲染成方框 →
 *  1. AI 把「字体缺失」当成缺陷报出来（一次探索报了 3 条伪缺陷）；
 *  2. 证据截图不可读，复核时看不出现象。
 *
 * 回归发生在「打包进镜像」这一层（源码树里看不见），所以直接断言 Dockerfile 的
 * apt 安装清单含中文字体包，与 recorder-extension-locales.test.ts 断言 COPY 清单同法。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(API_DIR, '..', '..');
const API_DOCKERFILE = path.join(REPO_ROOT, 'infra', 'docker', 'api.Dockerfile');

describe('api 镜像 CJK 字体', () => {
  const dockerfile = fs.readFileSync(API_DOCKERFILE, 'utf8');

  it('apt 安装清单含 fontconfig 与中文字体包', () => {
    expect(dockerfile).toContain('fontconfig');
    expect(dockerfile).toContain('fonts-wqy-zenhei');
  });

  it('字体包在 runtime 的 apt-get install 块里（不是只出现在注释里）', () => {
    const installBlock = dockerfile
      .split(/\n(?=RUN )/)
      .find((b) => b.includes('apt-get install'));
    expect(installBlock, 'api.Dockerfile 里找不到 apt-get install 块').toBeTruthy();
    expect(installBlock).toContain('fontconfig');
    expect(installBlock).toContain('fonts-wqy-zenhei');
  });
});
