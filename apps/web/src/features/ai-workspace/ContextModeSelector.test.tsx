import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextModeSelector from './ContextModeSelector';

describe('ContextModeSelector', () => {
  it('renders 3 options', () => {
    render(<ContextModeSelector value="auto" onChange={() => {}} hasRepo />);
    expect(screen.getByText('参考源码')).toBeTruthy();
    expect(screen.getByText('抓取页面')).toBeTruthy();
    expect(screen.getByText('自动')).toBeTruthy();
  });

  it('clicking an option calls onChange', () => {
    const onChange = vi.fn();
    render(<ContextModeSelector value="auto" onChange={onChange} hasRepo />);
    fireEvent.click(screen.getByText('参考源码'));
    expect(onChange).toHaveBeenCalledWith('repo');
  });

  it('when hasRepo=false, repo option is disabled with title', () => {
    render(<ContextModeSelector value="auto" onChange={() => {}} hasRepo={false} />);
    const btn = screen.getByText('参考源码') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('仓库');
  });
});
