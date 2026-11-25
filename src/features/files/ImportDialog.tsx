import { CheckIcon, ChevronRightIcon, InfoIcon, LoaderCircleIcon } from 'lucide-react';
import { useMemo } from 'react';
import type { ImportReport } from '@/importers/pkt/report';
import type { Topology } from '@/model';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Dialog, DialogClose, DialogContent } from '@/ui/dialog';
import type { ImportStage } from './importers';
import { summarizeReport, type ReportGroup } from './importReport';
import { useFiles } from './react';
import { fileSession } from './session';

const STAGES: readonly { stage: ImportStage; label: string }[] = [
  { stage: 'reading', label: 'Reading the file' },
  { stage: 'decrypting', label: 'Decrypting' },
  { stage: 'decompressing', label: 'Decompressing' },
  { stage: 'mapping', label: 'Building the lab' },
];

export function ImportProgress({ fileName, stage }: { fileName: string; stage: ImportStage }) {
  const current = STAGES.findIndex((s) => s.stage === stage);
  return (
    <DialogContent
      title={`Opening ${fileName}`}
      description="The file is read in this browser. Nothing is uploaded."
    >
      <div
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={STAGES.length}
        aria-valuenow={current + 1}
        aria-valuetext={STAGES[current]?.label}
        className="h-1 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${((current + 1) / STAGES.length) * 100}%` }}
        />
      </div>
      <ol className="flex flex-col gap-2 text-sm">
        {STAGES.map(({ stage: s, label }, index) => (
          <li
            key={s}
            aria-current={index === current ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2',
              index < current && 'text-fg-2',
              index === current && 'font-medium text-fg-1',
              index > current && 'text-fg-3',
            )}
          >
            {index < current ? (
              <CheckIcon className="size-4 text-ok" />
            ) : index === current ? (
              <LoaderCircleIcon className="size-4 animate-spin text-accent-text" />
            ) : (
              <span aria-hidden className="grid size-4 place-items-center">
                <span className="size-1.5 rounded-full bg-current" />
              </span>
            )}
            {label}
          </li>
        ))}
      </ol>
      <div className="flex justify-end">
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
      </div>
    </DialogContent>
  );
}

function Stat({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-surface-2 px-3 py-2.5">
      <dt className="text-xs text-fg-2">{label}</dt>
      <dd className="text-xl leading-7 font-semibold tabular-nums">{value}</dd>
      <dd className="text-xs text-fg-2">{note}</dd>
    </div>
  );
}

function Group({ group }: { group: ReportGroup }) {
  return (
    <details className="group rounded-lg border border-line">
      <summary className="flex cursor-default list-none items-center gap-2 px-3 py-2 text-sm font-medium select-none hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-4 shrink-0 text-fg-3 transition-transform group-open:rotate-90" />
        <span className="flex-1">{group.title}</span>
        <span className="rounded-full bg-surface-3 px-1.5 text-xs text-fg-2 tabular-nums">
          {group.count}
        </span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
        <p className="text-xs text-fg-2">{group.hint}</p>
        <ul className="flex flex-col gap-1 text-xs">
          {group.items.map((item, index) =>
            item.lines ? (
              <li key={index}>
                <details className="group/lines">
                  <summary className="flex cursor-default list-none items-center gap-1 select-none [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon className="size-3.5 text-fg-3 transition-transform group-open/lines:rotate-90" />
                    {item.label}
                  </summary>
                  <pre className="mt-1 overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-2xs text-fg-2">
                    {item.lines.join('\n')}
                  </pre>
                </details>
              </li>
            ) : (
              <li key={index} className="break-words">
                {item.label}
              </li>
            ),
          )}
        </ul>
      </div>
    </details>
  );
}

type ImportReviewProps = {
  fileName: string;
  report: ImportReport;
  topology: Topology;
  onOpen: () => void;
};

export function ImportReview({ fileName, report, topology, onOpen }: ImportReviewProps) {
  const summary = useMemo(() => summarizeReport(report, topology), [report, topology]);
  const { devices, links } = summary;
  const version = report.ptVersion ? `Packet Tracer ${report.ptVersion}` : 'Packet Tracer';
  return (
    <DialogContent
      title={`Import ${fileName}`}
      description={`Saved by ${version}. Check what Tracer imported before the lab opens.`}
      className="max-w-lg overflow-hidden"
    >
      <dl className="grid grid-cols-3 gap-2">
        <Stat label="Devices" value={devices.imported} note={`${devices.skipped} skipped`} />
        <Stat label="Links" value={links.imported} note={`${links.dropped} dropped`} />
        <Stat label="Config lines" value={summary.configLinesKept} note="kept as-is" />
      </dl>
      {report.activity && (
        <p className="flex gap-2 rounded-lg bg-accent/10 px-3 py-2.5 text-sm text-fg-1">
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-accent-text" />
          <span>
            This is a Packet Tracer activity. Only its starting network was imported. Tracer did not
            read the activity&apos;s answers or grading.
          </span>
        </p>
      )}
      {summary.groups.length > 0 ? (
        <section
          aria-label="Details"
          className="-mx-1 flex min-h-0 flex-col gap-2 overflow-y-auto px-1"
        >
          {summary.groups.map((group) => (
            <Group key={group.id} group={group} />
          ))}
        </section>
      ) : (
        <p className="text-sm text-fg-2">Everything in the file was imported as it is.</p>
      )}
      <div className="flex justify-end gap-2">
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button variant="primary" onClick={onOpen}>
          Open lab
        </Button>
      </div>
    </DialogContent>
  );
}

// Shows progress while a file imports, then its report until the user opens the lab or cancels.
export function ImportDialog() {
  const flow = useFiles((state) => state.importing);
  return (
    <Dialog open={!!flow} onOpenChange={(open) => !open && fileSession.cancelImport()}>
      {flow?.step === 'progress' && <ImportProgress fileName={flow.fileName} stage={flow.stage} />}
      {flow?.step === 'review' && (
        <ImportReview
          fileName={flow.fileName}
          report={flow.report}
          topology={flow.topology}
          onOpen={() => void fileSession.confirmImport()}
        />
      )}
    </Dialog>
  );
}
