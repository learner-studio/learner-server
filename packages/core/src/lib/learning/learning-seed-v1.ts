import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

import { COMPUTER_SCIENCE } from '../../functions/learning/computer-science-seed.js'
import { metaDbQuery, metaDbWithClient } from '../db-metadata/_shared.js'
import { CLASSIFIER_V6_CATALOG, CLASSIFIER_V6_CATALOG_HASH } from './learning-classifier-v6.js'
import type { BenchmarkCaseSnapshot } from './learning-extraction-benchmark.js'
import {
  SEED_V1_CONTEXT_STRATEGY,
  SEED_V1_EFFECTIVE_CONTEXT_TOKENS,
  SEED_V1_EXPERIMENT_LABEL,
  THREE_TURN_MAX_BATCH_TOKENS,
  THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
  type SeedV1PairSequence,
  type ThreeTurnSequenceMessage,
} from './learning-three-turn-context.js'

export const SEED_V1_LABEL = 'seed V1' as const
export const SEED_V1_VERSION = 1 as const
export const SEED_V1_TAGS = ['seed-v1', 'immutable-membership', 'operator-pairs'] as const
export const SEED_V1_PAIR_COUNT = 100 as const
export const SEED_V1_MESSAGE_COUNT = 200 as const
export const SEED_V1_HINDSIGHT_BANK = 'learning-transcript-archive-v1' as const
export const SEED_V1_HINDSIGHT_URL = 'http://127.0.0.1:18925' as const

type DocumentListItem = {
  id: string
  content_hash: string
  created_at: string
  retain_params?: { event_date?: string; metadata?: Record<string, string | null> }
  document_metadata?: Record<string, string | null>
}

export type SeedV1ArchivedTurn = {
  schemaVersion: 1
  provider: 'openai' | 'anthropic' | 'google'
  location: 'local'
  source: { path: string; kind: 'jsonl' | 'sqlite'; device: number; inode: number; generation: number; offset: number }
  thread: { nativeId: string }
  message: {
    nativeId: string | null
    exchangeNativeId: string | null
    role: 'user' | 'assistant'
    authorship: 'human' | 'agent' | 'system' | 'unknown'
    authorshipEvidence: string
    timestamp: string | null
    order: number
    model: string | null
    cwd: string | null
    text: string
    contentHash: string
  }
}

