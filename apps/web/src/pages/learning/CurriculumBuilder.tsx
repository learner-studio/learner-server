import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { RpcOutput } from '@learner/contract'
import { Alert } from '../../components/ui/alert'
import { Badge, type BadgeTone } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Field, Input } from '../../components/ui/input'
import { Spinner } from '../../components/ui/progress'
import { LearnerBackdrop, PageHead } from '../../components/glass'
import { useRpcMutation, useRpcQuery } from '../../lib/api'
import { LEARNER_HOME, LEARNER_OSMOSIS } from '../../lib/routes'
import { errorText } from './learning-model'
import { OsmosisNav } from './OsmosisNav'

/**
 * State a learning objective, read the syllabus an agent found, and decide.
 *
 * The approval gate is the whole point of the screen, so it is the only thing
 * that gets a decision: everything else — interpreting, searching, reading —
 * is reported as progress, not as a question. A learner is asked exactly once,
 * about the outline, before anything is written to their library.
 *
 * The outline is shown as the sources' own words rather than as a summary of
 * them. What is being approved is a transcription of published course
 * material, and a learner cannot judge a transcription they are not shown.
 */

/** How the run's phases read to someone waiting. Ordered, so the current one
 * can be shown against the ones already done. */
const PHASES = [
  { status: 'interpreting', label: 'Reading your objective' },
  { status: 'sourcing', label: 'Searching open course providers' },
  { status: 'fetching', label: 'Reading the published material' },
  { status: 'outlining', label: 'Transcribing it into an outline' },
  { status: 'awaiting-approval', label: 'Waiting for you' },
  { status: 'inferring', label: 'Working out the prerequisites' },
  { status: 'writing', label: 'Building the skill tree' },
  { status: 'completed', label: 'Done' },
] as const

const IN_FLIGHT = new Set<string>(['interpreting', 'sourcing', 'fetching', 'outlining', 'inferring', 'writing'])

const STATUS_TONE: Record<string, BadgeTone> = {
  'awaiting-approval': 'warning', completed: 'success', failed: 'danger', rejected: 'neutral',
}

type Run = RpcOutput<'listCurriculumGenerationRuns'>['runs'][number]
type Decision = 'approve' | 'reject' | 'rebuild'

export default function CurriculumBuilderPage() {
  const navigate = useNavigate()
  const [objective, setObjective] = useState('')
  const [watching, setWatching] = useState<string | null>(null)

  const runs = useRpcQuery('listCurriculumGenerationRuns', {}, {
    // Only poll while something is actually moving. A library of finished runs
    // is a static list, and polling it forever is a background cost a learner
    // pays for nothing.
    refetchInterval: (query) => (query.state.data?.runs ?? []).some((run) => IN_FLIGHT.has(run.status)) ? 4000 : false,
  })
  const start = useRpcMutation('startCurriculumGeneration')
  const approve = useRpcMutation('approveCurriculumOutline')
  const reject = useRpcMutation('rejectCurriculumOutline')
  const rebuild = useRpcMutation('rebuildCurriculumTree')

  const list = runs.data?.runs ?? []
  const selected = list.find((run) => run.runId === watching) ?? list.find((run) => run.status === 'awaiting-approval') ?? list[0]
  const busy = start.isPending || approve.isPending || reject.isPending || rebuild.isPending
  const decisionError = approve.error ?? reject.error ?? rebuild.error

  const submit = async () => {
    const stated = objective.trim()
    if (stated.length < 8) return
    const started = await start.mutateAsync({ objective: stated }).catch(() => null)
    if (!started) return
    setObjective('')
    setWatching(started.runId)
    await runs.refetch()
  }

  const decide = async (decision: Decision, runId: string) => {
    const mutation = decision === 'approve' ? approve : decision === 'rebuild' ? rebuild : reject
    await mutation.mutateAsync({ runId }).catch(() => null)
    await runs.refetch()
  }

  return (
    <LearnerBackdrop>
      <OsmosisNav />
      <PageHead title="Build a curriculum" onHome={() => navigate(LEARNER_HOME)}>
        Say what you want to understand. An agent searches open course providers, reads a real published syllabus, and proposes an outline. Nothing is added to your library until you approve it.
      </PageHead>
      <Card className="flex flex-col gap-4" data-testid="curriculum-builder">
        <div className="flex items-center justify-between gap-2">
          <strong>New objective</strong>
          <Badge tone="accent">Grounded in published courses</Badge>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="What do you want to understand?" className="min-w-60 flex-1">
            <Input placeholder="I want to understand finance better" value={objective} disabled={busy}
              onChange={(event) => setObjective(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} />
          </Field>
          <Button size="md" onClick={() => void submit()} disabled={busy || objective.trim().length < 8}>Create syllabus</Button>
        </div>
        {start.isError && <Alert tone="danger">Could not start: the objective was not accepted.</Alert>}
        {decisionError && <Alert tone="danger" title="That decision did not go through">{errorText(decisionError)}</Alert>}
        {runs.error && <Alert tone="danger" title="Curriculum runs unavailable">{errorText(runs.error)}</Alert>}

        {runs.isLoading && <Spinner />}
        {!runs.isLoading && !runs.error && list.length === 0 && <p className="m-0 text-sm text-ink-soft">No curricula asked for yet.</p>}

        {list.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {list.map((run) => (
              // Named so an end-to-end check can count the runs the learner is
              // offered without selecting on the objective prose, which two
              // runs of the same build deliberately share.
              <Button key={run.runId} data-testid="curriculum-run-choice" size="sm" variant={run.runId === selected?.runId ? 'primary' : 'secondary'} onClick={() => setWatching(run.runId)}>
                {run.objective.length > 48 ? `${run.objective.slice(0, 48)}…` : run.objective}
              </Button>
            ))}
          </div>
        )}
      </Card>

      {selected && <RunPanel run={selected} busy={busy} onDecide={decide} />}
    </LearnerBackdrop>
  )
}

