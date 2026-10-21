import { useNavigate } from 'react-router-dom'
import { GlassPanel, LearnerBackdrop, PageHead } from '../components/glass'
import { GROWTHBOOK_URL, LANGFUSE_URL, LEARNER_HOME } from '../lib/routes'

/** Where the evidence lives: GrowthBook for behaviour experiments, Langfuse for lesson traces. */
export const PROGRESS_LINKS = [
  { key: 'growthbook', title: 'Experiments', body: 'Habit interventions as A/B experiments. The desktop app reports each detection and nudge here, so you can see whether a behaviour actually moved.', meta: 'GrowthBook, self-hosted', href: GROWTHBOOK_URL },
  { key: 'langfuse', title: 'Lesson traces', body: 'Every micro-lesson and assessment the AI ran, with the prompt, the model, the latency and the cost. Where you check that osmosis is teaching the right thing.', meta: 'Langfuse, self-hosted', href: LANGFUSE_URL },
] as const

export default function LearnerProgressPage() {
  const navigate = useNavigate()
  return (
    <LearnerBackdrop>
      <PageHead title="Progress" onHome={() => navigate(LEARNER_HOME)}>Two sources of truth. Experiments say whether a habit changed; traces say whether a lesson landed. A roll-up across both will sit here once the desktop app is piping data in.</PageHead>
      <div className="grid gap-4.5 md:grid-cols-2">
        {PROGRESS_LINKS.map((link) => (
          <GlassPanel key={link.key} as="article" data-testid={`learner-progress-${link.key}`} className="flex flex-col gap-2.5 p-6.5 transition hover:-translate-y-0.5 hover:bg-glass-strong">
            <h2 className="m-0 text-xl font-bold tracking-[-0.016em]">{link.title}</h2>
            <p className="m-0 text-[14.5px] leading-normal text-ink-soft">{link.body}</p>
            <span className="text-[13px] text-ink-soft">{link.meta}</span>
            <a className="mt-1.5 text-sm font-semibold text-accent" href={link.href}>Open {link.title.toLowerCase()}</a>
          </GlassPanel>
        ))}
      </div>
    </LearnerBackdrop>
  )
}
