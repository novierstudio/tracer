import { createContext, useContext, useState } from 'react';
import type { DeviceId } from '@/model';
import type { IosLines } from './lines';
import { commitLines } from './run';

/** Whether the Config tab shows the IOS commands behind each form. */
export const ShowIosContext = createContext(false);

export const useShowIos = () => useContext(ShowIosContext);

/**
 * One section's link to the CLI: the lines its current draft would run, the lines it ran last,
 * and `commit`, which returns the CLI's refusal or `undefined` once the edit is in the store.
 */
export type SectionIos = {
  pending: IosLines | undefined;
  applied: IosLines | undefined;
  setPending: (lines: IosLines | undefined) => void;
  commit: (lines: IosLines) => string | undefined;
};

export function useSectionIos(device: DeviceId): SectionIos {
  const [pending, setPendingState] = useState<IosLines | undefined>();
  const [applied, setApplied] = useState<IosLines | undefined>();
  const setPending = (lines: IosLines | undefined) =>
    setPendingState(lines && lines.length > 0 ? lines : undefined);
  return {
    pending,
    applied,
    setPending,
    commit: (lines) => {
      if (lines.length === 0) {
        setPendingState(undefined);
        return undefined;
      }
      const result = commitLines(device, lines);
      if (!result.ok) return result.error;
      setApplied(lines);
      setPendingState(undefined);
      return undefined;
    },
  };
}