function RunPanel({ run, busy, onDecide }: {
  readonly run: Run
  readonly busy: boolean
  readonly onDecide: (decision: Decision, runId: string) => Promise<void>
}) {
  const reached = PHASES.findIndex((phase) => phase.status === run.status)
  const outline = run.outline
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <strong>{run.objective}</strong>
        {/* Named so an end-to-end check can read the phase the LEARNER sees.
            A run that reaches `completed` in the database while this badge
            stops updating is still a broken build, and only a selector on
            the rendered badge can tell the two apart. */}
        <Badge data-testid="curriculum-run-status" tone={STATUS_TONE[run.status] ?? 'accent'}>{run.status}</Badge>
      </div>

      {IN_FLIGHT.has(run.status) && (
        <div className="flex items-center gap-2 text-sm">
          <Spinner className="size-3" />
          <span>{PHASES[reached]?.label ?? 'Working'}</span>
          <span className="text-xs text-ink-soft">step {reached + 1} of {PHASES.length}</span>
        </div>
      )}

      {run.status === 'failed' && (
        // The reason is shown rather than a generic failure, because the most
        // common one is "none of the published courses found teach this",
        // which tells the learner to restate the objective — advice a spinner
        // that stops cannot give.
        <Alert tone="danger" title="This run could not be built"><span className="whitespace-pre-wrap">{run.error ?? 'No reason recorded.'}</span></Alert>
      )}

      {run.status === 'completed' && run.curriculumId && (
        <Alert tone="success" title="Your skill tree is ready">
          <Link to={`${LEARNER_OSMOSIS}?curriculumId=${encodeURIComponent(run.curriculumId)}`} className="mt-1 inline-block rounded-md bg-accent px-2 py-0.5 text-xs font-semibold text-accent-ink">Open it</Link>
        </Alert>
      )}

      {outline && (
        <div className="flex flex-col gap-2 border-t border-rule pt-3">
          <h4 className="m-0 text-base font-bold">{outline.title}</h4>
          <p className="m-0 text-sm">{outline.description}</p>
          <span className="text-xs text-ink-soft" data-testid="curriculum-outline-spread">{outline.modules.length} modules across {outline.lanes.length} strands, {outline.moduleDependencies.length} prerequisites</span>
          {outline.lanes.map((lane) => (
            <div key={lane.id} className="flex flex-col gap-0.5" data-testid="curriculum-outline-lane">
              <strong className="text-sm">{lane.title}</strong>
              <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
                {outline.modules.filter((module) => module.laneId === lane.id).map((module) => {
                  // The prerequisite spine is part of what the approve button
                  // approves. Showing the module titles rather than a count is
                  // the difference between a learner agreeing to an ordering
                  // and a learner agreeing to the existence of one.
                  const after = outline.moduleDependencies
                    .filter((dependency) => dependency.moduleId === module.id)
                    .map((dependency) => outline.modules.find((other) => other.id === dependency.dependsOnModuleId)?.title)
                    .filter((title): title is string => Boolean(title))
                  return (
                    <li key={module.id} data-testid="curriculum-outline-module">
                      <span className="block text-sm">{module.title}</span>
                      <span className="block text-xs text-ink-soft">{module.topics.join(' · ')}</span>
                      {after.length > 0 && <span className="block text-xs text-ink-soft italic" data-testid="curriculum-outline-after">after {after.join(', ')}</span>}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {(run.status === 'awaiting-approval' || (run.status === 'failed' && outline)) && (
        <div className="flex flex-wrap gap-2">
          <Button size="md" onClick={() => void onDecide('approve', run.runId)} disabled={busy}>{run.status === 'failed' ? 'Try building it again' : 'Approve and build the tree'}</Button>
          <Button size="md" variant="secondary" onClick={() => void onDecide('reject', run.runId)} disabled={busy}>Turn it down</Button>
        </div>
      )}

      {run.status === 'completed' && outline && (
        <div className="flex flex-wrap items-center gap-2">
          {/* The outline is NOT regenerated here, which is the point of offering
            * this separately from "create syllabus": the lessons the learner
            * approved stay exactly as they are, and only the concepts hanging
            * beneath them are written again. */}
          <Button size="md" variant="secondary" onClick={() => void onDecide('rebuild', run.runId)} disabled={busy}>Rebuild the concepts from this outline</Button>
          <span className="text-xs text-ink-soft">Keeps the modules and lessons; replaces the concept network under them.</span>
        </div>
      )}
    </Card>
  )
}
