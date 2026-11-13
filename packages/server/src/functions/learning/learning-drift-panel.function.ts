import { z } from 'zod'
import { pikkuFunc, pikkuSessionlessFunc, pikkuVoidFunc } from '#pikku/function'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { priorRun } from '../../runtime/start-once.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { loadLearningPolicy } from '@learner/core/lib/learning/learning-policy-settings.js'
import { planWeek, regradePanelItem, RegradeStatus, resolveWindow, selectDriftPanel, summarizeWeek, weekOf } from '@learner/core/lib/learning/grader-drift-panel.js'

/**
 * The weekly grader-drift regrade panel (docs/specs/mastery-change-statistics.md, "Drift panel"):
 * a learner's panel is chosen once (selectLearningDriftPanel); every Monday the scheduled run
 * regrades each item prior-blind with the shipped grader (learningDriftPanelWorkflow). Outputs carry
 * ids, statuses and numbers only: evidence never leaves the database.
 */
const Week = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const DriftPanelWeekInput = z.object({ week: Week })
export const DriftPanelPlan = z.object({
  week: Week, enabled: z.boolean(), windowId: z.number().int().nullable(), windowStarted: z.boolean(), cap: z.number().int(),
  items: z.array(z.object({ userId: z.string(), item: z.number().int() })), overCap: z.number().int(), alreadyThisWeek: z.number().int(),
})
export const DriftPanelRegradeInput = z.object({ userId: z.string(), item: z.number().int(), week: Week, windowId: z.number().int() })
export const DriftPanelRegradeOutput = DriftPanelRegradeInput.omit({ windowId: true }).extend({ status: RegradeStatus, percent: z.number().nullable(), calls: z.number().int() })
export const DriftPanelWeekSummary = z.object({
  week: Week, enabled: z.boolean(), planned: z.number().int(), overCap: z.number().int(),
  completed: z.number().int(), failed: z.number().int(), uncertain: z.number().int(), reserved: z.number().int(), calls: z.number().int(),
})
export const DriftPanelSelection = z.object({ userId: z.string(), created: z.boolean(), size: z.number().int(), candidates: z.number().int(), selectionRevision: z.string(), selectedAt: z.string().nullable() })

export const planLearningDriftPanelWeekStep = pikkuSessionlessFunc({
  title: 'Plan the week\'s drift panel regrades (window, pending items, call cap)', input: DriftPanelWeekInput, output: DriftPanelPlan,
  func: async (_services, { week }) => {
    const policy = await loadLearningPolicy()
    if (!policy.driftPanel) return { week, enabled: false, windowId: null, windowStarted: false, cap: policy.driftPanelCallCap, items: [], overCap: 0, alreadyThisWeek: 0 }
    const window = await resolveWindow(metaDbQuery, week)
    const plan = await planWeek(metaDbQuery, week, policy.driftPanelCallCap)
    return { week, enabled: true, windowId: window.windowId, windowStarted: window.started, cap: policy.driftPanelCallCap, ...plan }
  },
})

export const regradeLearningDriftPanelItemStep = pikkuSessionlessFunc({
  title: 'Regrade one drift panel item prior-blind (reserved first: a replay never pays twice)', input: DriftPanelRegradeInput, output: DriftPanelRegradeOutput,
  func: async ({ learningConceptAssessment }, data) => {
    assertLearningLocalMvpEnabled()
    return regradePanelItem(metaDbQuery, learningConceptAssessment as never, data)
  },
})

export const DriftPanelSummarizeInput = DriftPanelWeekInput.extend({ enabled: z.boolean(), planned: z.number().int(), overCap: z.number().int() })
export const summarizeLearningDriftPanelWeekStep = pikkuSessionlessFunc({
  title: 'Count the week\'s drift panel regrades', input: DriftPanelSummarizeInput, output: DriftPanelWeekSummary,
  func: async (_services, { week, enabled, planned, overCap }) => ({ ...await summarizeWeek(metaDbQuery, week), enabled, planned, overCap }),
})

/**
 * The week's run, once: a live or finished run for the week counts. A failed or cancelled one does not, so the next
 * call starts the week again (review round 1, S3); that run plans only what has no final outcome yet.
 */
export const weekRun = async (week: string) => (await priorRun('learningDriftPanelWorkflow', { week }, 'week', ['failed', 'cancelled']))?.workflow_run_id

/** SCHEDULES: learning-drift-panel, daily 04:00 UTC: Monday's tick starts the week's run; a later tick only retries a failed or cancelled one. */
export const scheduledLearningDriftPanel = pikkuVoidFunc({
  func: async ({ locks, logger }, _data, { rpc }) => {
    await locks.withLock('learning-drift-panel', 'weekly', async () => {
      const week = weekOf(new Date())
      if (await weekRun(week)) return
      const { runId } = await rpc.startWorkflow('learningDriftPanelWorkflow', { week }, { wire: { type: 'scheduled' } })
      logger.info({ event: 'learning-drift-panel-started', week, workflowRunId: runId })
    })
  },
})

export const DriftPanelNoInput = z.object({})
export const selectLearningDriftPanel = pikkuFunc({
  title: 'Choose and freeze the signed-in learner\'s drift panel (once; a stored panel is returned unchanged)', expose: true, scopes: ['admin'],
  input: DriftPanelNoInput, output: DriftPanelSelection,
  func: async (_services, _data, { session }) => {
    assertLearningLocalMvpEnabled()
    return selectDriftPanel(metaDbQuery, session.userId)
  },
})

export const DriftPanelRun = z.object({ workflowRunId: z.string(), week: Week, existing: z.boolean() })
export const runLearningDriftPanel = pikkuFunc({
  title: 'Start this week\'s drift panel run now, unless it already exists', expose: true, scopes: ['admin'],
  input: DriftPanelNoInput, output: DriftPanelRun,
  func: async ({ locks }, _data, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    return locks.withLock('learning-drift-panel', 'weekly', async () => {
      const week = weekOf(new Date())
      const existing = await weekRun(week)
      if (existing) return { workflowRunId: existing, week, existing: true }
      return { workflowRunId: (await rpc.startWorkflow('learningDriftPanelWorkflow', { week }, { wire: { type: 'internal', pikkuUserId: session.userId } })).runId, week, existing: false }
    })
  },
})
