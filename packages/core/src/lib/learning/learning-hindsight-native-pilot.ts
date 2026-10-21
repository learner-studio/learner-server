import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

import { metaDbWithClient } from '../db-metadata/_shared.js'

export const HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY = 'hindsight-agy-native-pilot-v1' as const

export type NativeRetainCheckpoint = {
  retainState?: string
  retainOperationId?: string
  retainRequestSha256?: string
}

/**
 * Reserve a paid native retain before transport. A crash after POST but before
 * the operation checkpoint deliberately leaves an uncertain reservation that
 * a replay will refuse instead of submitting the extraction again.
 */
export async function submitNativeRetainOnce(input: {
  checkpoint: NativeRetainCheckpoint
  requestSha256: string
  reserve: () => Promise<boolean>
  post: () => Promise<string>
  checkpointOperation: (operationId: string) => Promise<void>
  markUncertain: (message: string) => Promise<void>
}): Promise<{ operationId: string; replayed: boolean }> {
  if (input.checkpoint.retainOperationId) {
    if (input.checkpoint.retainRequestSha256 && input.checkpoint.retainRequestSha256 !== input.requestSha256) {
      throw new Error('Retain checkpoint request hash conflicts with the frozen request')
    }
    return { operationId: input.checkpoint.retainOperationId, replayed: true }
  }
  if (['reserved', 'uncertain'].includes(String(input.checkpoint.retainState))) {
    throw new Error('Retain is reserved or uncertain without an operation ID; refusing a duplicate native submit')
  }
  if (!await input.reserve()) throw new Error('Retain reservation was claimed concurrently; refusing a duplicate native submit')
  try {
    const operationId = await input.post()
    if (!operationId) throw new Error('Native retain omitted operation ID')
    await input.checkpointOperation(operationId)
    return { operationId, replayed: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try { await input.markUncertain(message) } catch { /* Preserve the original transport/checkpoint failure. */ }
    throw error
  }
}

export async function startPilotWorkflowOnce(input: {
  reserve: () => Promise<boolean>
  start: () => Promise<string>
  checkpointStarted: (workflowRunId: string) => Promise<void>
  markUncertain: (message: string) => Promise<void>
}): Promise<string> {
  if (!await input.reserve()) throw new Error('Native pilot workflow is already reserved, started, terminal, or not the frozen pilot')
  try {
    const workflowRunId = await input.start()
    await input.checkpointStarted(workflowRunId)
    return workflowRunId
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try { await input.markUncertain(message) } catch { /* Preserve the original start/checkpoint failure. */ }
    throw error
  }
}

export function assertCompletedBridgeCallAudit(calls: { callCount: number; completedCalls: number; failedCalls: number }): void {
  if (calls.callCount < 1 || calls.callCount > 5 || calls.failedCalls !== 0 || calls.completedCalls !== calls.callCount) {
    throw new Error(`Bridge call audit is not terminal-success within budget: calls=${calls.callCount} completed=${calls.completedCalls} failed=${calls.failedCalls}`)
  }
}

const Message = z.object({ id: z.string(), logicalMessageKey: z.string(), observedAt: z.string().datetime(), rawVersionId: z.string(),
  text: z.string().min(1), textSha256: z.string().length(64), media: z.array(z.unknown()) }).passthrough()
const Input = z.object({ runId: z.string().uuid(), label: z.string(), cutoff: z.string().datetime(), pairCount: z.literal(3), messageCount: z.literal(6),
  membershipDigest: z.string().length(64), bankId: z.string(), experimentTag: z.string(), sourceManifestSha256: z.string().length(64),
  conceptCatalog: z.array(z.object({ id: z.string(), title: z.string() })).min(1), nodeStates: z.array(z.object({ conceptId: z.string(), nodeVersion: z.string().length(64), understandingPercent: z.null() })).min(1),
  contracts: z.record(z.string(), z.unknown()), sourceCompleteness: z.record(z.string(), z.unknown()), selection: z.record(z.string(), z.unknown()),
  cases: z.array(z.object({ caseId: z.string(), ordinal: z.number().int(), exchangeId: z.string(), current: Message, response: Message })).length(3),
}).passthrough()

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export async function createHindsightAgyNativePilotRun(inputPath: string) {
  const bytes = await readFile(inputPath)
  const input = Input.parse(JSON.parse(bytes.toString('utf8')))
  const inputSha256 = sha(bytes)
  const caseIds = input.cases.map(item => item.caseId)
  const messageIds = input.cases.flatMap(item => [item.current.id, item.response.id])
  if (new Set(caseIds).size !== 3 || new Set(messageIds).size !== 6) throw new Error('Pilot requires three unique cases and six unique messages')
  for (const item of input.cases) {
    if (sha(item.current.text) !== item.current.textSha256 || sha(item.response.text) !== item.response.textSha256) throw new Error(`Frozen source text drift: ${item.caseId}`)
  }
  const directory = inputPath.slice(0, inputPath.lastIndexOf('/'))
  const reportMarkdown = `# ${input.label}\n\n**Prepared:** ${new Date().toISOString()}  \n**Status:** zero-call preflight ready  \n**Cohort:** 3 pairs · 6 messages through ${input.cutoff}  \n**Membership:** \`${input.membershipDigest}\`\n\nThe pilot is review-only. It uses an isolated Hindsight bank with AGY Gemini 3.7 Flash High, a 420-second per-call deadline, zero retries, and at most three concurrent calls. No learner mastery is written. Raw transcripts remain private.\n\nThe 500-turn gate is not passed; realtime processing remains disabled.\n`
  const config = {
    benchmarkVersion: 8, validity: 'valid', mode: 'prototype-extraction', contextStrategy: HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY,
    experimentLabel: input.label, backend: 'agy', model: 'gemini-3.7-flash', effort: 'high', maxAttempts: 1,
    attemptHardDeadlineMs: 420_000, maxParallelCalls: 3, requestedInputCeilingTokens: 400_000,
    dataset: { label: input.label, cutoff: input.cutoff, pairCount: 3, messageCount: 6, membershipDigest: input.membershipDigest,
      membership: input.cases.map(item => ({ caseId: item.caseId, exchangeId: item.exchangeId, currentId: item.current.id, responseId: item.response.id,
        currentTextSha256: item.current.textSha256, responseTextSha256: item.response.textSha256 })), sourceCompleteness: input.sourceCompleteness,
      selection: input.selection },
    catalog: input.conceptCatalog, nodeStates: input.nodeStates, promptContract: input.contracts,
    privateInputPath: inputPath, inputSha256, sourceManifestSha256: input.sourceManifestSha256,
    preflightPath: `${directory}/preflight-v5-PRIVATE.json`, preflightSha256: 'e1b17e9a4ca22472e788026ac4682523ef6203c2fadfa68c1e55c9393edd99a3', rawOutputPath: `${directory}/native-raw-PRIVATE.json`,
    bankId: input.bankId, experimentTag: input.experimentTag, callAudit: [], masteryWrites: 0,
  }
  await metaDbWithClient(async client => {
    await client.query('BEGIN')
    try {
      const inserted = await client.query(`INSERT INTO learning_extraction_benchmark_runs (run_id,status,sample_size,source_counts,config,summary)
        VALUES ($1,'queued',3,$2::jsonb,$3::jsonb,$4::jsonb) ON CONFLICT (run_id) DO NOTHING RETURNING run_id`, [input.runId,
        JSON.stringify({ canonicalMaterializedMessages: input.sourceCompleteness.materializedMessageCount ?? null, strictEligiblePairs: input.sourceCompleteness.eligibleStrictPairCount ?? null }),
        JSON.stringify(config), JSON.stringify({ reportDate: new Date().toISOString().slice(0, 10), proof: HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY,
          terminalState: 'prepared', pairCount: 3, messageCount: 6, masteryWrites: 0, reportMarkdown, rawTranscriptPublication: 'private-only' })])
      if (inserted.rows.length === 0) {
        const existing = await client.query<{ config: { inputSha256?: string; dataset?: { membershipDigest?: string } }; count: string }>(
          `SELECT config,(SELECT count(*)::text FROM learning_extraction_benchmark_cases WHERE run_id=$1) count FROM learning_extraction_benchmark_runs WHERE run_id=$1 FOR UPDATE`, [input.runId])
        const row = existing.rows[0]
        if (!row || row.config.inputSha256 !== inputSha256 || row.config.dataset?.membershipDigest !== input.membershipDigest || Number(row.count) !== 3) {
          throw new Error('Existing pilot run does not match the frozen input/membership and complete case count')
        }
      }
      for (const item of input.cases) {
        const snapshot = { context: [], current: { id: item.current.id, role: 'user', authorship: 'human', text: item.current.text },
          pairSequence: [{ ...item.current, role: 'user', authorship: 'human' }, { ...item.response, role: 'assistant', authorship: 'agent' }] }
        await client.query(`INSERT INTO learning_extraction_benchmark_cases
          (run_id,case_id,ordinal,provider,agent,thread_id,turn_id,occurred_at,input_hash,input_snapshot,status)
          VALUES ($1,$2,$3,'canonical','mixed',$4,$4,$5,$6,$7::jsonb,'pending') ON CONFLICT (run_id,case_id) DO NOTHING`,
        [input.runId, item.caseId, item.ordinal, item.exchangeId, item.current.observedAt, sha(`${item.current.textSha256}\n${item.response.textSha256}`), JSON.stringify(snapshot)])
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
  })
  return { runId: input.runId, inputSha256, pairCount: 3, messageCount: 6, membershipDigest: input.membershipDigest }
}
