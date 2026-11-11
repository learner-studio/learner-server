import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { simStubGrader, type SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { codexTransport, stubTransport, type SimTransport } from '@learner/core/lib/learning/learning-sim-model.js'

/** A worker for the crash test (simulated-learner.test.ts), booted like bin/worker.ts: it recovers the runs a dead
 * process left, starts (or adopts) the learner's run, and stops its queue workers on SIGTERM. The call SIM_CODEX_KEY
 * goes through the real Codex transport (the crash harness's fake slow `codex`, so it can be killed mid-call and its
 * detached child adopted); every other call is the stub. With SIM_HANG=record it prints `HUNG` and never returns
 * inside a grading (settled by the product workflow, its rows not yet written); the test then stops it. */
setRuntimeRole('learning-worker')
await import('../.pikku/pikku-bootstrap.gen.js')
const { createConfig } = await import('../src/config.js')
const { createSingletonServices } = await import('../src/services.js')
const { recoverInterruptedRuns } = await import('../src/recovery.js')
const { startSimLearners } = await import('../src/sim-learners.js')
const services = await createSingletonServices(await createConfig()) as Awaited<ReturnType<typeof createSingletonServices>> & Record<string, unknown>
const hang = () => { console.log('HUNG'); return new Promise<never>(() => {}) }
const grader = simStubGrader(services.learningCurriculumStore)
const run = grader.run.bind(grader)
// recordSimGrade is the only caller with no user id.
grader.run = (runId, userId) => (process.env.SIM_HANG === 'record' && !userId ? hang() : run(runId, userId))
services.learningConceptAssessment = grader
const stub = stubTransport(), codex = codexTransport(services.llmService as Parameters<typeof codexTransport>[0])
services.simTransport = Object.assign(((spec, durable) => spec.callKey === process.env.SIM_CODEX_KEY ? codex(spec, durable) : stub(spec)) as SimTransport, { backend: codex.backend })
await recoverInterruptedRuns(services.workflowRunService, services.workflowService, { bootedAt: Date.now(), logger: services.logger })
await services.backgroundJobs.start()
process.on('SIGTERM', async () => { await services.backgroundJobs.stop(); process.exit(0) })
await startSimLearners(services, [JSON.parse(process.argv[2]!) as SimLearnerConfig])
