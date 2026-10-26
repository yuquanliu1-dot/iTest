import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import KpiStripCard from './KpiStripCard';

describe('KpiStripCard', () => {
  it('renders label and value', () => {
    render(
      <MemoryRouter>
        <KpiStripCard label="Cases" value={42} iconName="beaker" tone="#000" to="/groups" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Cases')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('renders suffix when provided', () => {
    const { container } = render(
      <MemoryRouter>
        <KpiStripCard label="Pass rate" value={95} suffix="%" iconName="check" tone="#0f0" to="/reports" />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('95');
    expect(container.textContent).toContain('%');
  });

  it('renders footer label when provided, hides it otherwise', () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <KpiStripCard label="Cases" value={10} iconName="beaker" tone="#000" to="/groups" />
      </MemoryRouter>,
    );
    expect(container.textContent).not.toContain('214');

    rerender(
      <MemoryRouter>
        <KpiStripCard label="Cases" value={10} iconName="beaker" tone="#000" to="/groups" footLabel="待固化 214 步" />
      </MemoryRouter>,
    );
    expect(container.textContent).toContain('待固化 214 步');
  });

  it('clicking the card triggers navigation without throwing', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/start']}>
        <KpiStripCard label="Cases" value={0} iconName="beaker" tone="#000" to="/groups" />
      </MemoryRouter>,
    );
    expect(() => fireEvent.click(container.firstChild as Element)).not.toThrow();
  });
});
