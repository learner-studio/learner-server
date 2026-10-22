import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

const field = 'w-full min-w-0 rounded-lg border border-glass-border bg-glass-strong px-3 py-1.5 text-sm text-ink outline-none placeholder:text-ink-soft focus:border-accent disabled:opacity-50'

/** A label stacked over its control, the way every form on these pages reads. */
export function Field({ label, className, children }: { readonly label: ReactNode; readonly className?: string; readonly children: ReactNode }) {
  return <label className={cn('flex min-w-0 flex-col gap-1 text-xs font-semibold text-ink-soft', className)}>{label}{children}</label>
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, 'resize-y', className)} {...props} />
}

export type SelectOption = { readonly value: string; readonly label: string; readonly disabled?: boolean }

/** shadcn's native select: the platform picker, styled, so it works on every device and with every screen reader. */
export function Select({ className, options, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { readonly options: readonly SelectOption[] }) {
  return (
    <select className={cn(field, 'cursor-pointer', className)} {...props}>
      {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
  )
}
