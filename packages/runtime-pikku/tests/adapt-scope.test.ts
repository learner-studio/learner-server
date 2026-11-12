import { expect, test } from 'bun:test'
import { runShared } from '../src/adapt.js'
import { defineSessionlessFunction } from '@learner/server/runtime/define.js'
import { currentCliContext } from '@learner/llm/lib/cli/cli-telemetry.js'

// A queue job (no workflowStep) that runs a durable child inline: Pikku invokes the child's step with
// wire.workflowStep, nested in the job's async context. The step's model calls must carry the child's run and the
// step's name (lease rows, Langfuse session, parentRunId); a nested call inside that step keeps the step's scope.
test('an inline child step under a queue job opens its own scope; a call nested in the step keeps it', async () => {
  const seen: Array<{ label?: string; jobId?: string }> = []
  const see = () => { const { label, jobId } = currentCliContext(); seen.push({ label, jobId }) }
  const step = (runId: string) => ({ workflowStep: { runId, invocationId: 'i', stepId: 's' } }) as any
  const services = { logger: console } as any
  const nested = defineSessionlessFunction(async () => see())
  const inner = defineSessionlessFunction(async () => { see(); await runShared('nestedFn', nested, services, {}, step('child-run')) })
  const job = defineSessionlessFunction(async () => { see(); await runShared('innerStep', inner, services, {}, step('child-run')) })
  await runShared('queueJobFn', job, services, {}, { queue: { queueName: 'q', jobId: 'j' } } as any)
  expect(seen).toEqual([{ label: 'queueJobFn', jobId: undefined }, { label: 'innerStep', jobId: 'child-run' }, { label: 'innerStep', jobId: 'child-run' }])
})
