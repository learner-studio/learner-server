import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import {
  CanonicalEpisodeInputSchema,
  DEFAULT_OUTCOME_EVALUATOR_CONFIG,
  OUTCOME_STEERING_DIMENSIONS,
  type CanonicalEpisodeArtifact,
  type OutcomeSteeringJudgment,
} from '@learner/core/lib/learning/outcome-steering.js'
import type { OutcomeEvaluationRecord } from '@learner/core/services/learning-episode-store.js'
import {
  persistCanonicalLearningEpisode,
  runOutcomeSteeringEvaluation,
} from './episode-analysis-steps.function.js'

const episodeInput = (sufficient = true) => CanonicalEpisodeInputSchema.parse({
  sourceEpisodeKey: sufficient ? 'fixture:completed' : 'fixture:indeterminate',
  declaredOutcome: 'Implement and verify a durable evaluator.',
  status: sufficient ? 'completed' : 'indeterminate',
  startedAt: '2026-09-04T12:00:00.000Z',
  endedAt: sufficient ? '2026-09-04T12:20:00.000Z' : null,
  domains: ['software-engineering'],
  turns: [{
    refId: 'turn:user:1', provider: 'openai', threadId: 'thread-1', turnId: '1', role: 'user',
    text: 'Implement it, keep one parent, and run the tests.', occurredAt: '2026-09-04T12:00:00.000Z',
    domain: 'software-engineering',
  }],
  tasks: sufficient ? [{
    refId: 'task:1', taskId: '1', title: 'Evaluator', status: 'completed', outcome: 'Tests passed',
  }] : [],
  receipts: sufficient ? [{
    refId: 'receipt:1', receiptId: '1', status: 'passed', claim: 'focused tests', detail: 'green',
    createdAt: '2026-09-04T12:19:00.000Z',
  }] : [],
})

const profile = (abstained = false): OutcomeSteeringJudgment => ({
  evaluatorVersion: 'outcome-steering-v1',
  overallStatus: abstained ? 'abstained' : 'judged',
  summary: abstained ? 'The actual outcome is unknown.' : 'The request and receipt provide evidence.',
  limitations: abstained ? ['No terminal task or receipt exists.'] : [],
  dimensions: OUTCOME_STEERING_DIMENSIONS.map((dimension) => ({
    dimension,
    status: abstained || dimension === 'cross_domain_transfer' ? 'abstained' : 'judged',
    estimate: abstained || dimension === 'cross_domain_transfer' ? null : 0.7,
    confidence: abstained ? 0.9 : 0.75,
    rationale: abstained || dimension === 'cross_domain_transfer'
      ? 'Available evidence is insufficient for this dimension.'
      : 'The user instruction and test receipt support the observation.',
    evidenceRefs: abstained || dimension === 'cross_domain_transfer' ? [] : ['turn:user:1', 'receipt:1'],
    observedDomains: abstained || dimension === 'cross_domain_transfer' ? [] : ['software-engineering'],
  })),
})

function memoryHarness() {
  const artifacts = new Map<string, CanonicalEpisodeArtifact>()
  const evaluations = new Map<string, OutcomeEvaluationRecord>()
  const requests: Record<string, unknown>[] = []
  let llmCalls = 0
  const evaluationId = '00000000-0000-5000-8000-000000000001'
  const store = {
    upsertCanonicalArtifact: async (artifact: CanonicalEpisodeArtifact) => {
      const existing = artifacts.get(artifact.sourceFingerprint)
      if (existing) return existing
      artifacts.set(artifact.sourceFingerprint, artifact)
      return artifact
    },
    markArtifact: async () => undefined,
    getArtifact: async (artifactId: string) => [...artifacts.values()].find((item) => item.artifactId === artifactId),
    claimEvaluation: async (artifact: CanonicalEpisodeArtifact) => {
      const existing = evaluations.get(artifact.artifactId)
      return existing
        ? { evaluationId, claimToken: null, shouldEvaluate: false, existing }
        : { evaluationId, claimToken: '00000000-0000-5000-8000-000000000002', shouldEvaluate: true, existing: null }
    },
    completeEvaluation: async (_id: string, _token: string, judgment: OutcomeSteeringJudgment) => {
      const artifact = [...artifacts.values()][0]!
      const record: OutcomeEvaluationRecord = {
        evaluationId, artifactId: artifact.artifactId, evaluatorVersion: judgment.evaluatorVersion,
        backend: DEFAULT_OUTCOME_EVALUATOR_CONFIG.backend, model: DEFAULT_OUTCOME_EVALUATOR_CONFIG.model,
        effort: DEFAULT_OUTCOME_EVALUATOR_CONFIG.effort,
        status: judgment.overallStatus === 'abstained' ? 'abstained' : 'completed',
        judgment, error: null, startedAt: artifact.startedAt, completedAt: artifact.endedAt,
      }
      evaluations.set(artifact.artifactId, record)
      return record
    },
    failEvaluation: async () => undefined,
  }
  const llm = {
    callLLMWithStructuredOutput: async (request: Record<string, unknown>) => {
      llmCalls += 1
      requests.push(request)
      if (!('parseFn' in request) || typeof request.parseFn !== 'function') throw new Error('parseFn required')
      const artifact = [...artifacts.values()][0]!
      return request.parseFn(profile(!artifact.outcomeEvidenceSufficient))
    },
  }
  return { artifacts, evaluations, requests, store, llm, llmCalls: () => llmCalls }
}

