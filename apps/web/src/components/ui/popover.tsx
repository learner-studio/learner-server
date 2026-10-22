import * as PopoverPrimitive from '@radix-ui/react-popover'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

/** shadcn popover content: portalled, collision-aware, opaque on the canvas so the canvas under it never bleeds through. */
export function PopoverContent({ className, sideOffset = 8, collisionPadding = 12, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content sideOffset={sideOffset} collisionPadding={collisionPadding}
        className={cn('z-50 max-h-[var(--radix-popover-content-available-height)] w-[min(380px,calc(100vw-24px))] overflow-auto rounded-xl border border-glass-border bg-canvas p-3 text-ink shadow-[0_18px_48px_rgb(0_0_0/22%)] outline-none', className)} {...props} />
    </PopoverPrimitive.Portal>
  )
}
