import { rpcService } from '@pikku/core/rpc'
import { simStubGrader } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { codexTransport, stubTransport, type SimTransport } from '@learner/core/lib/learning/learning-sim-model.js'
import { runWorker } from '../src/bin/worker.js'

/**
 * The TEST sim worker (simulated-learner.test.ts): the product worker (`runWorker`, as bin/sim-worker.ts runs it) on
 * the test file's sim database, with the stub seams the real sim worker never has: the stub grader, the stub
 * transport, and SIM_TEST (`simTest`: the test's looks). SIM_START ({ workflow, input }) is started once: if a run of
 * that workflow with that input's runId exists, the worker only recovers and drains it. The call SIM_CODEX_KEY goes
 * through the real Codex transport (the crash harness's fake slow `codex`, so it can be killed mid-call and its
 * detached child adopted). With SIM_HANG=record it prints `HUNG` and never returns inside a grading (settled by the
 * product workflow, its rows not yet written); the test then stops it.
 */
const services = await runWorker({ adoptUnversioned: false, prepare: (raw) => {
  const s = raw as typeof raw & Record<string, unknown>
  const grader = simStubGrader(s.learningCurriculumStore)
  const run = grader.run.bind(grader)
  const hang = () => { console.log('HUNG'); return new Promise<never>(() => {}) }
  // recordSimGrade is the only caller with no user id.
  grader.run = (runId, userId) => (process.env.SIM_HANG === 'record' && !userId ? hang() : run(runId, userId))
  s.learningConceptAssessment = grader
  const stub = stubTransport(), codex = codexTransport(s.llmService as Parameters<typeof codexTransport>[0])
  s.simTransport = Object.assign(((spec, durable) => spec.callKey === process.env.SIM_CODEX_KEY ? codex(spec, durable) : stub(spec)) as SimTransport, { backend: codex.backend })
  if (process.env.SIM_TEST) s.simTest = JSON.parse(process.env.SIM_TEST)
} })
const start = JSON.parse(process.env.SIM_START!) as { workflow: string; input: { runId: string } }
const prior = (await services.db.query(`SELECT 1 FROM learner_workflow_runs WHERE workflow=$1 AND input::jsonb->>'runId'=$2`, [start.workflow, start.input.runId])).rows.length
if (!prior) console.log(`STARTED ${(await services.workflowService.startWorkflow(start.workflow, start.input, { type: 'internal' }, rpcService.getContextRPCService(services, {}, false))).runId}`)
