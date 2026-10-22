import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

// api client 只替换 extensionVersion，其余走真实实现（auth store 也从这里 import）。
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

/** 组件挂载后发出的 ping 带一个 id；pong 必须回同一个 id 才会被采纳。 */
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
  // 等 ping 发出（effect 跑完）再回 pong
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

  // 修复前：单向比较把「装的更新」判成绿色 ready，用户以为已是最新。
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
