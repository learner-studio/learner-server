import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils'

const alertVariants = cva('rounded-xl border px-4 py-3 text-sm', {
  variants: {
    tone: {
      info: 'border-accent/30 bg-accent/8 text-ink',
      neutral: 'border-glass-border bg-glass text-ink',
      warning: 'border-amber-500/40 bg-amber-500/10 text-ink',
      danger: 'border-rose-500/40 bg-rose-500/10 text-ink',
      success: 'border-emerald-500/40 bg-emerald-500/10 text-ink',
    },
  },
  defaultVariants: { tone: 'info' },
})

/** shadcn-style alert: a tinted box with an optional bold title. */
export function Alert({ className, tone, title, children, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & VariantProps<typeof alertVariants> & { readonly title?: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn(alertVariants({ tone }), className)} {...props}>
      {title && <strong className="mb-1 block font-semibold">{title}</strong>}
      {children}
    </div>
  )
}
