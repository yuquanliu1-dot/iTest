// 中台地址运行时配置：popup 存 chrome.storage，background 据此动态注册 bridge.js 注入。
// 纯函数部分独立成模块，便于 vitest 直接测试。

export const DEFAULT_CONSOLE_ORIGIN = 'http://localhost:5173';

/** 校验并归一化用户输入为中台 origin（如 http://192.168.1.10:5173），非法返回 null */
export function normalizeConsoleOrigin(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** origin → content script match pattern */
export function originToMatchPattern(origin: string): string {
  return `${origin}/*`;
}
