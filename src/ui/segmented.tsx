import { ToggleGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from './cn';

type SegmentedProps<V extends string> = {
  label: string;
  value: V;
  onValueChange: (value: V) => void;
  options: readonly {
    value: V;
    label: string;
    icon?: ReactNode;
    activeClassName?: string;
    disabled?: boolean;
  }[];
  hideLabelsBelow?: 'sm' | 'md';
  className?: string;
};

// A single-choice switch whose value can never be empty.
export function Segmented<V extends string>({
  label,
  value,
  onValueChange,
  options,
  hideLabelsBelow,
  className,
}: SegmentedProps<V>) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const option = options.find((o) => o.value === next);
        if (option) onValueChange(option.value);
      }}
      className={cn('flex h-8 items-center gap-0.5 rounded-md bg-surface-2 p-0.5', className)}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          aria-label={option.label}
          disabled={option.disabled}
          className={cn(
            'inline-flex h-full cursor-default items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium text-fg-2 transition-colors duration-150 select-none hover:text-fg-1 disabled:opacity-45 disabled:hover:text-fg-2 data-[state=on]:bg-surface-1 data-[state=on]:text-fg-1 data-[state=on]:shadow-xs [&_svg]:size-3.5 [&_svg]:shrink-0',
            option.activeClassName,
          )}
        >
          {option.icon}
          <span
            className={cn(
              hideLabelsBelow === 'sm' && 'max-sm:sr-only',
              hideLabelsBelow === 'md' && 'max-md:sr-only',
            )}
          >
            {option.label}
          </span>
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
