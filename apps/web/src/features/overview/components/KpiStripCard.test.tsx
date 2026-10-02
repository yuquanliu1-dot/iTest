import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import KpiStripCard from './KpiStripCard';

describe('KpiStripCard', () => {
  it('renders label and value', () => {
    render(
      <MemoryRouter>
        <KpiStripCard label="用例" value={42} iconName="beaker" tone="#000" to="/groups" />
      </MemoryRouter>,
    );
    expect(screen.getByText('用例')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('renders suffix when provided', () => {
    const { container } = render(
      <MemoryRouter>
        <KpiStripCard label="通过率" value={95} suffix="%" iconName="check" tone="#0f0" to="/reports" />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('95');
    expect(container.textContent).toContain('%');
  });

  it('clicking the card triggers navigation without throwing', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/start']}>
        <KpiStripCard label="用例" value={0} iconName="beaker" tone="#000" to="/groups" />
      </MemoryRouter>,
    );
    expect(() => fireEvent.click(container.firstChild as Element)).not.toThrow();
  });
});
