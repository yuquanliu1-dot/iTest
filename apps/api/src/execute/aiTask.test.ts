import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt, referencesCredential } from './aiTask.js';

describe('assembleSystemPrompt - 凭据段门控', () => {
  it('credEnabled=false → 提示词不含任何凭据形态', () => {
    const p = assembleSystemPrompt({ credEnabled: false, manifest: '' });
    expect(p).not.toContain('ITEST_');
    expect(p).not.toContain('凭据');
  });

  it('credEnabled=false + 有 manifest → 清单也不出现', () => {
    const p = assembleSystemPrompt({
      credEnabled: false,
      manifest: '- web（默认） https://x 已配置凭据',
    });
    expect(p).not.toContain('ITEST_');
    expect(p).not.toContain('已配置凭据');
  });

  it('credEnabled=true + 有 manifest → 含清单与 @服务名 占位符形态', () => {
    const p = assembleSystemPrompt({
      credEnabled: true,
      manifest: '- web（默认） https://x 已配置凭据',
    });
    expect(p).toContain('ITEST_');
    expect(p).toContain('@服务名');
    expect(p).toContain('已配置凭据');
  });

  it('credEnabled=true 无 manifest → 含裸占位符文案', () => {
    const p = assembleSystemPrompt({ credEnabled: true, manifest: '' });
    expect(p).toContain('__ITEST_USERNAME__');
    expect(p).toContain('__ITEST_PASSWORD__');
  });

  it('mobile=true → 恒无凭据段', () => {
    const p = assembleSystemPrompt({ mobile: true, credEnabled: true, manifest: '- web 已配置凭据' });
    expect(p).not.toContain('ITEST_');
    expect(p).not.toContain('凭据');
  });

  it('数据忠实守则恒在（负向用例不被 AI 改写表单值）', () => {
    const p = assembleSystemPrompt({ credEnabled: false, manifest: '' });
    expect(p).toContain('数据忠实');
  });
});

describe('referencesCredential - 占位符形态识别', () => {
  it('识别哨兵形态', () => {
    expect(referencesCredential('填入 __ITEST_USERNAME__')).toBe(true);
    expect(referencesCredential('填入 __ITEST_PASSWORD__')).toBe(true);
    expect(referencesCredential('填入 __ITEST_STEP_SECRET__')).toBe(true);
  });

  it('识别带 @ref 形态', () => {
    expect(referencesCredential('填入 __ITEST_USERNAME@web__')).toBe(true);
    expect(referencesCredential('填入 __ITEST_PASSWORD@backend__')).toBe(true);
  });

  it('识别花括号 / 裸名形态', () => {
    expect(referencesCredential('填入 {{ITEST_PASSWORD}}')).toBe(true);
    expect(referencesCredential('填入 ITEST_USERNAME')).toBe(true);
  });

  it('普通文本不误判', () => {
    expect(referencesCredential('在账号框填入管理员账号')).toBe(false);
    expect(referencesCredential('识别验证码图片中的字符并填入验证码输入框')).toBe(false);
  });
});
