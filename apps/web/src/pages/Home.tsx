import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/button'
import { GlassPanel, LearnerBackdrop } from '../components/glass'
import { cn } from '../lib/utils'
import { LEARNER_FEEDBACK, LEARNER_OSMOSIS, LEARNER_PROGRESS } from '../lib/routes'

/**
 * Learner home. One job: explain the loop and start it. The loop is
 * curriculum → micro-lessons → habits → evidence; the pillars underneath are
 * the doors into each surface and stay quiet so the loop reads first.
 */
const LOOP = [
  { title: 'Choose a curriculum', body: 'Pick what you want to get better at. The curriculum is the spine: lessons and habits both hang off it.' },
  { title: 'Learn by osmosis', body: 'Micro-lessons ride along inside your normal AI conversations, steered by what the curriculum says you are missing.' },
  { title: 'Change the habit', body: 'The desktop app watches how you actually work and nudges in the moment: a buzz on the band, or a short shock.' },
  { title: 'See the evidence', body: 'Every lesson and every nudge lands in an experiment, so improvement is measured rather than felt.' },
] as const

export const PILLARS = [
  { key: 'osmosis', icon: '🧠', title: 'Osmosis', body: 'Set your curriculum and let micro-lessons flow through the AI you already talk to all day.', foot: 'Open the curriculum', path: LEARNER_OSMOSIS },
  { key: 'feedback', icon: '⚡', title: 'Live Feedback', body: 'Real-time habit detection on the desktop, with a haptic or electric nudge the moment a behaviour shows up.', foot: 'See how it works', path: LEARNER_FEEDBACK },
  { key: 'progress', icon: '📈', title: 'Progress', body: 'Experiments and lesson traces, side by side. Empirical proof that the loop is working, or that it is not.', foot: 'View the numbers', path: LEARNER_PROGRESS },
] as const

const SYSTEM = [
  ['🧠', 'Osmosis', 'Micro-lessons through the AI you use'],
  ['⚡', 'Live Feedback', 'Habit detection and intervention on the desktop'],
  ['📈', 'Progress', 'Experiments and traces as evidence'],
] as const

export function LearnerHome({ onNavigate }: { readonly onNavigate: (path: string) => void }) {
  return (
    <LearnerBackdrop>
      <GlassPanel className="grid items-end gap-10 px-6 py-8 md:grid-cols-[1.4fr_1fr] md:px-12 md:py-11">
        <div>
          <p className="mb-3.5 text-[15px] font-semibold tracking-[0.02em] text-ink-soft">Learner</p>
          <h1 className="m-0 max-w-[20ch] text-[clamp(34px,4.6vw,54px)] leading-[1.02] font-bold tracking-[-0.028em]">Decide what to learn. The rest follows you around.</h1>
          <p className="mt-4.5 max-w-[46ch] text-lg leading-[1.45] text-ink-soft">One curriculum drives three things: lessons slipped into your AI conversations, nudges when an old habit shows up, and numbers that say whether any of it worked.</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button onClick={() => onNavigate(LEARNER_OSMOSIS)}>Set your curriculum</Button>
            <Button variant="secondary" onClick={() => onNavigate(LEARNER_PROGRESS)}>See progress</Button>
          </div>
        </div>
        <div className="grid gap-2.5" aria-label="What Learner is made of">
          {SYSTEM.map(([icon, title, body]) => (
            <div key={title} className="grid grid-cols-[26px_1fr] items-start gap-3 text-[14.5px] leading-[1.4]">
              <span className="grid size-[26px] place-items-center rounded-lg border border-glass-border bg-glass-strong text-sm">{icon}</span>
              <div><strong className="block font-semibold">{title}</strong><span className="text-ink-soft">{body}</span></div>
            </div>
          ))}
        </div>
      </GlassPanel>

      <GlassPanel className="px-8 py-7" aria-label="The learning loop">
        <p className="mb-4.5 text-[13px] font-semibold text-ink-soft">How a session runs</p>
        <ol className="loop-rule relative m-0 grid list-none grid-cols-1 gap-5 p-0 md:grid-cols-4 md:gap-0">
          {LOOP.map((step, i) => (
            <li key={step.title} className="relative px-3.5">
              <div className={cn('relative mb-3.5 grid size-11 place-items-center rounded-full border border-glass-border bg-glass-strong text-[15px] font-bold shadow-[0_6px_18px_rgb(20_22_43/10%)]', i === 0 && 'border-transparent bg-accent text-accent-ink')}>{i + 1}</div>
              <h3 className="mb-1 text-base font-semibold tracking-[-0.01em]">{step.title}</h3>
              <p className="m-0 text-sm leading-[1.45] text-ink-soft">{step.body}</p>
            </li>
          ))}
        </ol>
      </GlassPanel>

      <div className="grid gap-4.5 md:grid-cols-3">
        {PILLARS.map((pillar) => (
          <GlassPanel
            key={pillar.key} as="article" role="link" tabIndex={0} data-testid={`learner-pillar-${pillar.key}`}
            className="flex min-h-[210px] cursor-pointer flex-col gap-3 px-6.5 pt-6.5 pb-5.5 transition hover:-translate-y-0.5 hover:bg-glass-strong focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-accent"
            onClick={() => onNavigate(pillar.path)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate(pillar.path) } }}
          >
            <span className="text-[26px] leading-none" aria-hidden>{pillar.icon}</span>
            <h2 className="mt-1.5 text-[21px] font-bold tracking-[-0.018em]">{pillar.title}</h2>
            <p className="m-0 flex-1 text-[14.5px] leading-normal text-ink-soft">{pillar.body}</p>
            <span className="text-sm font-semibold text-accent">{pillar.foot}</span>
          </GlassPanel>
        ))}
      </div>
    </LearnerBackdrop>
  )
}

export default function LearnerHomePage() {
  const navigate = useNavigate()
  return <LearnerHome onNavigate={(path) => navigate(path)} />
}
