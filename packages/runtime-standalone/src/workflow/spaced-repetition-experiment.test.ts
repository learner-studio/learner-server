import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { database, isDatabaseBound } from '@learner/core/db/handle.js'
import { LearningCurriculumStore } from '@learner/core/services/learning-curriculum-store.js'
import { LearningConceptAssessmentService } from '@learner/core/services/learning-concept-assessment.js'
import { LearningVectorTurnService } from '@learner/core/services/learning-vector-turn-service.js'
import { TelemetryOutboxService } from '@learner/core/services/telemetry-outbox-service.js'
import { LangfuseTelemetryDestination, registerTelemetryOutbox } from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import { SPACED_REPETITION_FIXTURE, experimentUserId } from '@learner/core/lib/learning/learning-spaced-repetition-experiment.js'
import { buildRegistry } from '@learner/server/functions/registry.js'
import type { Services } from '@learner/server/services.js'
import { FunctionRuntime } from '../host.js'
import { DurableEngine } from './durable.js'

/**
 * learningSpacedRepetitionExperimentWorkflow end to end on learner_test, in the standalone durable
 * engine: every fixture prompt goes through the live hook path and must match its expectation.
 * SPACED_REPETITION_LANGFUSE=true also exports the run to the local Langfuse and reads it back.
 */
const exportToLangfuse = process.env.SPACED_REPETITION_LANGFUSE === 'true'
describe.skipIf(!process.env.TEST_DATABASE_URL || !isDatabaseBound())('spaced-repetition experiment workflow (learner_test)', () => {
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  const db = database()
  const store = new LearningCurriculumStore(db.kysely)
  const services = {
    db, kysely: db.kysely, learningCurriculumStore: store,
    learningVectorTurns: new LearningVectorTurnService(db.kysely, new LearningConceptAssessmentService(store, undefined as never), store),
  } as unknown as Services
  if (exportToLangfuse) registerTelemetryOutbox(new TelemetryOutboxService(db.query, { langfuse: new LangfuseTelemetryDestination() }))
  const engine = new DurableEngine(db).attach(new FunctionRuntime(buildRegistry(), () => services))
  const runId = randomUUID()
  afterAll(() => { if (exportToLangfuse) registerTelemetryOutbox(undefined) })

  test(`every prompt (${SPACED_REPETITION_FIXTURE.cases.length}) matches its expectation, then fixture rows are removed`, async () => {
    const { runId: workflowRunId } = await engine.startWorkflow('learningSpacedRepetitionExperimentWorkflow', { runId, export: exportToLangfuse }, { type: 'internal' }, undefined, { inline: true })
    const run = await engine.getRun(workflowRunId)
    expect(run?.status).toBe('completed')
    const summary = run!.output as { cases: number; passed: number; failed: unknown[]; selectedHops: Record<string, number>; removed: { turns: number; cache: number }; langfuse?: { sessionId: string; traces: number } }
    console.log(JSON.stringify(summary))
    for (const step of await engine.getRunSteps(workflowRunId)) {
      const output = step.result as { pass?: boolean; actual?: unknown; context?: string } | null
      if (output?.pass === false) console.log(step.stepName, JSON.stringify(output.actual), output.context)
    }
    expect(summary.failed).toEqual([])
    expect(summary.passed).toBe(SPACED_REPETITION_FIXTURE.cases.length)
    // Selected reviews span every hop distance the setting distinguishes, and one beyond it.
    expect(Object.keys(summary.selectedHops).map(Number).sort((a, b) => a - b)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5]))
    expect(Object.keys(summary.selectedHops).some((h) => Number(h) > 5)).toBe(true)
    expect(summary.removed.turns).toBeGreaterThan(0)
    const left = await db.query('SELECT count(*)::int n FROM learning_live_feedback_turns WHERE user_id LIKE $1', [`${experimentUserId(runId, '')}%`])
    expect(left.rows[0]).toEqual({ n: 0 })
    if (exportToLangfuse) expect(summary.langfuse?.traces).toBe(SPACED_REPETITION_FIXTURE.cases.length)
  }, 300_000)
})
