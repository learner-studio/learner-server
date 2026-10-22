import { cn } from '../../lib/utils'

/** A 0-100 bar. The fill tone is the same warning/accent pair the badges use. */
export function Progress({ value, tone = 'accent', className, 'aria-label': label }: { readonly value: number; readonly tone?: 'accent' | 'warning' | 'neutral'; readonly className?: string; readonly 'aria-label'?: string }) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)} className={cn('h-1.5 w-full overflow-hidden rounded-full bg-rule', className)}>
      <div className={cn('h-full rounded-full transition-[width]', tone === 'warning' ? 'bg-amber-500' : tone === 'neutral' ? 'bg-ink-soft' : 'bg-accent')} style={{ width: `${clamped}%` }} />
    </div>
  )
}

/** The busy indicator shadcn builds from a spinning ring. */
export function Spinner({ className }: { readonly className?: string }) {
  return <span aria-hidden className={cn('inline-block size-4 flex-none animate-spin rounded-full border-2 border-rule border-t-accent', className)} />
}
