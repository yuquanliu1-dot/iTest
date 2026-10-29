/** 复制文本到系统剪贴板，返回是否成功（调用方据此 toast）。
 *  navigator.clipboard 仅安全上下文（https / localhost）可用：经 http://局域网IP 访问时
 *  它是 undefined，且属性访问同步抛 TypeError——发生在 .catch 挂上前，表现为「点击无反应」。
 *  这里先试 clipboard API，不可用/被拒时回落 execCommand 临时 textarea 方案。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒等 → 走 execCommand 回退
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
