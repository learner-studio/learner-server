import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/** shadcn dialog on Radix: a centred glass sheet over a dimmed backdrop. */
export function Dialog({ open, onOpenChange, title, description, children, className }: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className={cn('fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-glass-border bg-canvas p-0 text-ink shadow-[0_24px_64px_rgb(0_0_0/30%)] outline-none', className)}>
          <div className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
            <div>
              <DialogPrimitive.Title className="m-0 text-lg font-bold">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-1 text-sm text-ink-soft">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close aria-label="Close" className="rounded-md px-2 text-lg text-ink-soft hover:bg-glass hover:text-ink">×</DialogPrimitive.Close>
          </div>
          <div className="min-h-0 overflow-auto px-5 py-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