export type IndexedSeedV1Turn = { documentId: string; envelopeHash: string; archivedAt: string; turn: SeedV1ArchivedTurn }
type FrozenPair = { user: IndexedSeedV1Turn; assistant: IndexedSeedV1Turn }

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const turnKey = (item: IndexedSeedV1Turn): string => [item.turn.message.timestamp, item.turn.message.order, item.documentId].join('\0')
const nativeDedupKey = (item: IndexedSeedV1Turn): string => [
  item.turn.provider,
  item.turn.thread.nativeId,
  item.turn.message.nativeId ?? `${item.turn.source.path}:${item.turn.source.offset}`,
  item.turn.message.contentHash,
].join('\0')

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Hindsight read failed ${response.status} for ${url}`)
  return await response.json() as T
}

async function readCanonicalArchive(cutoff: string): Promise<{ total: number; turns: IndexedSeedV1Turn[] }> {
  const root = `${SEED_V1_HINDSIGHT_URL}/v1/default/banks/${SEED_V1_HINDSIGHT_BANK}`
  const listing = await fetchJson<{ total: number; items: DocumentListItem[] }>(`${root}/documents?limit=10000&offset=0`)
  const eligibleDocuments = listing.items.filter((item) => item.created_at <= cutoff && item.id.startsWith('cli-turn-v1-'))
  const turns: IndexedSeedV1Turn[] = []
  for (let offset = 0; offset < eligibleDocuments.length; offset += 24) {
    const details = await Promise.all(eligibleDocuments.slice(offset, offset + 24).map(async (item) => {
      const detail = await fetchJson<{ original_text: string }>(`${root}/documents/${encodeURIComponent(item.id)}`)
      const turn = JSON.parse(detail.original_text) as SeedV1ArchivedTurn
      return { documentId: item.id, envelopeHash: item.content_hash, archivedAt: item.created_at, turn }
    }))
    turns.push(...details)
  }
  return { total: listing.total, turns }
}

export function selectSeedV1Pairs(turns: IndexedSeedV1Turn[]): { pairs: FrozenPair[]; incompleteHumanTargets: number; deduplicatedTurns: number } {
  const deduplicated = new Map<string, IndexedSeedV1Turn>()
  for (const item of [...turns].sort((a, b) => turnKey(a).localeCompare(turnKey(b)))) deduplicated.set(nativeDedupKey(item), item)
  const byThread = new Map<string, IndexedSeedV1Turn[]>()
  for (const item of deduplicated.values()) {
    const key = `${item.turn.provider}\0${item.turn.thread.nativeId}`
    const values = byThread.get(key) ?? []
    values.push(item)
    byThread.set(key, values)
  }
  const complete: FrozenPair[] = []
  let incompleteHumanTargets = 0
  for (const thread of byThread.values()) {
    const ordered = thread.sort((a, b) => turnKey(a).localeCompare(turnKey(b)))
    const userIndexes = ordered.flatMap((item, index) => item.turn.message.role === 'user' ? [index] : [])
    userIndexes.forEach((userIndex, boundaryIndex) => {
      const user = ordered[userIndex]!
      if (user.turn.message.authorship !== 'human') return
      const nextUserIndex = userIndexes[boundaryIndex + 1] ?? ordered.length
      const assistant = ordered.slice(userIndex + 1, nextUserIndex).filter((item) => item.turn.message.role === 'assistant').at(-1)
      if (!assistant) { incompleteHumanTargets += 1; return }
      complete.push({ user, assistant })
    })
  }
  const pairs = complete.sort((a, b) => turnKey(b.user).localeCompare(turnKey(a.user))).slice(0, SEED_V1_PAIR_COUNT).reverse()
  if (pairs.length !== SEED_V1_PAIR_COUNT) throw new Error(`Seed V1 requires 100 complete verified-human pairs; found ${pairs.length}`)
  if (new Set(pairs.map(({ user }) => user.documentId)).size !== 100 || new Set(pairs.map(({ assistant }) => assistant.documentId)).size !== 100) {
    throw new Error('Seed V1 requires 100 distinct user targets and 100 distinct assistant responses')
  }
  return { pairs, incompleteHumanTargets, deduplicatedTurns: deduplicated.size }
}

const sequenceMessage = (item: IndexedSeedV1Turn, sequenceNumber: number): ThreeTurnSequenceMessage => {
  const { turn } = item
  if (!turn.message.timestamp) throw new Error(`Archived message ${item.documentId} has no original timestamp`)
  return {
    id: turn.message.nativeId ?? item.documentId,
    threadId: turn.thread.nativeId,
    exchangeId: turn.message.exchangeNativeId ?? item.documentId,
    sourceRecordId: item.documentId,
    sourceOrder: turn.message.order,
    agent: turn.provider === 'anthropic' ? 'Claude' : turn.provider === 'google' ? 'Gemini' : 'Codex',
    provider: turn.provider,
    location: turn.location,
    role: turn.message.role,
    authorship: turn.message.authorship,
    authorshipEvidence: turn.message.authorshipEvidence,
    text: turn.message.text,
    timestamp: turn.message.timestamp,
    model: turn.message.model,
    cwd: turn.message.cwd,
    sequenceNumber,
    section: 'target',
    contextRelation: 'target',
  }
}

export async function freezeSeedV1Dataset(runId: string): Promise<Record<string, unknown>> {
  const prior = await metaDbQuery<{ count: string }>('SELECT count(*)::text count FROM learning_extraction_benchmark_cases WHERE run_id=$1', [runId])
  if (Number(prior.rows[0]?.count ?? 0) === SEED_V1_PAIR_COUNT) {
    const existing = await metaDbQuery<{ config: Record<string, unknown> }>('SELECT config FROM learning_extraction_benchmark_runs WHERE run_id=$1', [runId])
    return existing.rows[0]?.config.dataset as Record<string, unknown>
  }
  const cutoff = new Date().toISOString()
  const archive = await readCanonicalArchive(cutoff)
  const selection = selectSeedV1Pairs(archive.turns)
  const snapshots = selection.pairs.map(({ user, assistant }) => {
    const userMessage = sequenceMessage(user, 1)
    const assistantMessage = sequenceMessage(assistant, 2)
    const sequence: SeedV1PairSequence = { strategy: SEED_V1_CONTEXT_STRATEGY, messages: [userMessage, assistantMessage] }
    const current: BenchmarkCaseSnapshot['current'] = {
      id: userMessage.id, threadId: userMessage.threadId, exchangeId: userMessage.exchangeId,
      agent: userMessage.agent, provider: userMessage.provider, role: userMessage.role,
      authorship: userMessage.authorship, authorshipEvidence: userMessage.authorshipEvidence,
      text: userMessage.text, timestamp: userMessage.timestamp, model: userMessage.model, cwd: userMessage.cwd,
    }
    return {
      current,
      context: [],
      contextCompleteness: { assistantTurns: 'missing' as const, toolOutput: 'unavailable' as const, taskOutcome: 'unavailable' as const, receiptContext: 'unavailable' as const },
      ontologyCandidateIds: CLASSIFIER_V6_CATALOG.map(({ id }) => id),
      seedV1PairSequence: sequence,
    } satisfies BenchmarkCaseSnapshot
  })
  const membership = selection.pairs.map(({ user, assistant }) => ({
    userDocumentId: user.documentId, userEnvelopeHash: user.envelopeHash, userContentHash: user.turn.message.contentHash,
    assistantDocumentId: assistant.documentId, assistantEnvelopeHash: assistant.envelopeHash, assistantContentHash: assistant.turn.message.contentHash,
  }))
  const sourceBytes = selection.pairs.reduce((sum, pair) => sum + Buffer.byteLength(pair.user.turn.message.text) + Buffer.byteLength(pair.assistant.turn.message.text), 0)
  const dataset = {
    label: SEED_V1_LABEL, version: SEED_V1_VERSION, tags: SEED_V1_TAGS, immutable: true,
    cutoff, source: { url: SEED_V1_HINDSIGHT_URL, bank: SEED_V1_HINDSIGHT_BANK, documentsAtRead: archive.total },
    admission: 'latest-100-complete-verified-human-user-to-final-same-thread-assistant-before-next-user-boundary-v1',
    deduplication: 'provider+threadNativeId+messageNativeIdOrSourceIdentity+contentHash',
    ordering: 'chronological-by-original-human-target-timestamp-then-native-order',
    pairCount: snapshots.length, messageCount: snapshots.length * 2, sourceBytes,
    targetSpan: { first: snapshots[0]!.current.timestamp, last: snapshots.at(-1)!.current.timestamp },
    threads: new Set(snapshots.map(({ current }) => `${current.provider}:${current.threadId}`)).size,
    providers: Object.fromEntries([...new Set(snapshots.map(({ current }) => current.provider))].map((provider) => [provider, snapshots.filter(({ current }) => current.provider === provider).length])),
    incompleteHumanTargetsExcluded: selection.incompleteHumanTargets,
    deduplicatedArchiveTurns: selection.deduplicatedTurns,
    membershipDigest: sha(membership), membership,
  }
  await metaDbWithClient(async (client) => {
    await client.query('BEGIN')
    try {
      for (const [ordinal, snapshot] of snapshots.entries()) {
        const caseId = sha([SEED_V1_LABEL, snapshot.current.provider, snapshot.current.threadId, snapshot.current.id]).slice(0, 24)
        await client.query(
          `INSERT INTO learning_extraction_benchmark_cases
           (run_id,case_id,ordinal,provider,agent,thread_id,turn_id,occurred_at,input_hash,input_snapshot,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'pending') ON CONFLICT (run_id,case_id) DO NOTHING`,
          [runId, caseId, ordinal, snapshot.current.provider, snapshot.current.agent, snapshot.current.threadId, snapshot.current.id, snapshot.current.timestamp, sha(snapshot), JSON.stringify(snapshot)],
        )
      }
      await client.query(
        `UPDATE learning_extraction_benchmark_runs
         SET status='queued',source_counts=$2::jsonb,config=config || jsonb_build_object('dataset',$3::jsonb)
         WHERE run_id=$1 AND status='queued'`,
        [runId, JSON.stringify(dataset.providers), JSON.stringify(dataset)],
      )
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
  })
  return dataset
}

export async function createSeedV1Run(): Promise<string> {
  const runId = randomUUID()
  const config = {
    benchmarkVersion: 6, mode: 'prototype-extraction', validity: 'valid',
    experimentLabel: SEED_V1_EXPERIMENT_LABEL, protocolVersion: 1,
    datasetLabel: SEED_V1_LABEL, datasetVersion: SEED_V1_VERSION, tags: SEED_V1_TAGS,
    contextStrategy: SEED_V1_CONTEXT_STRATEGY, classifiedMessage: 'human/operator target only', messagesPerSequence: 2,
    model: 'gpt-5.6-luna', backend: 'codex', effort: 'high', models: [{ model: 'gpt-5.6-luna', effort: 'high', arm: 'biztools' }, { model: 'hindsight:gpt-5.6-luna', effort: 'high', arm: 'hindsight-custom' }],
    maxBatchTokens: THREE_TURN_MAX_BATCH_TOKENS, maxAttempts: 1,
    activeContextTokens: SEED_V1_EFFECTIVE_CONTEXT_TOKENS, nativeSchemaReserveTokens: THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
    effectiveBatchByteCeiling: 1_000_000,
    catalog: CLASSIFIER_V6_CATALOG, catalogHash: CLASSIFIER_V6_CATALOG_HASH,
    ontologyId: COMPUTER_SCIENCE.curriculum.id, ontologyRetrieval: { strategy: 'full-flat-catalog-v6', totalConcepts: CLASSIFIER_V6_CATALOG.length },
    classifierPromptRevision: 6, extractorPromptVersion: 6, outputFormat: 'native-json-schema', outputSchemaRevision: 1,
    attemptHardDeadlineMs: 420_000, samplingStrategy: 'canonical-hindsight-archive-latest-complete-operator-pairs-v1',
    corpusAdmission: 'verified-human-user-plus-final-assistant-before-next-user-boundary', masteryPromotions: 0,
  }
  await metaDbQuery(
    `INSERT INTO learning_extraction_benchmark_runs (run_id,status,sample_size,config) VALUES ($1,'queued',$2,$3::jsonb)`,
    [runId, SEED_V1_PAIR_COUNT, JSON.stringify(config)],
  )
  return runId
}

export async function createSeedV1HindsightRerun(sourceRunId: string, requestedRunId: string = randomUUID()): Promise<string> {
  const source = (await metaDbQuery<{ sample_size: number; source_counts: unknown; config: Record<string, unknown> }>(
    'SELECT sample_size,source_counts,config FROM learning_extraction_benchmark_runs WHERE run_id=$1', [sourceRunId],
  )).rows[0]
  const dataset = source?.config.dataset as { immutable?: boolean; pairCount?: number; messageCount?: number; membershipDigest?: string } | undefined
  if (!source || source.sample_size !== 100 || dataset?.immutable !== true || dataset.pairCount !== 100 || dataset.messageCount !== 200 || !dataset.membershipDigest) {
    throw new Error('Hindsight rerun source is not the immutable Seed V1 100-pair/200-message dataset')
  }
  const manifestPath = String(source.config.privateManifestPath ?? '')
  if (!manifestPath) throw new Error('Hindsight rerun source has no private manifest')
  const privateDirectory = `/var/lib/biztools/learning-experiments/seed-v1-hindsight-rerun-${requestedRunId}`
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 })
  const config = { ...source.config, experimentLabel: 'seed V1 Hindsight-only Luna high rerun · 420s',
    models: [{ model: 'hindsight:gpt-5.6-luna', effort: 'high', arm: 'hindsight-custom-rerun' }],
    hindsightOnly: true, rerunOf: sourceRunId, privateManifestPath: manifestPath,
    hindsightOutputPath: `${privateDirectory}/hindsight-raw-PRIVATE.json`, hindsightModelDeadlineSeconds: 420,
    attemptHardDeadlineMs: 420_000, maxAttempts: 1, attemptAudit: [], hindsightAudit: [], postRunAudit: null }
  await metaDbWithClient(async (client) => {
    await client.query('BEGIN')
    try {
      await client.query(`INSERT INTO learning_extraction_benchmark_runs (run_id,status,sample_size,source_counts,config)
        VALUES ($1,'queued',100,$2::jsonb,$3::jsonb)`, [requestedRunId, JSON.stringify(source.source_counts), JSON.stringify(config)])
      await client.query(`INSERT INTO learning_extraction_benchmark_cases
        (run_id,case_id,ordinal,provider,agent,thread_id,turn_id,occurred_at,input_hash,input_snapshot,status)
        SELECT $1,case_id,ordinal,provider,agent,thread_id,turn_id,occurred_at,input_hash,input_snapshot,'pending'
        FROM learning_extraction_benchmark_cases WHERE run_id=$2 ORDER BY ordinal`, [requestedRunId, sourceRunId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
  })
  return requestedRunId
}

type FrozenDataset = {
  immutable?: boolean
  label?: string
  version?: number
  pairCount?: number
  messageCount?: number
  membershipDigest?: string
  tags?: string[]
}
