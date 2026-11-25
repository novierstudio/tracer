import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ImportReport } from '@/importers/pkt/report';
import { PortId } from '@/model';
import { buildLab } from '@/model/testing';
import { Dialog } from '@/ui/dialog';
import { FileDialogs } from './FileDialogs';
import { ImportProgress, ImportReview } from './ImportDialog';
import { fileSession } from './session';

const lab = buildLab();

const REPORT: ImportReport = {
  ptVersion: '8.2.2.0400',
  activity: false,
  devices: { imported: 5, skipped: 3 },
  links: { imported: 4, dropped: 1 },
  entries: [
    { kind: 'device-skipped', name: 'Printer0', ptType: 'Printer', model: 'Printer-PT' },
    { kind: 'device-skipped', name: 'AP0', ptType: 'AccessPoint', model: 'AccessPoint-PT' },
    { kind: 'device-skipped', name: 'Printer1', ptType: 'Printer', model: 'Printer-PT' },
    {
      kind: 'link-dropped',
      from: { device: 'Printer0', port: 'FastEthernet0' },
      to: { device: 'SW1', port: 'FastEthernet0/2' },
      reason: { kind: 'device-skipped' },
    },
    {
      kind: 'hostname-changed',
      device: lab.sw.id,
      name: 'Core switch',
      hostname: lab.sw.config.hostname,
    },
    { kind: 'device-approximated', device: lab.sw.id, ptType: 'MultiLayerSwitch', as: 'switch' },
    { kind: 'mac-generated', device: lab.r1.id, port: PortId.parse('GigabitEthernet0/0') },
    { kind: 'mac-generated', device: lab.r1.id, port: PortId.parse('GigabitEthernet0/1') },
    { kind: 'config-kept', device: lab.r1.id, lines: ['no ip cef', 'license udi pid X'] },
    { kind: 'config-kept', device: lab.r2.id, lines: ['ip classless'] },
  ],
};

function renderReview(report: ImportReport = REPORT) {
  const onOpen = vi.fn();
  render(
    <Dialog open>
      <ImportReview fileName="Campus.pkt" report={report} topology={lab.topology} onOpen={onOpen} />
    </Dialog>,
  );
  return { dialog: screen.getByRole('dialog', { name: 'Import Campus.pkt' }), onOpen };
}

const stat = (dialog: HTMLElement, label: string) =>
  within(dialog).getByText(label, { selector: 'dt' }).parentElement!;

describe('import report dialog', () => {
  it('shows the file, the Packet Tracer version and the counts', () => {
    const { dialog } = renderReview();
    expect(dialog).toHaveAccessibleDescription(/Packet Tracer 8\.2\.2\.0400/);
    expect(stat(dialog, 'Devices')).toHaveTextContent('5' + '3 skipped');
    expect(stat(dialog, 'Links')).toHaveTextContent('4' + '1 dropped');
    expect(stat(dialog, 'Config lines')).toHaveTextContent('3' + 'kept as-is');
    expect(within(dialog).queryByText(/Packet Tracer activity/)).toBeNull();
  });

  it('groups the details, collapsed, with a count for each group', () => {
    const { dialog } = renderReview();
    const groups = within(dialog)
      .getAllByRole('group')
      .filter((el) => el.parentElement?.getAttribute('aria-label') === 'Details');
    expect(groups.map((g) => g.querySelector('summary')!.textContent)).toEqual([
      'Skipped devices3',
      'Dropped links1',
      'Renamed hostnames1',
      'Approximations2',
      'Config lines kept as-is3',
    ]);
    expect(groups.every((g) => !g.hasAttribute('open'))).toBe(true);

    const [skipped, dropped, renamed, approximated, config] = groups as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    fireEvent.click(within(skipped).getByText('Skipped devices'));
    expect(skipped).toHaveAttribute('open');
    expect(within(skipped).getByText('Printer: Printer0, Printer1')).toBeVisible();
    expect(within(skipped).getByText('AccessPoint: AP0')).toBeVisible();
    expect(dropped).toHaveTextContent('Printer0 FastEthernet0 ↔ SW1 FastEthernet0/2');
    expect(renamed).toHaveTextContent('Core switch → SW1');
    expect(approximated).toHaveTextContent('SW1: MultiLayerSwitch imported as a switch');
    expect(approximated).toHaveTextContent('R1: generated MAC addresses for 2 ports');
    expect(config).toHaveTextContent('R1 · 2 lines');
    expect(config).toHaveTextContent('R2 · 1 line');
    expect(config).toHaveTextContent('license udi pid X');
  });

  it('notes that only the starting network of an activity was read', () => {
    const { dialog } = renderReview({ ...REPORT, activity: true });
    expect(dialog).toHaveTextContent(
      /Only its starting network was imported\. Tracer did not read the activity's answers or grading\./,
    );
  });

  it('says so when everything imported cleanly', () => {
    const { dialog } = renderReview({ ...REPORT, entries: [] });
    expect(dialog).toHaveTextContent('Everything in the file was imported as it is.');
  });

  it('opens the lab from the primary button', () => {
    const { dialog, onOpen } = renderReview();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open lab' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('import progress dialog', () => {
  it('marks the stages done so far and the current one', () => {
    render(
      <Dialog open>
        <ImportProgress fileName="Campus.pkt" stage="decompressing" />
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Opening Campus.pkt' });
    expect(within(dialog).getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      'Decompressing',
    );
    const current = within(dialog).getByRole('listitem', { current: 'step' });
    expect(current).toHaveTextContent('Decompressing');
  });
});

describe('file problems', () => {
  it('explains that a file is not from Packet Tracer', async () => {
    render(<FileDialogs />);
    await act(() => fileSession.openFile(new File(['hello '.repeat(100)], 'notes.pkt')));
    const dialog = await screen.findByRole('alertdialog', { name: 'Not a Packet Tracer file' });
    expect(dialog).toHaveAccessibleDescription(/couldn't decrypt “notes\.pkt”/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
