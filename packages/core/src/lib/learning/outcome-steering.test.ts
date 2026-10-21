import { describe, expect, test } from 'bun:test'

import {
  CanonicalEpisodeInputSchema,
  OUTCOME_STEERING_DIMENSIONS,
  canonicalizeEpisode,
  parseOutcomeSteeringJudgment,
} from './outcome-steering.js'

const completeEpisode = () => CanonicalEpisodeInputSchema.parse({
  sourceEpisodeKey: 'receipt-task:r7',
  declaredOutcome: 'Ship a replay-safe Learning evaluator with tests.',
  status: 'completed',
  startedAt: '2026-09-04T12:00:00.000Z',
  endedAt: '2026-09-04T12:30:00.000Z',
  domains: ['software-engineering', 'learning-science'],
  turns: [
    {
      refId: 'turn:user:1', provider: 'openai', threadId: 'thread-1', turnId: '1',
      role: 'user', text: 'Keep one shared episode parent and prove replay safety.',
      occurredAt: '2026-09-04T12:00:00.000Z', domain: 'software-engineering',
    },
    {
      refId: 'turn:assistant:2', provider: 'openai', threadId: 'thread-1', turnId: '2',
      role: 'assistant', text: 'Implemented the workflow and ran its focused tests.',
      occurredAt: '2026-09-04T12:25:00.000Z', domain: 'software-engineering',
    },
  ],
  tasks: [{
    refId: 'task:r7', taskId: 'r7', parentTaskId: null, title: 'Outcome steering',
    status: 'completed', outcome: 'Implementation and tests passed', agentRuntime: 'codex',
  }],
  receipts: [{
    refId: 'receipt:r7:tests', receiptId: 'r7-tests', status: 'passed',
    claim: 'focused tests', detail: '12 tests passed', createdAt: '2026-09-04T12:29:00.000Z',
  }],
})

const judgedProfile = () => ({
  evaluatorVersion: 'outcome-steering-v1',
  overallStatus: 'judged',
  summary: 'The episode contains grounded steering evidence.',
  limitations: [],
  dimensions: OUTCOME_STEERING_DIMENSIONS.map((dimension) => ({
    dimension,
    status: 'judged',
    estimate: 0.7,
    confidence: 0.8,
    rationale: 'The instruction and verified result support this observation.',
    evidenceRefs: ['turn:user:1', 'receipt:r7:tests'],
    observedDomains: dimension === 'cross_domain_transfer'
      ? ['software-engineering', 'learning-science']
      : ['software-engineering'],
  })),
})

describe('canonical outcome-steering episode contract', () => {
  test('normalizes source order and creates a stable artifact identity', () => {
    const first = canonicalizeEpisode(completeEpisode())
    const reversed = completeEpisode()
    reversed.turns.reverse()
    reversed.receipts.reverse()
    const second = canonicalizeEpisode(reversed)
    expect(second.artifactId).toBe(first.artifactId)
    expect(second.sourceFingerprint).toBe(first.sourceFingerprint)
    expect(second.turns.map((turn) => turn.refId)).toEqual(['turn:user:1', 'turn:assistant:2'])
  })

  test('rejects duplicate evidence reference identities', () => {
    const episode = completeEpisode()
    episode.tasks[0]!.refId = 'turn:user:1'
    expect(() => canonicalizeEpisode(episode)).toThrow(/Duplicate episode evidence refId/)
  })
})

describe('outcome-steering LLM judgment parser', () => {
  test('accepts a dimension profile without manufacturing a global score', () => {
    const parsed = parseOutcomeSteeringJudgment(judgedProfile(), canonicalizeEpisode(completeEpisode()))
    expect(parsed.dimensions).toHaveLength(OUTCOME_STEERING_DIMENSIONS.length)
    expect('score' in parsed).toBe(false)
  })

  test('rejects an ungrounded or missing evidence reference', () => {
    const profile = judgedProfile()
    profile.dimensions[0]!.evidenceRefs = ['turn:invented']
    expect(() => parseOutcomeSteeringJudgment(profile, canonicalizeEpisode(completeEpisode())))
      .toThrow(/unknown evidence reference/)
  })

  test('requires abstention when actual outcome evidence is insufficient', () => {
    const episode = completeEpisode()
    episode.status = 'indeterminate'
    episode.endedAt = null
    episode.tasks = []
    episode.receipts = []
    const profile = judgedProfile()
    expect(() => parseOutcomeSteeringJudgment(profile, canonicalizeEpisode(episode)))
      .toThrow(/must abstain/)
  })

  test('does not permit a premature cross-domain transfer claim', () => {
    const episode = completeEpisode()
    episode.domains = ['software-engineering']
    const profile = judgedProfile()
    const transfer = profile.dimensions.find((item) => item.dimension === 'cross_domain_transfer')!
    transfer.observedDomains = ['software-engineering']
    expect(() => parseOutcomeSteeringJudgment(profile, canonicalizeEpisode(episode)))
      .toThrow(/cross-domain transfer/)
  })
})
