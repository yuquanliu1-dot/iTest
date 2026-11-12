// Console (web app) address runtime config: the popup stores it in chrome.storage, and background registers the bridge.js injection dynamically based on it.
// The pure-function part is split into its own module for direct vitest testing.

export const DEFAULT_CONSOLE_ORIGIN = 'http://localhost:5173';

/** Validates and normalizes user input into a console origin (e.g. http://192.168.1.10:5173); returns null when invalid */
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
