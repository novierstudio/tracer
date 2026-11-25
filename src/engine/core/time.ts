declare const timeBrand: unique symbol;
declare const durationBrand: unique symbol;

/** An instant on the simulated clock, in milliseconds since the run started. */
export type SimTime = number & { readonly [timeBrand]: true };

/** A span of simulated time, in milliseconds. */
export type SimDuration = number & { readonly [durationBrand]: true };

export const START = 0 as SimTime;

function checkMillis(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite number of milliseconds >= 0, got ${value}`);
  }
}

export function simTime(value: number): SimTime {
  checkMillis(value, 'A simulated time');
  return value as SimTime;
}

export function ms(value: number): SimDuration {
  checkMillis(value, 'A duration');
  return value as SimDuration;
}

export function after(time: SimTime, delay: SimDuration): SimTime {
  return (time + delay) as SimTime;
}
