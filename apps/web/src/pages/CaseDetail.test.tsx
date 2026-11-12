import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Replace the api wholesale: CaseDetail pulls a lot of data and mocking each method is noisy — keep only the 6 endpoints used here.
const { caseGet, casePatch, datasetList, projectGroups, tagList, envList } = vi.hoisted(() => ({
  caseGet: vi.fn(),
  casePatch: vi.fn(),
  datasetList: vi.fn(),
  projectGroups: vi.fn(),
  tagList: vi.fn(),
  envList: vi.fn(),
}));
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      cases: { ...actual.api.cases, get: caseGet, patch: casePatch },
      datasets: { ...actual.api.datasets, list: datasetList },
      projects: { ...actual.api.projects, groups: projectGroups },
      tags: { ...actual.api.tags, list: tagList },
      environments: { ...actual.api.environments, list: envList },
    },
  };
});

// Stub out heavy components: unrelated to this suite, avoids dragging in dnd-kit / mobile-recorder dependencies.
vi.mock('../components/StepEditDrawer', () => ({ default: () => null }));
vi.mock('../components/labels/LabelsManagerDialog', () => ({ default: () => null }));
vi.mock('../features/mobile-recorder', () => ({ MobileRecorder: () => null }));

import CaseDetail from './CaseDetail';
import '../i18n';

const caseDetail = {
  id: 'c1',
  title: '登录用例',
  priority: 'P2',
  status: 'draft',
  groupId: 'g1',
  versionId: 'v1',
  steps: [],
  resolvedUrl: null,
  tags: [],
  datasetId: null as string | null,
  datasetRowIndexes: [] as number[],
};

const datasets = [
  {
    id: 'ds-1',
    projectId: 'p1',
    name: '账号甲',
    description: null,
    columns: [{ name: 'username', sensitive: false }],
    rowCount: 3,
    enabledRowCount: 3,
    updatedAt: '',
    createdAt: '',
  },
  {
    id: 'ds-2',
    projectId: 'p1',
    name: '账号乙',
    description: null,
    columns: [{ name: 'username', sensitive: false }],
    rowCount: 2,
    enabledRowCount: 2,
    updatedAt: '',
    createdAt: '',
  },
];

function renderCase() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/p/p1/v/v1/cases/c1']}>
        <Routes>
          <Route path="/p/:projectId/v/:versionId/cases/:id" element={<CaseDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Dataset dropdown (the label wraps the select itself, getByLabelText can't find it → identify by option value). */
function datasetSelect(): HTMLSelectElement {
  const sel = Array.from(document.querySelectorAll('select')).find((s) =>
    Array.from(s.options).some((o) => o.value === 'ds-1'),
  );
  if (!sel) throw new Error('dataset select not found');
  return sel as HTMLSelectElement;
}

/** The execution-settings card's save button (multiple "Save" buttons on the page; the first is the run-settings one). */
function saveButton(): HTMLElement {
  return screen.getAllByRole('button', { name: '保存' })[0]!;
}

describe('CaseDetail 数据集行选择', () => {
  beforeEach(() => {
    caseGet.mockReset();
    casePatch.mockReset();
    datasetList.mockReset();
    projectGroups.mockReset();
    tagList.mockReset();
    envList.mockReset();
    caseGet.mockResolvedValue({ ...caseDetail });
    casePatch.mockResolvedValue({ ...caseDetail });
    datasetList.mockResolvedValue(datasets);
    projectGroups.mockResolvedValue([{ id: 'g1', name: '分组' }]);
    tagList.mockResolvedValue([]);
    envList.mockResolvedValue([]);
  });

  it('未绑数据集 → 不渲染行范围控件；绑定后才出现', async () => {
    renderCase();
    await waitFor(() => expect(caseGet).toHaveBeenCalled());
    expect(screen.queryByText('数据集行范围')).toBeNull();

    // Select a dataset → row-range controls appear
    await waitFor(() => expect(datasetSelect()).toBeTruthy());
    await act(async () => {
      const sel = datasetSelect();
      sel.value = 'ds-1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => expect(screen.getByText('数据集行范围')).toBeTruthy());
    expect(screen.getByRole('button', { name: '选择数据' })).toBeTruthy();
  });

  it('默认档位是「所有行」，提示文案带启用行数', async () => {
    caseGet.mockResolvedValue({ ...caseDetail, datasetId: 'ds-1' });
    renderCase();
    await waitFor(() => expect(caseGet).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('数据集行范围')).toBeTruthy());
    expect(screen.getByText('执行该数据集全部 3 条启用行')).toBeTruthy();
  });

  it('换数据集 → 清空行选择', async () => {
    caseGet.mockResolvedValue({ ...caseDetail, datasetId: 'ds-1', datasetRowIndexes: [1] });
    renderCase();
    await waitFor(() => expect(caseGet).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('已选行号：2')).toBeTruthy());

    await act(async () => {
      const sel = datasetSelect();
      sel.value = 'ds-2';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => expect(screen.getByText('执行该数据集全部 2 条启用行')).toBeTruthy());
  });

  it('保存 → PATCH 带上 datasetRowIndexes', async () => {
    caseGet.mockResolvedValue({ ...caseDetail, datasetId: 'ds-1', datasetRowIndexes: [0, 2] });
    renderCase();
    await waitFor(() => expect(caseGet).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('已选行号：1、3')).toBeTruthy());

    await act(async () => {
      saveButton().click();
    });
    await waitFor(() => expect(casePatch).toHaveBeenCalled());
    expect(casePatch.mock.calls[0]![1]).toMatchObject({
      datasetId: 'ds-1',
      datasetRowIndexes: [0, 2],
    });
  });
});
