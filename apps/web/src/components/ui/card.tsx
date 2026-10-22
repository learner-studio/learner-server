import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

/** A frosted surface for one block of a page; `inset` is the quieter surface nested inside another card. */
export function Card({ className, inset, ...props }: HTMLAttributes<HTMLDivElement> & { readonly inset?: boolean }) {
  return <div className={cn(inset ? 'rounded-xl border border-glass-border bg-glass p-3' : 'glass rounded-2xl p-4', 'min-w-0 text-ink', className)} {...props} />
}

/** Small uppercase label above a value or a section. */
export function Eyebrow({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('block text-[11px] font-bold tracking-wide text-ink-soft uppercase', className)} {...props} />
}
