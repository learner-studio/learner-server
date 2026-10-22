import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '../../lib/utils'

/** A segmented control built on Radix Tabs: one row of mutually exclusive choices with arrow-key navigation. */
export function SegmentedControl<T extends string>({ value, onValueChange, options, label, className }: {
  readonly value: T
  readonly onValueChange: (value: T) => void
  readonly options: readonly { readonly value: T; readonly label: string }[]
  readonly label: string
  readonly className?: string
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={(next) => onValueChange(next as T)} activationMode="automatic">
      <TabsPrimitive.List aria-label={label} className={cn('flex w-full gap-1 rounded-lg border border-glass-border bg-glass p-1', className)}>
        {options.map((option) => (
          <TabsPrimitive.Trigger key={option.value} value={option.value}
            className="min-w-0 flex-1 cursor-pointer truncate rounded-md px-2 py-1 text-xs font-semibold text-ink-soft transition hover:text-ink data-[state=active]:bg-glass-strong data-[state=active]:text-ink data-[state=active]:shadow-sm">
            {option.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  )
}
