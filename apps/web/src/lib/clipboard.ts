/** Copy text to the system clipboard, returning success (callers toast based on it).
 *  navigator.clipboard is only available in secure contexts (https / localhost): when accessed over http://LAN-IP
 *  it is undefined, and the property access throws a TypeError synchronously — before .catch is attached, presenting as "click does nothing".
 *  Try the clipboard API first; fall back to the execCommand temporary-textarea approach when unavailable/rejected. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied etc. → fall back to execCommand
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
