/**
 * Dose-response calibration of the simulated learner (docs/specs/simulated-learner-experiment.md, "Calibration").
 *
 *   bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-calibration.ts [--run-id UUID] [--replicates 4]
 *     [--lanes slow,medium,fast] [--replies] [--exam-at 7] [--ceiling]
 *     [--learner-model gpt-5.6-luna:low] [--scorer-model gpt-5.6-luna:medium] [--stub] [--dry-run]
 *
 * Learner is not involved (no hook, agent or grader): only the learner and exam-scorer roles call a model. Runs ONLY
 * on learner_sim; a rerun with the same --run-id reuses every stored call. Results: /var/lib/learner/sim/calibration-<runId>/.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({ options: {
  'run-id': { type: 'string' }, replicates: { type: 'string', default: '4' }, lanes: { type: 'string', default: 'slow,medium,fast' },
  replies: { type: 'boolean', default: false }, 'exam-at': { type: 'string', default: '7' }, ceiling: { type: 'boolean', default: false },
  'learner-model': { type: 'string', default: 'gpt-5.6-luna:low' }, 'scorer-model': { type: 'string', default: 'gpt-5.6-luna:medium' },
  stub: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, out: { type: 'string', default: '/var/lib/learner/sim' },
} })

const base = process.env.DATABASE_URL
if (!base) throw new Error('DATABASE_URL is required: run with --env-file=/etc/learner/db.env')
const url = new URL(base); url.pathname = '/learner_sim'
process.env.LEARNER_DATABASE_URL = url.toString()
process.env.DATABASE_URL = url.toString()
for (const key of Object.keys(process.env)) if (/^LEARNING_|^LEARNER_SCHEDULES|^LEARNER_HINDSIGHT|^LEARNER_HABITS|^PG_BOSS_|^TEST_DATABASE/.test(key)) delete process.env[key]
process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = 'learner_pikku_boss_sim'

const cal = await import('@learner/core/lib/learning/learning-sim-calibration.js')
const model = (spec: string, timeoutSec: number) => { const [m, effort] = spec.split(':'); return { model: m!, effort: effort ?? 'medium', timeoutSec } }
const runId = a['run-id'] ?? randomUUID()
const replicates = Number(a.replicates)
const lanes = a.lanes!.split(',') as Array<'slow' | 'medium' | 'fast'>
const options = { replies: a.replies!, examAt: a['exam-at']!.split(',').map(Number) }
if (!options.examAt.includes(cal.CALIBRATION_SESSIONS)) throw new Error(`--exam-at must include ${cal.CALIBRATION_SESSIONS} (the final exam)`)
const models = { learner: model(a['learner-model']!, 300), scorer: model(a['scorer-model']!, 420) }
console.log(JSON.stringify({ runId, database: 'learner_sim', replicates, lanes, options, concepts: cal.CALIBRATION_CONCEPTS, doseSessions: cal.DOSE_SESSIONS, models, plannedCalls: cal.calibrationCalls(lanes.length, replicates, options, a.ceiling) }, null, 2))
if (a['dry-run']) process.exit(0)

const { createConfig } = await import('../src/config.js')
const { createSingletonServices } = await import('../src/services.js')
const services = await createSingletonServices(await createConfig())
const { assertSimDatabase } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
if (await assertSimDatabase() !== 'learner_sim') throw new Error('Refusing: calibration writes only to learner_sim')
const { registerTelemetryOutbox } = await import('@learner/llm/lib/llm/learning-experiment-langfuse-transport.js')
registerTelemetryOutbox(undefined)
const { codexTransport, stubTransport } = await import('@learner/core/lib/learning/learning-sim-model.js')
const transport = a.stub ? stubTransport() : codexTransport(services.llmService as never)

const started = Date.now()
const reps = await Promise.all(lanes.flatMap((lane) => Array.from({ length: replicates }, (_, r) => cal.runCalibrationReplicate(runId, lane, r, models, transport, options))))
const ceiling = a.ceiling ? await cal.runCalibrationCeiling(runId, models, transport) : null
const summary = cal.summarizeCalibration(reps)
const { metaDbQuery: q } = await import('@learner/core/lib/db-metadata/_shared.js')
const calls = (await q<{ role: string; n: number; ms: number }>(`SELECT role, count(*)::int n, sum(duration_ms)::int ms FROM learning_sim_calls WHERE run_id=$1 GROUP BY role ORDER BY role`, [runId])).rows
const short = (id: string) => id.split('--')[1]
const f = (x: number) => Number.isFinite(x) ? x.toFixed(0) : '-'
const { SIM_LANES } = await import('@learner/core/lib/learning/learning-sim-memory.js')
const lines = [
  `# Simulated-learner calibration ${runId}`, '',
  `${replicates} replicates per lane (concepts rotate through doses 0/1/2/4); replies ${options.replies ? 'on' : 'off'}; exams after sessions ${options.examAt.join(', ')}; learner ${models.learner.model}/${models.learner.effort}, scorer ${models.scorer.model}/${models.scorer.effort}; wall ${((Date.now() - started) / 60000).toFixed(1)} min.`, '',
  `## Final exam (after session ${cal.CALIBRATION_SESSIONS}) by dose and lane: mean (sd)`, '',
  `| lane (chars per session, forget) | ${cal.CALIBRATION_DOSES.map((d) => `dose ${d}`).join(' | ')} | monotone | facts added / over capacity / forgotten |`,
  `|---|${cal.CALIBRATION_DOSES.map(() => '---').join('|')}|---|---|`,
  ...lanes.map((lane) => { const x = summary[lane]!; return `| ${lane} (${SIM_LANES[lane].capacity}, ${SIM_LANES[lane].forget}) | ${cal.CALIBRATION_DOSES.map((d) => `${f(x.finalByDose[String(d)]!.mean)} (${f(x.finalByDose[String(d)]!.sd)})`).join(' | ')} | ${x.monotone} | ${x.added} / ${x.overCapacity} / ${x.forgotten} |` }), '',
  '## Curve by dose (mean score after each examined session)', '',
  ...lanes.flatMap((lane) => [`${lane}:`, ...cal.CALIBRATION_DOSES.map((d) => `- dose ${d}: ${Object.entries(summary[lane]!.curveByDose[String(d)]!).map(([t, v]) => `t${t}=${f(v)}`).join(', ')}`)]), '',
  '## Dose 0 by concept (leakage)', '', ...lanes.map((lane) => `- ${lane}: ${Object.entries(summary[lane]!.doseZeroByConcept).map(([id, v]) => `${short(id)}=${v}`).join(', ')}`), '',
  ...(ceiling ? ['## Ceiling controls', '', '| concept | open-book exam | rubric wording scored |', '|---|---|---|', ...cal.CALIBRATION_CONCEPTS.map((id) => `| ${short(id)} | ${ceiling.openBook[id]} | ${ceiling.reference[id]} |`), ''] : []),
  '## Per replicate (final exam per concept, [dose]; facts in the notebook per session)', '',
  ...reps.map((r) => `- ${r.lane}/${r.replicate}: ${cal.CALIBRATION_CONCEPTS.map((id) => `${short(id)}[${r.doses[id]}]=${r.exams.at(-1)!.byConcept[id]}`).join(', ')}; facts ${r.notebooks.map((n) => n.facts).join('/')}`), '',
  '## Calls', '', ...calls.map((c) => `- ${c.role}: ${c.n} calls, ${(c.ms / 60000).toFixed(1)} model-minutes`),
]
const dir = `${a.out}/calibration-${runId}`
await mkdir(dir, { recursive: true })
await writeFile(`${dir}/results.json`, JSON.stringify({ runId, models, ceiling, replicates: reps, summary, calls }, null, 2))
await writeFile(`${dir}/results.md`, lines.join('\n') + '\n')
console.log(lines.join('\n'))
await services.close?.()
process.exit(0)
