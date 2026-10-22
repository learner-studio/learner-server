import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

/** shadcn-style button on the Learner tokens. */
const buttonVariants = cva(
  'inline-flex items-center gap-2 font-semibold transition focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-accent disabled:opacity-50 disabled:pointer-events-none cursor-pointer',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-ink shadow-[0_8px_24px_rgb(99_102_241/35%)] hover:-translate-y-px',
        secondary: 'bg-glass-strong text-ink border border-glass-border hover:-translate-y-px',
        ghost: 'text-ink-soft hover:text-ink hover:bg-glass',
        nav: 'text-ink-soft hover:text-ink aria-[current=page]:bg-glass-strong aria-[current=page]:text-ink',
      },
      size: { lg: 'rounded-full px-5 py-3 text-[15px]', md: 'rounded-lg px-3 py-1.5 text-sm', sm: 'rounded-md px-2 py-0.5 text-xs', icon: 'rounded-md size-6 justify-center text-sm' },
    },
    defaultVariants: { variant: 'primary', size: 'lg' },
  },
)

export function Button({ className, variant, size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
