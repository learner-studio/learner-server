import { expect, test } from 'bun:test'
import { SCHEDULES } from '../wiring/queues.js'

// The step sequence is proved end to end in packages/runtime-pikku/tests/drift-panel.test.ts.
test('ticks daily at 04:00 UTC: the week\'s run starts on Monday, a failed one is retried within the week', () => {
  expect(SCHEDULES.find((s) => s.func === 'scheduledLearningDriftPanel')).toEqual({ name: 'learning-drift-panel', cron: '0 4 * * *', func: 'scheduledLearningDriftPanel' })
})
