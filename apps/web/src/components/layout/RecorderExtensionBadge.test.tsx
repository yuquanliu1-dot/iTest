import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

// Only extensionVersion on the api client is replaced; everything else uses the real implementation (the auth store is imported from there too).
const extensionVersion = vi.fn<() => Promise<{ version: string }>>();
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      recorder: {
        ...actual.api.recorder,
        extensionVersion: () => extensionVersion(),
      },
    },
  };
});

import RecorderExtensionBadge from './RecorderExtensionBadge';
import { useAuthStore } from '../../stores/auth';

const PING_SOURCE = 'ita-web';
const PONG_SOURCE = 'ita-ext';

/** The ping sent after the component mounts carries an id; a pong must return the same id to be accepted. */
function installPingSpy(): { respond: (version: string | null) => void } {
  let lastPingId: string | null = null;
  const orig = window.postMessage.bind(window);
  const spy = vi.spyOn(window, 'postMessage').mockImplementation((msg: unknown, targetOrigin: unknown) => {
    if ((msg as { source?: string })?.source === PING_SOURCE) {
      lastPingId = (msg as { id: string }).id;
    }
    return orig(msg as string, targetOrigin as string);
  });

  return {
    respond(version) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: PONG_SOURCE, type: 'pong', id: lastPingId, version },
        }),
      );
    },
  };
}

async function renderBadge() {
  const ping = installPingSpy();
  render(<RecorderExtensionBadge />);
  // Wait for the ping to go out (effect has run) before responding with the pong
  await waitFor(() => expect(window.postMessage).toHaveBeenCalled());
  return ping;
}

describe('RecorderExtensionBadge 版本方向', () => {
  beforeEach(() => {
    extensionVersion.mockReset();
    useAuthStore.setState({ isAuthenticated: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('已装版本旧于部署版本 → 提示可升级', async () => {
    extensionVersion.mockResolvedValue({ version: '0.0.3' });
    const ping = await renderBadge();
    await act(async () => {
      ping.respond('0.0.2');
    });

    await waitFor(() => expect(screen.getByText('扩展可升级 v0.0.3')).toBeTruthy());
  });

  it('已装版本等于部署版本 → 绿色就绪态', async () => {
    extensionVersion.mockResolvedValue({ version: '0.0.3' });
    const ping = await renderBadge();
    await act(async () => {
      ping.respond('0.0.3');
    });

    await waitFor(() => expect(screen.getByText('录制扩展 v0.0.3')).toBeTruthy());
  });

  // Before the fix: the one-directional comparison judged "installed is newer" as green ready, making users believe they were up to date.
  it('已装版本新于部署版本 → 明确提示更新，不谎报就绪', async () => {
    extensionVersion.mockResolvedValue({ version: '0.0.2' });
    const ping = await renderBadge();
    await act(async () => {
      ping.respond('0.0.3');
    });

    await waitFor(() => expect(screen.getByText('录制扩展 v0.0.3（更新）')).toBeTruthy());
    expect(screen.queryByText('录制扩展 v0.0.3')).toBeNull();
  });

  it('ahead 态的弹层不提供下载入口（下载即降级）', async () => {
    extensionVersion.mockResolvedValue({ version: '0.0.2' });
    const ping = await renderBadge();
    await act(async () => {
      ping.respond('0.0.3');
    });

    await waitFor(() => expect(screen.getByText('录制扩展 v0.0.3（更新）')).toBeTruthy());
    await act(async () => {
      screen.getByRole('button', { name: '录制扩展状态' }).click();
    });

    await waitFor(() => expect(screen.getByText('扩展版本较新')).toBeTruthy());
    expect(screen.getByText('已装 v0.0.3 → 服务器 v0.0.2')).toBeTruthy();
    expect(screen.queryByText('下载扩展 zip')).toBeNull();
  });

  it('update 态提供下载入口', async () => {
    extensionVersion.mockResolvedValue({ version: '0.0.3' });
    const ping = await renderBadge();
    await act(async () => {
      ping.respond('0.0.2');
    });

    await waitFor(() => expect(screen.getByText('扩展可升级 v0.0.3')).toBeTruthy());
    await act(async () => {
      screen.getByRole('button', { name: '录制扩展状态' }).click();
    });

    await waitFor(() => expect(screen.getByText('下载扩展 zip')).toBeTruthy());
  });
});
