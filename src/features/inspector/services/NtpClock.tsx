import { useId, useState, type FormEvent } from 'react';
import { useSimulation } from '@/features/simulation/store';
import { Button } from '@/ui/button';
import { inputClass, SettingRow } from '../config/controls';
import { FormError } from './parts';

type Draft = { date: string; time: string };

/** A clock in UTC as the date and time fields show it: `2026-01-01` and `00:00:05`. */
const fields = (clock: number): Draft => {
  const iso = new Date(clock).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
};

/**
 * The server's date and time in UTC, running with simulated time. A server's clock is its NTP
 * epoch plus the time since the run began, as the engine's `clockOf` has it, so it needs no round
 * trip. Setting a time moves the epoch so the clock reads that time now.
 */
export function NtpClock({ epoch, onSet }: { epoch: number; onSet: (epoch: number) => void }) {
  const now = useSimulation((state) => state.now);
  // null while not editing, so the fields follow the clock.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string>();
  const id = useId();
  const shown = draft ?? fields(epoch + now);

  const edit = (change: Partial<Draft>) => {
    setDraft({ ...shown, ...change });
    setError(undefined);
  };
  const set = (event: FormEvent) => {
    event.preventDefault();
    if (draft === null) return;
    const time = Date.parse(`${draft.date}T${draft.time}Z`);
    if (Number.isNaN(time)) return setError('Type a date and a time');
    onSet(time - now);
    setDraft(null);
    setError(undefined);
  };

  return (
    <form
      aria-label="NTP clock"
      onSubmit={set}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && draft !== null) {
          event.preventDefault();
          setDraft(null);
          setError(undefined);
        }
      }}
      className="flex flex-col gap-1.5"
    >
      <SettingRow label="Date and time">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5">
          <input
            type="date"
            aria-label="NTP date"
            value={shown.date}
            onChange={(event) => edit({ date: event.target.value })}
            className={inputClass(true, error !== undefined)}
          />
          <input
            type="time"
            step={1}
            aria-label="NTP time"
            value={shown.time}
            onChange={(event) => edit({ time: event.target.value })}
            className={inputClass(true, error !== undefined)}
          />
          <Button type="submit" size="sm" aria-label="Set clock" disabled={draft === null}>
            Set
          </Button>
        </div>
      </SettingRow>
      <p className="text-2xs text-fg-3">UTC. The clock runs with simulated time.</p>
      <FormError id={`${id}-error`} message={error} />
    </form>
  );
}
