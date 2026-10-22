import * as SliderPrimitive from '@radix-ui/react-slider'
import { cn } from '../../lib/utils'

/** shadcn slider on Radix, single thumb. */
export function Slider({ value, onValueChange, min = 0, max = 100, step = 1, label, className }: {
  readonly value: number
  readonly onValueChange: (value: number) => void
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly label: string
  readonly className?: string
}) {
  return (
    <SliderPrimitive.Root value={[value]} onValueChange={([next]) => next !== undefined && onValueChange(next)} min={min} max={max} step={step}
      className={cn('relative flex h-5 w-full touch-none items-center select-none', className)}>
      <SliderPrimitive.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-rule">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb aria-label={label} className="block size-4 rounded-full border-2 border-accent bg-canvas shadow focus-visible:outline-3 focus-visible:outline-accent" />
    </SliderPrimitive.Root>
  )
}
