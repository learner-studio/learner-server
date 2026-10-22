import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

/** shadcn-style badge on the Learner tokens. `tone` carries meaning (status, warning); `variant` only the weight. */
const badgeVariants = cva('inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4 whitespace-nowrap', {
  variants: {
    variant: { solid: '', soft: '', outline: 'bg-transparent' },
    tone: {
      neutral: 'border-glass-border text-ink-soft',
      accent: 'border-accent/40 text-accent',
      warning: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
      success: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
      danger: 'border-rose-500/40 text-rose-700 dark:text-rose-300',
    },
  },
  compoundVariants: [
    { variant: 'solid', tone: 'neutral', className: 'bg-glass-strong text-ink' },
    { variant: 'solid', tone: 'accent', className: 'border-transparent bg-accent text-accent-ink' },
    { variant: 'solid', tone: 'warning', className: 'border-transparent bg-amber-500 text-white dark:text-amber-950' },
    { variant: 'solid', tone: 'success', className: 'border-transparent bg-emerald-600 text-white' },
    { variant: 'solid', tone: 'danger', className: 'border-transparent bg-rose-600 text-white' },
    { variant: 'soft', tone: 'neutral', className: 'bg-glass' },
    { variant: 'soft', tone: 'accent', className: 'bg-accent/12' },
    { variant: 'soft', tone: 'warning', className: 'bg-amber-500/12' },
    { variant: 'soft', tone: 'success', className: 'bg-emerald-500/12' },
    { variant: 'soft', tone: 'danger', className: 'bg-rose-500/12' },
  ],
  defaultVariants: { variant: 'soft', tone: 'neutral' },
})

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>

export function Badge({ className, variant, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, tone }), className)} {...props} />
}
