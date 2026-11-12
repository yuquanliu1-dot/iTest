import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';

// api mocks only the endpoints used here (detail + group list).
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

// Stub out the heavy live-view component: MJPEG/recording are irrelevant to this suite.
// The stub simulates "frame in place": on mount it reports onFrameVisibleChange(true) + onFrameHeightChange(300)
// (the real component is stretched proportionally by LiveViewImg per column width and then reports the actual height), driving the side-by-side branch and height-alignment contract.
vi.mock('../components/LiveViewCard', () => ({
  default: function LiveViewCardStub(props: {
    onFrameHeightChange?: (h: number) => void;
    onFrameVisibleChange?: (v: boolean) => void;
  }) {
    useEffect(() => {
      props.onFrameVisibleChange?.(true);
      props.onFrameHeightChange?.(300);
    }, [props.onFrameHeightChange, props.onFrameVisibleChange]);
    return null;
  },
}));

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

    // Step number and action-type labels
    expect(screen.getByText('访问')).toBeTruthy();
    expect(screen.getAllByText('查库')).toHaveLength(2);

    // SQL step: the raw SQL is fully visible (not truncated)
    expect(screen.getByText('SELECT COUNT(*) AS cnt FROM sa_asset')).toBeTruthy();
    // Result summary (rows/first row as recorded by the platform)
    expect(screen.getByText('1 行｜首行：cnt=20')).toBeTruthy();
    // Write statement rejected by the guard: both the original text and the failure reason are rendered
    expect(screen.getByText('DELETE FROM sa_asset WHERE assetid=999999')).toBeTruthy();
    expect(screen.getByText('失败：只读守卫拒绝')).toBeTruthy();
    expect(screen.getAllByText('成功')).toHaveLength(2);
    expect(screen.getAllByText('失败')).toHaveLength(1);
  });

  it('结果摘要（outcome）：观察/页内脚本这类无 target 的步骤显示结论，不再只有空占位', async () => {
    explorationGet.mockResolvedValue({
      ...session,
      steps: [
        {
          type: 'observe',
          target: '-',
          ok: true,
          outcome: 'URL http://127.0.0.1:56100/defect.html｜视口 1280x800｜可交互元素 12 个',
        },
        { type: 'evaluate', target: '-', ok: false, outcome: '失败：目标不可见' },
      ],
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText('会话过程')).toBeTruthy());

    expect(screen.getByText('URL http://127.0.0.1:56100/defect.html｜视口 1280x800｜可交互元素 12 个')).toBeTruthy();
    expect(screen.getByText('失败：目标不可见')).toBeTruthy();
    // Steps with target "-" render no empty placeholder (it used to be a lone "-" line).
    const ol = document.querySelector('ol')!;
    const dashes = Array.from(ol.querySelectorAll('span')).filter((el) => el.textContent?.trim() === '-');
    expect(dashes).toHaveLength(0);
  });

  it('并排布局契约：画面高度自适应回报后会话过程卡跟随（300+2 边框）、两窗等宽（各 1fr）', async () => {
    renderDetail();
    await waitFor(() => expect(explorationGet).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('会话过程')).toBeTruthy());
    // Reporting "frame present + frame height 300" takes one effect + re-render before the side-by-side branch kicks in (before that the full-width fallback card renders)
    await waitFor(() => {
      const c = screen.getByText('会话过程').closest('.bg-card') as HTMLElement;
      expect(c.style.height).toBe('302px');
    });
    const card = screen.getByText('会话过程').closest('.bg-card') as HTMLElement;
    const grid = card.parentElement as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('minmax(0, 1fr) minmax(0, 1fr)');
  });

  it('无留痕（老会话）→ 不渲染会话过程卡片', async () => {
    explorationGet.mockResolvedValue({ ...session, steps: [] });
    renderDetail();
    await waitFor(() => expect(explorationGet).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('资产页探索')).toBeTruthy());
    expect(screen.queryByText('会话过程')).toBeNull();
  });

  it('排队中（pending）也持续轮询——否则页面永远停在 pending，不会自己动', async () => {
    vi.useFakeTimers();
    try {
      explorationGet.mockResolvedValue({ ...session, status: 'pending' });
      renderDetail();
      await vi.advanceTimersByTimeAsync(10);
      expect(explorationGet).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2500);
      expect(explorationGet.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('终态会话不轮询——没有新东西可拉', async () => {
    vi.useFakeTimers();
    try {
      explorationGet.mockResolvedValue({ ...session, status: 'completed' });
      renderDetail();
      await vi.advanceTimersByTimeAsync(10);
      expect(explorationGet).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(explorationGet).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
