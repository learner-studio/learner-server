import { createHash, randomUUID } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'

import {
  CLASSIFIER_V6_CATALOG,
  CLASSIFIER_V6_CATALOG_HASH,
  classifierV6Prompt,
} from '@learner/core/lib/learning/learning-classifier-v6.js'
import {
  GRADUAL_ASSESSMENT_REVISION,
  gradualAssessmentPrompt,
  gradualAssessmentSchema,
} from '@learner/core/lib/learning/learning-gradual-assessment.js'
import { usage } from './_db.js'

type SourceMessage = {
  id: string
  logicalMessageKey: string
  observedAt: string
  rawVersionId: string
  text: string
  textSha256: string
  media: unknown[]
}
type SourceCase = { caseId: string; ordinal: number; exchangeId: string; current: SourceMessage; response: SourceMessage }
type SourceManifest = {
  schemaVersion: number
  label: string
  cutoff: string
  pairCount: number
  messageCount: number
  membershipDigest: string
  cases: SourceCase[]
  sourceCompleteness: Record<string, unknown>
  selection: Record<string, unknown>
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const stable = (value: unknown): string => JSON.stringify(value, Object.keys(value as object).sort())

export function preparePilot(source: SourceManifest, runId: string) {
  if (source.pairCount !== 3 || source.messageCount !== 6 || source.cases.length !== 3) throw new Error('Pilot requires exactly three frozen pairs')
  if (new Set(source.cases.map(item => item.caseId)).size !== 3) throw new Error('Pilot case IDs must be unique')
  for (const item of source.cases) {
    if (!item.current.text || !item.response.text || hash(item.current.text) !== item.current.textSha256 || hash(item.response.text) !== item.response.textSha256) {
      throw new Error(`Pilot source text hash mismatch: ${item.caseId}`)
    }
  }
  const classifierCases: Parameters<typeof classifierV6Prompt>[0] = source.cases.map(item => ({ caseId: item.caseId, snapshot: {
    context: [],
    current: { id: item.current.id, threadId: item.exchangeId, exchangeId: item.exchangeId, agent: 'Codex', provider: 'openai',
      role: 'user', authorship: 'human', authorshipEvidence: 'canonical exposure projection', text: item.current.text,
      timestamp: item.current.observedAt, model: null, cwd: null },
    contextCompleteness: { assistantTurns: 'unavailable', toolOutput: 'unavailable', taskOutcome: 'unavailable', receiptContext: 'unavailable' },
    ontologyCandidateIds: [],
  } }))
  const classifierPrompt = classifierV6Prompt(classifierCases)
  const nodeStates = CLASSIFIER_V6_CATALOG.map(concept => {
    const nodeVersion = hash(JSON.stringify({ conceptId: concept.id, title: concept.title, understandingPercent: null }))
    return { conceptId: concept.id, nodeVersion, understandingPercent: null }
  })
  const assessmentSchema = gradualAssessmentSchema(nodeStates.map(item => item.conceptId))
  const assessmentContractPrompt = gradualAssessmentPrompt({ nodeStates, nativeObservations: [], evidence: [] })
  return {
    ...source,
    runId,
    experimentTag: `hindsight-agy-pilot-${runId}`,
    bankId: `learning-hindsight-agy-pilot-${runId}`,
    conceptCatalog: CLASSIFIER_V6_CATALOG.map(({ id, title }) => ({ id, title })),
    nodeStates,
    contracts: {
      classifierRevision: 'classifier-v6',
      classifierCatalogSha256: CLASSIFIER_V6_CATALOG_HASH,
      classifierPromptSha256: hash(classifierPrompt),
      classifierPromptBytes: Buffer.byteLength(classifierPrompt),
      assessmentRevision: GRADUAL_ASSESSMENT_REVISION,
      assessmentContractPromptSha256: hash(assessmentContractPrompt),
      assessmentSchemaSha256: hash(JSON.stringify(assessmentSchema)),
      assessmentSchemaBytes: Buffer.byteLength(JSON.stringify(assessmentSchema)),
      nodeStateSha256: hash(JSON.stringify(nodeStates)),
      nodeStateBaseline: 'synthetic-empty-current-catalog',
      nodeStateBaselineLimitation: 'No persisted learner-assessment store exists; all current catalog nodes are frozen as unknown for this review-only pilot.',
      reflectResponseSchemaSentToHindsight: false,
      innerAssessmentValidation: 'local-zod-and-source-validation-no-repair',
    },
  }
}

async function main() {
  const [sourcePath, outputPath, requestedRunId] = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
  usage(`
Usage: bun scripts/learning/hindsight-pilot-prepare.ts SOURCE OUTPUT [RUN_ID]
Freezes a three-pair cohort manifest (from hindsight-cohort.ts) with the current
classifier-v6 and gradual-assessment contracts into OUTPUT (must not exist).
No database, no model calls.`, !sourcePath || !outputPath)
  const runId = requestedRunId ?? randomUUID()
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error('RUN_ID must be a UUID')
  const sourceBytes = await readFile(sourcePath!)
  const prepared = preparePilot(JSON.parse(sourceBytes.toString('utf8')), runId)
  const payload = `${JSON.stringify({ ...prepared, sourceManifestSha256: hash(sourceBytes) }, null, 2)}\n`
  await writeFile(outputPath!, payload, { flag: 'wx', mode: 0o600 })
  await chmod(outputPath!, 0o600)
  process.stdout.write(`${JSON.stringify({ runId, outputPath, sha256: hash(payload), pairCount: 3, messageCount: 6 })}\n`)
}

if (import.meta.main) await main()
