import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/utils'

/** The Learner surface: an aurora backdrop with frosted panels on top. Pages compose these two pieces. */
export function LearnerBackdrop({ children, wide }: { readonly children: ReactNode; readonly wide?: boolean }) {
  return (
    <div data-testid="learner-backdrop" className="relative isolate min-h-full shrink-0 overflow-hidden px-4 pt-6 pb-14 text-left md:px-8 md:pt-10 md:pb-18">
      <span className="aurora-blob aurora-a" aria-hidden />
      <span className="aurora-blob aurora-b" aria-hidden />
      <span className="aurora-blob aurora-c" aria-hidden />
      <div className={cn('mx-auto flex flex-col gap-7', wide ? 'max-w-[1600px]' : 'max-w-[1040px]')}>{children}</div>
    </div>
  )
}

export function GlassPanel({ className, strong, as: Tag = 'div', ...rest }: { readonly strong?: boolean; readonly as?: 'div' | 'article' | 'section' } & HTMLAttributes<HTMLElement>) {
  return <Tag className={cn('glass text-ink', strong && 'bg-glass-strong', className)} {...rest} />
}

export function PageHead({ title, children, onHome }: { readonly title: string; readonly children: ReactNode; readonly onHome: () => void }) {
  return (
    <GlassPanel className="px-6 py-7 md:px-10 md:py-9">
      <a className="mb-3.5 inline-flex text-[13.5px] text-ink-soft hover:text-ink" href="/learner" onClick={(e) => { e.preventDefault(); onHome() }}>‹ Learner</a>
      <h1 className="m-0 text-[clamp(28px,3.4vw,40px)] leading-[1.05] font-bold tracking-[-0.024em]">{title}</h1>
      <p className="mt-3 max-w-[60ch] text-[16.5px] leading-normal text-ink-soft">{children}</p>
    </GlassPanel>
  )
}