describe('canonical episode persistence', () => {
  test('is idempotent when the parent step replays', async () => {
    const harness = memoryHarness()
    const first = await persistCanonicalLearningEpisode(harness.store, episodeInput())
    const second = await persistCanonicalLearningEpisode(harness.store, episodeInput())
    expect(second.artifactId).toBe(first.artifactId)
    expect(harness.artifacts.size).toBe(1)
  })
})

describe('outcome-steering sibling evaluation', () => {
  test('replay reuses the stored judgment and does not call the LLM twice', async () => {
    const harness = memoryHarness()
    const artifact = await persistCanonicalLearningEpisode(harness.store, episodeInput())
    const input = { artifactId: artifact.artifactId, sourceFingerprint: artifact.sourceFingerprint, evaluator: DEFAULT_OUTCOME_EVALUATOR_CONFIG }
    const first = await runOutcomeSteeringEvaluation(harness.store, harness.llm, input)
    const replay = await runOutcomeSteeringEvaluation(harness.store, harness.llm, input)
    expect(first.status).toBe('completed')
    expect(replay.reused).toBe(true)
    expect(harness.llmCalls()).toBe(1)
    expect(harness.requests[0]).toMatchObject({
      callOptions: {
        backend: DEFAULT_OUTCOME_EVALUATOR_CONFIG.backend,
        model: DEFAULT_OUTCOME_EVALUATOR_CONFIG.model,
        effort: DEFAULT_OUTCOME_EVALUATOR_CONFIG.effort,
        timeout: 240,
      },
    })
  })

  test('insufficient actual-outcome evidence produces an LLM-authored abstention', async () => {
    const harness = memoryHarness()
    const artifact = await persistCanonicalLearningEpisode(harness.store, episodeInput(false))
    const result = await runOutcomeSteeringEvaluation(harness.store, harness.llm, {
      artifactId: artifact.artifactId,
      sourceFingerprint: artifact.sourceFingerprint,
      evaluator: DEFAULT_OUTCOME_EVALUATOR_CONFIG,
    })
    expect(harness.llmCalls()).toBe(1)
    expect(result.status).toBe('abstained')
    expect(result.judgment?.dimensions.every((item) => item.status === 'abstained')).toBe(true)
  })
})

describe('episode analysis workflow topology', () => {
  test('builds one canonical artifact then passes it to both sibling branches', () => {
    const source = readFileSync(new URL('./episode-analysis.workflow.ts', import.meta.url), 'utf8')
    expect(source.match(/'canonicalizeLearningEpisodeStep'/g)).toHaveLength(1)
    expect(source.match(/sourceFingerprint: canonical\.sourceFingerprint/g)).toHaveLength(2)
    expect(source).toContain("'curriculumLearningEpisodeHandoffStep'")
    expect(source).toContain("'evaluateOutcomeSteeringStep'")
    expect(source).toContain("{ retries: 2, retryDelay: '5s' }")
    expect(source).not.toMatch(/'readConversation|'groupEpisode|'loadTranscript/i)
  })
})
