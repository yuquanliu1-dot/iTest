import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './shadcn/dropdown-menu';
import IconButton from './IconButton';

// IconButton 必须透传原生 button 属性：Radix 的 <DropdownMenuTrigger asChild> 会把
// onPointerDown / aria-haspopup / data-state 合并进子组件，丢了这些下拉菜单打不开。
describe('IconButton', () => {
  it('作为 Radix 下拉触发器时能打开菜单', async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton icon="folder" title="移动到分组" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>第二组</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole('button', { name: '移动到分组' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

    fireEvent.keyDown(trigger, { key: 'Enter' });
    const item = await screen.findByRole('menuitem', { name: '第二组' });
    expect(item).toBeTruthy();

    fireEvent.click(item);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
  });
});
