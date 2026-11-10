import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// api 只 mock 用到的端点（详情 + 分组列表）。
const { explorationGet, groupList } = vi.hoisted(() => ({
  explorationGet: vi.fn(),
  groupList: vi.fn(),
}));
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      explorations: { ...actual.api.explorations, get: explorationGet },
      projects: { ...actual.api.projects, groups: groupList },
    },
  };
});

// 实时画面重组件 stub 掉：MJPEG/录像与本用例无关。
vi.mock('../components/LiveViewCard', () => ({ default: () => null }));

import ExplorationDetail from './ExplorationDetail';
import '../i18n';

const session = {
  id: 's1',
  projectId: 'p1',
  versionId: 'v1',
  title: '资产页探索',
  charter: '核查资产管理页的增删是否落库',
  persona: 'qa',
  startUrl: 'http://127.0.0.1:56100/defect.html',
  status: 'completed' as const,
  cancelRequested: false,
  summary: '探索结束',
  error: null,
  turnsUsed: 3,
  usage: null,
  startedAt: null,
  finishedAt: null,
  createdAt: '',
  updatedAt: '',
  findings: [],
  steps: [
    { type: 'navigate', target: 'http://127.0.0.1:56100/defect.html', ok: true },
    { type: 'sql', target: 'SELECT COUNT(*) AS cnt FROM sa_asset', ok: true, detail: '1 行｜首行：cnt=20' },
    { type: 'sql', target: 'DELETE FROM sa_asset WHERE assetid=999999', ok: false, detail: '失败：只读守卫拒绝' },
  ],
};

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/p/p1/v/v1/explorations/s1']}>
        <Routes>
          <Route path="/p/:projectId/v/:versionId/explorations/:id" element={<ExplorationDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ExplorationDetail 会话过程', () => {
  beforeEach(() => {
    explorationGet.mockReset();
    groupList.mockReset();
    explorationGet.mockResolvedValue({ ...session });
    groupList.mockResolvedValue([]);
  });

  it('渲染每一步动作：SQL 原文 + 结果摘要 + 成功/失败', async () => {
    renderDetail();
    await waitFor(() => expect(explorationGet).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('会话过程')).toBeTruthy());

    // 步骤序号与动作类型标签
    expect(screen.getByText('访问')).toBeTruthy();
    expect(screen.getAllByText('查库')).toHaveLength(2);

    // 查库步骤：SQL 原文完整可见（不截断）
    expect(screen.getByText('SELECT COUNT(*) AS cnt FROM sa_asset')).toBeTruthy();
    // 结果摘要（平台记录的行数/首行）
    expect(screen.getByText('1 行｜首行：cnt=20')).toBeTruthy();
    // 被守卫拒收的写语句：原文与失败原因都在
    expect(screen.getByText('DELETE FROM sa_asset WHERE assetid=999999')).toBeTruthy();
    expect(screen.getByText('失败：只读守卫拒绝')).toBeTruthy();
    expect(screen.getAllByText('成功')).toHaveLength(2);
    expect(screen.getAllByText('失败')).toHaveLength(1);
  });

  it('无留痕（老会话）→ 不渲染会话过程卡片', async () => {
    explorationGet.mockResolvedValue({ ...session, steps: [] });
    renderDetail();
    await waitFor(() => expect(explorationGet).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('资产页探索')).toBeTruthy());
    expect(screen.queryByText('会话过程')).toBeNull();
  });
});
