import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/button'
import { GlassPanel, LearnerBackdrop, PageHead } from '../components/glass'
import { LEARNER_HOME, LEARNER_PROGRESS } from '../lib/routes'

/**
 * Live Feedback: the desktop half of Learner. Nothing on this server receives
 * the desktop stream yet, so the page explains the loop and states the
 * connection status honestly rather than faking a live feed.
 */
export const FEEDBACK_STAGES = [
  { tag: 'Observe', title: 'ScreenPipe watches the screen', body: 'Continuous, local capture of what is on screen and which app has focus. Nothing leaves the Mac until a detection fires.' },
  { tag: 'Detect', title: 'A behaviour matches', body: 'Rules and models run against the stream and recognise the habit you asked to change: the tab-switch spiral, the unread pile-up, the thing you said you would stop doing.' },
  { tag: 'Intervene', title: 'The band responds', body: 'A vibration to notice, or a short shock to stop. The intensity is yours to set per habit, and every intervention is logged as an exposure.' },
] as const

const SIGNALS = [
  ['👁', 'Detection', 'Which habit, in which app, at what time'],
  ['📳', 'Intervention', 'Vibration or shock, and the intensity used'],
  ['🔁', 'Outcome', 'Did the behaviour stop, and how quickly'],
  ['🧪', 'Experiment', 'The variant you were in, so results are comparable'],
] as const

export default function LearnerLiveFeedbackPage() {
  const navigate = useNavigate()
  return (
    <LearnerBackdrop>
      <PageHead title="Live Feedback" onHome={() => navigate(LEARNER_HOME)}>Habits change in the moment they happen, not in a review afterwards. The desktop app catches the behaviour as it occurs and answers it on your wrist.</PageHead>
      <GlassPanel data-testid="learner-feedback-status" className="flex items-center gap-4 rounded-[14px] px-6.5 py-5.5">
        <span className="size-3 flex-none rounded-full bg-amber-500 shadow-[0_0_0_6px_rgb(245_158_11/18%)]" aria-hidden />
        <div>
          <strong className="block text-[15px] font-semibold">Desktop app not connected</strong>
          <span className="text-sm text-ink-soft">Detections and interventions will appear here once the Mac app reports to this server. Experiment results already flow to Progress.</span>
        </div>
      </GlassPanel>
      <div className="grid gap-4.5 md:grid-cols-3">
        {FEEDBACK_STAGES.map((stage) => (
          <GlassPanel key={stage.tag} as="article" className="flex flex-col gap-2 px-6 py-5.5">
            <span className="text-[12.5px] font-semibold text-accent">{stage.tag}</span>
            <h3 className="m-0 text-[16.5px] font-semibold tracking-[-0.01em]">{stage.title}</h3>
            <p className="m-0 text-sm leading-normal text-ink-soft">{stage.body}</p>
          </GlassPanel>
        ))}
      </div>
      <GlassPanel className="px-6.5 py-5.5">
        <h3 className="mb-3 text-[15px] font-semibold">What gets recorded</h3>
        <ul className="m-0 grid list-none gap-x-5.5 gap-y-2.5 p-0 md:grid-cols-2">
          {SIGNALS.map(([icon, title, body]) => (
            <li key={title} className="grid grid-cols-[22px_1fr] gap-2.5 text-[14.5px] leading-[1.4]"><span aria-hidden>{icon}</span><div>{title}<br /><span className="text-ink-soft">{body}</span></div></li>
          ))}
        </ul>
        <div className="mt-7 flex flex-wrap gap-3"><Button variant="secondary" onClick={() => navigate(LEARNER_PROGRESS)}>See experiment results</Button></div>
      </GlassPanel>
    </LearnerBackdrop>
  )
}
