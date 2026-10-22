// Prepare-only probe of the reactive cold path: selects each concept's evidence (read-only)
// and builds every part's prompt, printing prompt+schema bytes per part. No model call, no write.
//   bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env scripts/learning/prepare-probe.ts <conceptId>...
import { loadConfig } from '@learner/server/config.js'
import { createCoreHandles, createServices } from '@learner/server/services.js'
import { VectorTurnConfig, assessmentPriorMode, LIVE_COLD_SLICES } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'
import { liveIncrementalInput } from '@learner/core/lib/learning/learning-incremental-assessment.js'
import { LIVE_INCREMENTAL_VARIANT } from '@learner/core/lib/learning/learning-live-incremental-variant.js'
const refuse = () => { throw new Error('probe: no transport') }
const transport = new Proxy({}, { get: () => new Proxy({}, { get: () => refuse }) }) as never
const config = loadConfig('api')
const services = await createServices(config, createCoreHandles(config), transport, { seedCurricula: false })
const userId = 'google-operator'
const out: unknown[] = []
for (const conceptId of process.argv.slice(2)) {
  const cfg = VectorTurnConfig.parse({ purpose: 'live', selection: 'all', incremental: true, latestTurns: 50, threshold: 0.65, concurrency: 1, conceptIds: [conceptId], datasetTag: 'live', priorMode: assessmentPriorMode(process.env.LEARNING_ASSESSMENT_PRIOR_MODE) })
  const snap = await services.learningVectorTurns.selectEvidence(cfg, userId, `probe-${conceptId}`)
  const s = snap.selections[0]!
  const sources = new Map(snap.messages.map((m) => [m.id, m]))
  const evidenceBytes = s.parts.flat().reduce((n, id) => n + Buffer.byteLength(sources.get(id)?.text ?? ''), 0)
  const parts = s.parts.map((_, part) => { const b = liveIncrementalInput({ concept: s.concept, prior: null, parts: s.parts, part, turns: s.turns, context: s.context ?? [], sources, contextAllowanceBytes: cfg.contextAllowanceBytes, maxInputBytes: cfg.maxInputTokens, variant: LIVE_INCREMENTAL_VARIANT }); return Buffer.byteLength(b.prompt) + Buffer.byteLength(JSON.stringify(b.schema)) })
  out.push({ conceptId, priorMode: cfg.priorMode, coldSlices: LIVE_COLD_SLICES, maxInput: cfg.maxInputTokens, evidenceBytes, parts, over: parts.filter((b) => b >= 400_000).length })
}
console.log(JSON.stringify(out))
process.exit(0)
