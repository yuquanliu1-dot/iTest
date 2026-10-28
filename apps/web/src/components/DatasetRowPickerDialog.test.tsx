import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// api.datasets.get 替换：其余走真实实现（i18n / stores 都从这里 import）。
const datasetGet = vi.fn();
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      datasets: {
        ...actual.api.datasets,
        get: (projectId: string, id: string) => datasetGet(projectId, id),
      },
    },
  };
});

import DatasetRowPickerDialog from './DatasetRowPickerDialog';
import '../i18n';

/** 3 行数据：第 2 行被禁用 → 启用行下标空间是 0、1（分别对应原始第 1、3 行）。 */
const detail = {
  id: 'ds-1',
  projectId: 'p1',
  name: '账号',
  description: null,
  columns: [
    { name: 'username', sensitive: false },
    { name: 'password', sensitive: true },
  ],
  rows: [
    { disabled: false, cells: { username: 'alice', password: { __masked: true } } },
    { disabled: true, cells: { username: 'skip', password: { __masked: true } } },
    { disabled: false, cells: { username: 'bob', password: { __masked: true } } },
  ],
  createdAt: '',
  updatedAt: '',
};

function renderPicker(props: Partial<React.ComponentProps<typeof DatasetRowPickerDialog>> = {}) {
  const onConfirm = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DatasetRowPickerDialog
        open
        onOpenChange={() => {}}
        projectId="p1"
        datasetId="ds-1"
        mode="many"
        value={[]}
        onConfirm={onConfirm}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onConfirm };
}

/** 行表格 tbody 里的勾选框（表头全选框在 thead，不参与）。 */
function rowCheckboxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('tbody input[type=checkbox]')) as HTMLInputElement[];
}

describe('DatasetRowPickerDialog', () => {
  beforeEach(() => {
    datasetGet.mockReset();
    datasetGet.mockResolvedValue(detail);
  });

  it('只渲染启用行，编号 = 启用行下标 + 1（禁用行不占号）', async () => {
    renderPicker();
    await waitFor(() => expect(datasetGet).toHaveBeenCalled());
    // 3 行里 1 行被禁用 → 只渲染 2 行
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    expect(screen.queryByText('skip')).toBeNull();
    // 编号列：1 和 2（禁用行不占号，bob 是第 2 个启用行）
    const numbers = screen.getAllByRole('row').slice(1).map((tr) => tr.children[1]?.textContent);
    expect(numbers).toEqual(['1', '2']);
  });

  it('敏感格显示掩码，不回显明文', async () => {
    renderPicker();
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    expect(screen.getAllByText('••••••')).toHaveLength(2);
  });

  it('0 选中时确认按钮禁用；选中后确认回传升序下标', async () => {
    const { onConfirm } = renderPicker();
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));

    const confirmBtn = screen.getByRole('button', { name: '确认' }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // 选第 2 个启用行（下标 1）
    await act(async () => {
      rowCheckboxes()[1]!.click();
    });
    await waitFor(() => expect((screen.getByRole('button', { name: '确认' }) as HTMLButtonElement).disabled).toBe(false));

    await act(async () => {
      (screen.getByRole('button', { name: '确认' }) as HTMLButtonElement).click();
    });
    expect(onConfirm).toHaveBeenCalledWith([1]);
  });

  it("mode='one'：再选一行即替换，最多保留一行", async () => {
    const { onConfirm } = renderPicker({ mode: 'one' });
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));

    await act(async () => {
      rowCheckboxes()[0]!.click();
    });
    await act(async () => {
      rowCheckboxes()[1]!.click();
    });
    await act(async () => {
      (screen.getByRole('button', { name: '确认' }) as HTMLButtonElement).click();
    });
    expect(onConfirm).toHaveBeenCalledWith([1]);
  });

  it('关闭时不拉数据集（零额外请求）', async () => {
    renderPicker({ open: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(datasetGet).not.toHaveBeenCalled();
  });
});
