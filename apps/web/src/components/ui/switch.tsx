import * as SwitchPrimitive from '@radix-ui/react-switch'
import { useId, type ReactNode } from 'react'

/** shadcn switch on Radix, with its label and optional description beside it. */
export function Switch({ checked, onCheckedChange, disabled, label, description }: {
  readonly checked: boolean
  readonly onCheckedChange?: (checked: boolean) => void
  readonly disabled?: boolean
  readonly label: ReactNode
  readonly description?: ReactNode
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-3">
      <SwitchPrimitive.Root id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled}
        className="mt-0.5 inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full border border-glass-border bg-rule p-0.5 transition data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50">
        <SwitchPrimitive.Thumb className="block size-4 rounded-full bg-canvas shadow transition-transform data-[state=checked]:translate-x-4" />
      </SwitchPrimitive.Root>
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-ink-soft">{description}</span>}
      </label>
    </div>
  )
}
