import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// api 只 mock 列表与卡片行内操作用的端点（建会话/建矩阵不在本用例范围）。
const { explorationList, explorationCancel, explorationRemove, explorationCreate } = vi.hoisted(() => ({
  explorationList: vi.fn(),
  explorationCancel: vi.fn(),
  explorationRemove: vi.fn(),
  explorationCreate: vi.fn(),
}));
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      explorations: {
        ...actual.api.explorations,
        list: explorationList,
        cancel: explorationCancel,
        remove: explorationRemove,
        create: explorationCreate,
      },
    },
  };
});

import Explorations from './Explorations';
import '../i18n';

const base = {
  projectId: 'p1',
  versionId: 'v1',
  title: '资产页探索',
  charter: '核查资产管理页的增删是否落库',
  persona: 'qa',
  startUrl: null,
  cancelRequested: false,
  allowDestructive: false,
  allowFaultInjection: false,
  windowWidth: null,
  windowHeight: null,
  summary: null,
  error: null,
  turnsUsed: 0,
  usage: null,
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z',
  createdBy: { id: 'u1', username: 'admin', displayName: '管理员' },
};

function mockList(items: Array<Record<string, unknown>>) {
  explorationList.mockResolvedValue({ items, total: items.length, page: 1, limit: 20 });
}

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/p/p1/v/v1/explorations']}>
        <Routes>
          <Route path="/p/:projectId/v/:versionId/explorations" element={<Explorations />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('探索会话列表卡片', () => {
  beforeEach(() => {
    explorationList.mockReset();
    explorationCancel.mockReset();
    explorationRemove.mockReset();
    explorationCreate.mockReset();
    explorationCancel.mockResolvedValue({ ok: true });
    explorationRemove.mockResolvedValue({ ok: true });
    explorationCreate.mockResolvedValue({ ...base, id: 's-new' });
  });

  it('卡片显示缺陷候选数徽标', async () => {
    mockList([{ ...base, id: 's1', status: 'completed', findingsCount: 3 }]);
    renderList();
    await waitFor(() => expect(screen.getByText('资产页探索')).toBeTruthy());
    const badge = screen.getByTitle('缺陷候选');
    expect(badge.textContent).toContain('3');
  });

  it('无缺陷候选 → 徽标记 0', async () => {
    mockList([{ ...base, id: 's1', status: 'completed' }]);
    renderList();
    await waitFor(() => expect(screen.getByText('资产页探索')).toBeTruthy());
    expect(screen.getByTitle('缺陷候选').textContent).toContain('0');
  });

  it('运行中会话：给取消按钮，不给删除（执行器还在写）', async () => {
    mockList([{ ...base, id: 's1', status: 'running', findingsCount: 0 }]);
    renderList();
    await waitFor(() => expect(screen.getByText('资产页探索')).toBeTruthy());
    expect(screen.getByLabelText('取消探索')).toBeTruthy();
    expect(screen.queryByLabelText('删除会话')).toBeNull();
    expect(screen.queryByLabelText('以此章程重跑')).toBeNull();
  });

  it('终态会话：给重跑与删除按钮', async () => {
    mockList([{ ...base, id: 's1', status: 'completed', findingsCount: 1 }]);
    renderList();
    await waitFor(() => expect(screen.getByText('资产页探索')).toBeTruthy());
    expect(screen.getByLabelText('以此章程重跑')).toBeTruthy();
    expect(screen.getByLabelText('删除会话')).toBeTruthy();
    expect(screen.queryByLabelText('取消探索')).toBeNull();
  });

  it('点取消 → 调 cancel 接口', async () => {
    mockList([{ ...base, id: 's1', status: 'running', findingsCount: 0 }]);
    renderList();
    await waitFor(() => expect(screen.getByText('资产页探索')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('取消探索'));
    await waitFor(() => expect(explorationCancel).toHaveBeenCalledWith('s1'));
  });

  it('点重跑 → 以同一章程建新会话（透传人格与授权位）', async () => {
    mockList([
      { ...base, id: 's1', status: 'completed', findingsCount: 0, allowDestructive: true, allowFaultInjection: true },
    ]);
    renderList();
    await waitFor(() => expect(screen.getByText('资产页探索')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('以此章程重跑'));
    await waitFor(() => expect(explorationCreate).toHaveBeenCalled());
    const arg = explorationCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.charter).toBe('核查资产管理页的增删是否落库');
    expect(arg.persona).toBe('qa');
    expect(arg.allowDestructive).toBe(true);
    expect(arg.allowFaultInjection).toBe(true);
  });

  it('点删除 → 先弹确认，确认后才调 remove', async () => {
    mockList([{ ...base, id: 's1', status: 'completed', findingsCount: 0 }]);
    renderList();
    await waitFor(() => expect(screen.getByText('资产页探索')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('删除会话'));
    await waitFor(() =>
      expect(screen.getByText('删除会话会一并删除其缺陷候选与证据截图，且不可恢复。')).toBeTruthy(),
    );
    expect(explorationRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(explorationRemove).toHaveBeenCalledWith('s1'));
  });
});
