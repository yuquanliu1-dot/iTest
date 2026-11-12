/**
 * Chinese font guard for the api image.
 *
 * 2026-11-10 prod228 live record: evidence screenshots of exploratory testing sessions are rendered by in-container chromium,
 * but api.Dockerfile installs no CJK font at all -> all Chinese renders as tofu boxes ->
 *  1. the AI reports "missing font" as a defect (one exploration produced 3 bogus defects);
 *  2. evidence screenshots are unreadable, so the phenomenon is invisible during review.
 *
 * The regression happens at the "packaged into the image" layer (invisible in the source tree), so we directly assert
 * that the Dockerfile's apt install list contains CJK font packages -- same approach as recorder-extension-locales.test.ts asserting the COPY list.
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
