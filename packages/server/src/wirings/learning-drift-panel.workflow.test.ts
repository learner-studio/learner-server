import { expect, test } from 'bun:test'
import { learningDriftPanelWorkflow } from './learning-drift-panel.workflow.js'
import { SCHEDULES } from '../wiring/queues.js'

// The weekly run's step sequence, every step answered by a recorder.
const recorder = (plan: { enabled: boolean; items: Array<{ userId: string; item: number }>; overCap?: number }) => {
  const calls: Array<[string, string, unknown]> = []
  const workflow = {
    runId: 'wf', sleep: async () => {},
    do: async (name: string, rpc: string, data: unknown) => {
      calls.push([name, rpc, data])
      if (rpc === 'planLearningDriftPanelWeekStep') return { week: '2026-11-09', windowId: plan.enabled ? 4 : null, windowStarted: false, cap: 60, alreadyThisWeek: 0, overCap: 0, ...plan }
      if (rpc === 'regradeLearningDriftPanelItemStep') return { status: 'completed', percent: 40, calls: 1 }
      return { week: '2026-11-09', enabled: plan.enabled, planned: plan.items.length, overCap: plan.overCap ?? 0, completed: plan.items.length, failed: 0, uncertain: 0, reserved: 0, calls: plan.items.length }
    },
  }
  return { calls, context: { workflow } as never }
}

test('plan, then one regrade step per planned item with the plan\'s window, then the count', async () => {
  const { calls, context } = recorder({ enabled: true, items: [{ userId: 'u', item: 0 }, { userId: 'u', item: 1 }], overCap: 3 })
  await learningDriftPanelWorkflow.func({} as never, { week: '2026-11-09' } as never, context)
  expect(calls.map(([, rpc, data]) => [rpc, data])).toEqual([
    ['planLearningDriftPanelWeekStep', { week: '2026-11-09' }],
    ['regradeLearningDriftPanelItemStep', { userId: 'u', item: 0, week: '2026-11-09', windowId: 4 }],
    ['regradeLearningDriftPanelItemStep', { userId: 'u', item: 1, week: '2026-11-09', windowId: 4 }],
    ['summarizeLearningDriftPanelWeekStep', { week: '2026-11-09', enabled: true, planned: 2, overCap: 3 }],
  ])
  // Step names are fixed text: no user id reaches the stored run or its tooling.
  expect([...new Set(calls.map(([name]) => name))]).toEqual(['Plan this week of panel regrades', 'Regrade one panel item prior-blind', 'Count this week of regrades'])
})

test('switched off: no regrade step at all', async () => {
  const { calls, context } = recorder({ enabled: false, items: [] })
  await learningDriftPanelWorkflow.func({} as never, { week: '2026-11-09' } as never, context)
  expect(calls.map(([, rpc]) => rpc)).toEqual(['planLearningDriftPanelWeekStep', 'summarizeLearningDriftPanelWeekStep'])
})

test('scheduled weekly, Mondays 04:00 UTC', () => {
  expect(SCHEDULES.find((s) => s.func === 'scheduledLearningDriftPanel')).toEqual({ name: 'learning-drift-panel', cron: '0 4 * * 1', func: 'scheduledLearningDriftPanel' })
})
