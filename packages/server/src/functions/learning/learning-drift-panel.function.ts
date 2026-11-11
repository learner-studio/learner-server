import { z } from 'zod'
import { defineFunction, defineSessionlessFunction, defineVoidFunction } from '../../runtime/define.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
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

export const planLearningDriftPanelWeekStep = defineSessionlessFunction({
  title: 'Plan the week\'s drift panel regrades (window, pending items, call cap)', input: DriftPanelWeekInput, output: DriftPanelPlan,
  func: async (_services, { week }) => {
    const policy = await loadLearningPolicy()
    if (!policy.driftPanel) return { week, enabled: false, windowId: null, windowStarted: false, cap: policy.driftPanelCallCap, items: [], overCap: 0, alreadyThisWeek: 0 }
    const window = await resolveWindow(metaDbQuery, week)
    const plan = await planWeek(metaDbQuery, week, policy.driftPanelCallCap)
    return { week, enabled: true, windowId: window.windowId, windowStarted: window.started, cap: policy.driftPanelCallCap, ...plan }
  },
})

export const regradeLearningDriftPanelItemStep = defineSessionlessFunction({
  title: 'Regrade one drift panel item prior-blind (reserved first: a replay never pays twice)', input: DriftPanelRegradeInput, output: DriftPanelRegradeOutput,
  func: async ({ learningConceptAssessment }, data) => {
    assertLearningLocalMvpEnabled()
    return regradePanelItem(metaDbQuery, learningConceptAssessment as never, data)
  },
})

export const summarizeLearningDriftPanelWeekStep = defineSessionlessFunction({
  title: 'Count the week\'s drift panel regrades', input: DriftPanelWeekInput.extend({ enabled: z.boolean(), planned: z.number().int(), overCap: z.number().int() }), output: DriftPanelWeekSummary,
  func: async (_services, { week, enabled, planned, overCap }) => ({ ...await summarizeWeek(metaDbQuery, week), enabled, planned, overCap }),
})

/** Start the week's run unless one exists for that week (any status): one run per week, however often this is called. */
async function ensureWeekRun(workflowService: { startWorkflow: (...a: never[]) => Promise<{ runId: string }> }, rpc: unknown, week: string, trigger: { type: string; userId?: string }) {
  const prior = (await metaDbQuery<{ workflow_run_id: string }>("SELECT workflow_run_id FROM learner_workflow_runs WHERE workflow='learningDriftPanelWorkflow' AND input::jsonb->>'week'=$1 ORDER BY created_at LIMIT 1", [week])).rows[0]
  if (prior) return { workflowRunId: prior.workflow_run_id, week, existing: true }
  const { runId } = await (workflowService.startWorkflow as (...a: unknown[]) => Promise<{ runId: string }>)('learningDriftPanelWorkflow', { week }, trigger, rpc)
  return { workflowRunId: runId, week, existing: false }
}

/** Weekly (SCHEDULES: learning-drift-panel, Mondays 04:00 UTC). */
export const scheduledLearningDriftPanel = defineVoidFunction({
  func: async ({ workflowService, locks, logger }, _data, ctx) => {
    await locks.withLock('learning-drift-panel', 'weekly', async () => {
      const result = await ensureWeekRun(workflowService as never, ctx!.rpc, weekOf(new Date()), { type: 'scheduled' })
      if (!result.existing) logger.info({ event: 'learning-drift-panel-started', week: result.week, workflowRunId: result.workflowRunId })
    })
  },
})

export const selectLearningDriftPanel = defineFunction({
  title: 'Choose and freeze the signed-in learner\'s drift panel (once; a stored panel is returned unchanged)', expose: true, scopes: ['admin'],
  input: z.object({}), output: DriftPanelSelection,
  func: async (_services, _data, { session }) => {
    assertLearningLocalMvpEnabled()
    return selectDriftPanel(metaDbQuery, session.userId)
  },
})

export const runLearningDriftPanel = defineFunction({
  title: 'Start this week\'s drift panel run now, unless it already exists', expose: true, scopes: ['admin'],
  input: z.object({}), output: z.object({ workflowRunId: z.string(), week: Week, existing: z.boolean() }),
  func: async ({ workflowService, locks }, _data, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    return locks.withLock('learning-drift-panel', 'weekly', () => ensureWeekRun(workflowService as never, rpc, weekOf(new Date()), { type: 'internal', userId: session.userId }))
  },
})
