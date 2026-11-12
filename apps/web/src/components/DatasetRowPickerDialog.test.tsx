import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// api.datasets.get is replaced: everything else uses the real implementation (i18n / stores all import from it).
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

/** 3 rows: row 2 is disabled → the enabled-row index space is 0, 1 (mapping to original rows 1 and 3). */
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
  const onFollowCase = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DatasetRowPickerDialog
        open
        onOpenChange={() => {}}
        projectId="p1"
        datasetId="ds-1"
        value={[]}
        onConfirm={onConfirm}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onConfirm, onFollowCase };
}

/** Checkboxes inside the row table's tbody (the header select-all box lives in thead and is excluded). */
function rowCheckboxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('tbody input[type=checkbox]')) as HTMLInputElement[];
}

const confirmBtn = () => screen.getByRole('button', { name: '确认' }) as HTMLButtonElement;

describe('DatasetRowPickerDialog', () => {
  beforeEach(() => {
    datasetGet.mockReset();
    datasetGet.mockResolvedValue(detail);
  });

  it('只渲染启用行，编号 = 启用行下标 + 1（禁用行不占号）', async () => {
    renderPicker();
    await waitFor(() => expect(datasetGet).toHaveBeenCalled());
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    expect(screen.queryByText('skip')).toBeNull();
    const numbers = screen.getAllByRole('row').slice(1).map((tr) => tr.children[1]?.textContent);
    expect(numbers).toEqual(['1', '2']);
  });

  it('敏感格显示掩码，不回显明文', async () => {
    renderPicker();
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    expect(screen.getAllByText('••••••')).toHaveLength(2);
  });

  it('value=[]（全部行）→ 打开即全选；确认回传 []', async () => {
    const { onConfirm } = renderPicker({ value: [] });
    // Wait for rows to render before asserting select-all — every() on an empty array is always true and would falsely pass
    await waitFor(() => {
      const boxes = rowCheckboxes();
      expect(boxes).toHaveLength(2);
      expect(boxes.every((c) => c.checked)).toBe(true);
    });
    await act(async () => {
      confirmBtn().click();
    });
    expect(onConfirm).toHaveBeenCalledWith([]);
  });

  it('value=子集 → 只勾子集；确认回传子集', async () => {
    const { onConfirm } = renderPicker({ value: [1] });
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    expect(rowCheckboxes()[0]!.checked).toBe(false);
    expect(rowCheckboxes()[1]!.checked).toBe(true);
    await act(async () => {
      confirmBtn().click();
    });
    expect(onConfirm).toHaveBeenCalledWith([1]);
  });

  it('全选状态取消一行 → 确认回传剩余下标', async () => {
    const { onConfirm } = renderPicker({ value: [] });
    // Wait for rows to render before asserting select-all — every() on an empty array is always true and would falsely pass
    await waitFor(() => {
      const boxes = rowCheckboxes();
      expect(boxes).toHaveLength(2);
      expect(boxes.every((c) => c.checked)).toBe(true);
    });
    await act(async () => {
      rowCheckboxes()[0]!.click();
    });
    await act(async () => {
      confirmBtn().click();
    });
    expect(onConfirm).toHaveBeenCalledWith([1]);
  });

  it('手动取消全部勾选 → 确认禁用；表头全选可恢复（回到全部的唯一入口）', async () => {
    renderPicker({ value: [] });
    // Wait for rows to render before asserting select-all — every() on an empty array is always true and would falsely pass
    await waitFor(() => {
      const boxes = rowCheckboxes();
      expect(boxes).toHaveLength(2);
      expect(boxes.every((c) => c.checked)).toBe(true);
    });
    await act(async () => {
      rowCheckboxes()[0]!.click();
    });
    await act(async () => {
      rowCheckboxes()[1]!.click();
    });
    expect(confirmBtn().disabled).toBe(true);
    await act(async () => {
      (screen.getByTitle('全选') as HTMLInputElement).click();
    });
    expect(confirmBtn().disabled).toBe(false);
  });

  it('传 onFollowCase → 显示「跟随用例」按钮，点击回调并关弹窗', async () => {
    const onFollowCase = vi.fn();
    const onOpenChange = vi.fn();
    renderPicker({ onFollowCase, onOpenChange });
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    await act(async () => {
      (screen.getByRole('button', { name: '跟随用例' }) as HTMLButtonElement).click();
    });
    expect(onFollowCase).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('未传 onFollowCase → 不渲染「跟随用例」按钮', async () => {
    renderPicker();
    await waitFor(() => expect(rowCheckboxes()).toHaveLength(2));
    expect(screen.queryByRole('button', { name: '跟随用例' })).toBeNull();
  });

  it('关闭时不拉数据集（零额外请求）', async () => {
    renderPicker({ open: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(datasetGet).not.toHaveBeenCalled();
  });
});
