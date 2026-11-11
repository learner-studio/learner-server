import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Review B1: a paid step whose CLI wrapper died (a control-group stop, OOM) throws `lost` from driveAttempt so the
// step's RETRY re-runs it (free) under the lease's takeover budget. With `retries: 0` that throw fails the workflow
// instead. Every wiring of a step that drives a paid attempt must retry. Add a new paid step here.
const PAID_STEPS = ['executeLearningConceptAssessmentStep', 'executeLearningAssessmentReplicateStep', 'respondLearningPlaygroundStep']
const DIR = join(import.meta.dir, '..', 'src', 'generated', 'workflows')

test('every workflow wiring of a paid step retries it', () => {
  const wirings = readdirSync(DIR).filter((f) => f.endsWith('.gen.ts')).flatMap((file) =>
    readFileSync(join(DIR, file), 'utf8').split('\n').flatMap((line) => {
      const step = PAID_STEPS.find((s) => line.includes(`'${s}'`))
      return step && line.includes('workflow.do(') ? [{ file, step, retries: Number(/retries:\s*(\d+)/.exec(line)?.[1] ?? 0) }] : []
    }))
  expect(wirings.length).toBeGreaterThanOrEqual(6) // positive control: the scan finds the wirings
  expect(wirings.filter((w) => w.retries < 1)).toEqual([])
})
