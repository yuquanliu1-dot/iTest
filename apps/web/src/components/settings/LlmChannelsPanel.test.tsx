import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// api.settings.llm / putLlm are replaced: everything else uses the real implementation (i18n / stores all import from it).
const llmGet = vi.fn();
const llmPut = vi.fn();
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: {
        ...actual.api.settings,
        llm: () => llmGet(),
        putLlm: (body: unknown) => llmPut(body),
        testConnection: () => Promise.resolve({ ok: true, latencyMs: 1 }),
      },
    },
  };
});

import LlmChannelsPanel from './LlmChannelsPanel';
import '../../i18n';

const CHANNEL_1 = {
  id: 'ch-1', name: '主渠道', provider: 'anthropic', model: 'claude-sonnet-4-6',
  baseUrl: null, maxTokens: null, apiKeyMasked: 'sk-a****bcde', hasApiKey: true,
};
const CHANNEL_2 = {
  id: 'ch-2', name: '视觉渠道', provider: 'openai', model: 'qwen-vl',
  baseUrl: null, maxTokens: null, apiKeyMasked: 'sk-d****ghij', hasApiKey: true,
};

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LlmChannelsPanel />
    </QueryClientProvider>,
  );
}

/** Open the edit dialog of the nth channel (0-based). */
async function openEditDialog(index = 0) {
  fireEvent.click(screen.getAllByRole('button', { name: '编辑渠道' })[index]!);
  return screen.findByRole('dialog');
}

beforeEach(() => {
  llmGet.mockReset();
  llmPut.mockReset();
  llmGet.mockResolvedValue({
    defaultChannelId: 'ch-1',
    visionChannelId: 'ch-2',
    channels: [CHANNEL_1, CHANNEL_2],
  });
  llmPut.mockResolvedValue({ ok: true });
});

describe('LlmChannelsPanel 渠道编辑落库', () => {
  it('编辑改名 → 点弹窗「保存」立即 PUT，新名字进 payload', async () => {
    renderPanel();
    await screen.findAllByText('主渠道');

    const dialog = await openEditDialog();
    fireEvent.change(within(dialog).getByDisplayValue('主渠道'), { target: { value: '改名后的渠道' } });
    // Changing the name alone sends no request: persistence happens when "Save" is clicked
    expect(llmPut).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(llmPut).toHaveBeenCalledTimes(1));
    expect(llmPut.mock.calls[0]![0]).toMatchObject({
      defaultChannelId: 'ch-1',
      visionChannelId: 'ch-2',
      channels: [
        { id: 'ch-1', name: '改名后的渠道', provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { id: 'ch-2', name: '视觉渠道', provider: 'openai', model: 'qwen-vl' },
      ],
    });
    // Empty apiKey = the server keeps the stored original by id; the mask is not sent back
    expect(llmPut.mock.calls[0]![0].channels[0].apiKey).toBeUndefined();
  });

  it('弹窗保存成功后列表显示新名字', async () => {
    renderPanel();
    await screen.findAllByText('主渠道');

    const dialog = await openEditDialog();
    fireEvent.change(within(dialog).getByDisplayValue('主渠道'), { target: { value: '改名后的渠道' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.getAllByText('改名后的渠道').length).toBeGreaterThan(0));
  });

  it('弹窗保存失败 → 列表保持旧名，不显示未落库的改动', async () => {
    llmPut.mockRejectedValueOnce(new Error('network down'));
    renderPanel();
    await screen.findAllByText('主渠道');

    const dialog = await openEditDialog();
    fireEvent.change(within(dialog).getByDisplayValue('主渠道'), { target: { value: '改名后的渠道' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(llmPut).toHaveBeenCalledTimes(1));
    expect(screen.queryAllByText('改名后的渠道')).toHaveLength(0);
  });

  it('面板底部「保存」→ PUT 带上默认/视觉渠道指派', async () => {
    renderPanel();
    await screen.findAllByText('主渠道');

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'ch-2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(llmPut).toHaveBeenCalledTimes(1));
    expect(llmPut.mock.calls[0]![0]).toMatchObject({ defaultChannelId: 'ch-2', visionChannelId: 'ch-2' });
  });
});
