// The sim worker: the product worker (worker.ts) on learner_sim, the only process that executes
// learningSimExperimentWorkflow runs (docs/specs/simulated-learner-experiment.md "Running it"). Its environment is
// sim-environment.ts; it takes the worker fence of learner_sim, recovers what a dead sim worker left and drains the
// sim queue schema. It sets no test wiring: the stub grader, the stub transport and `simTest` exist only in the test
// worker (tests/sim-worker.fixture.ts), and pinSimRunStep refuses a stub learner or test wiring on learner_sim.
import { simEnvironment } from '../sim-environment.js'

await simEnvironment()
const { codegenFresh } = await import('../../scripts/codegen-fresh.js')
if (!codegenFresh()) throw new Error('Refusing: the framework codegen is older than the sources; run `bun run generate` in packages/runtime-pikku first')
const { SIM_MAX_CONCURRENCY } = await import('@learner/core/lib/learning/learning-sim-run.js')
const { assertSimDatabase } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
const { enableCliGovernor } = await import('@learner/llm/lib/llm/llm-limits.js')
const { registerTelemetryOutbox } = await import('@learner/llm/lib/llm/learning-experiment-langfuse-transport.js')
const { runWorker } = await import('./worker.js')

await runWorker({ prepare: async () => {
  if (await assertSimDatabase() !== 'learner_sim') throw new Error('Refusing: the sim worker runs only on learner_sim')
  enableCliGovernor({ max: SIM_MAX_CONCURRENCY, min: 2 })
  // Simulated calls are recorded in learning_sim_calls; they never reach the owner's Langfuse traces.
  registerTelemetryOutbox(undefined)
} })
