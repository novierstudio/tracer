import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_DRAG_TYPE, PalettePanel } from './PalettePanel';

const search = () => screen.getByRole('searchbox', { name: 'Search devices' });
const groupNames = () =>
  screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
const items = (group: string) =>
  within(screen.getByRole('list', { name: group }))
    .getAllByRole('listitem')
    .map((item) => item.textContent);

describe('PalettePanel devices', () => {
  it('lists the catalog grouped by category with port summaries', () => {
    render(<PalettePanel section="devices" />);

    expect(groupNames()).toEqual(['Routers', 'Switches', 'End devices', 'Servers']);
    expect(items('Routers')).toEqual(['Branch Router2× Gi, 2× Serial', 'Edge Router4× Gi']);
    expect(items('Switches')).toEqual([
      'Access Switch 2424× Fa, 2× Gi',
      'Access Switch 4848× Fa, 2× Gi',
    ]);
    expect(items('End devices')).toEqual(['Desktop PC1× Fa', 'Laptop1× Gi']);
    expect(items('Servers')).toEqual(['Server1× Gi']);
  });

  it('filters by name, category and port type, dropping empty groups', () => {
    render(<PalettePanel section="devices" />);

    fireEvent.change(search(), { target: { value: 'switch' } });
    expect(groupNames()).toEqual(['Switches']);

    fireEvent.change(search(), { target: { value: 'serial' } });
    expect(groupNames()).toEqual(['Routers']);
    expect(items('Routers')).toEqual(['Branch Router2× Gi, 2× Serial']);

    fireEvent.change(search(), { target: { value: 'END   lap' } });
    expect(items('End devices')).toEqual(['Laptop1× Gi']);

    fireEvent.change(search(), { target: { value: 'mainframe' } });
    expect(screen.queryAllByRole('list')).toEqual([]);
    expect(screen.getByText('No matching devices')).toBeVisible();

    fireEvent.change(search(), { target: { value: '' } });
    expect(groupNames()).toHaveLength(4);
  });

  it('makes each device focusable and draggable with its model id', () => {
    render(<PalettePanel section="devices" />);
    const laptop = screen.getByText('Laptop').closest('li')!;

    expect(laptop).toHaveAttribute('draggable', 'true');
    expect(laptop).toHaveAttribute('tabindex', '0');

    const setData = vi.fn();
    fireEvent.dragStart(laptop, { dataTransfer: { setData, effectAllowed: 'all' } });
    expect(setData).toHaveBeenCalledWith(DEVICE_DRAG_TYPE, 'laptop');
  });

  it('keeps the other sections as empty states', () => {
    render(<PalettePanel section="connections" />);
    expect(screen.getByText('No cables yet')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Search cables' })).toBeDisabled();
  });
});
