import { z } from 'zod'

/**
 * Wire shapes for the Learning admin pages in the web app (the Osmosis graph,
 * curriculum builder, conversation history and playground). Each mirrors the
 * server function's own schema by hand; the server is never imported.
 *
 * Outputs are `looseObject` so a field the server adds later passes through
 * instead of failing validation, and they name only the fields the pages read.
 */

export const LearningMasteryLevel = z.enum(['unknown', 'exposed', 'partially-understood', 'operational', 'well-understood', 'uncertain'])
export const LlmBackend = z.enum(['codex', 'claude', 'agy'])
export const CliEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

const Mastery = z.looseObject({
  level: LearningMasteryLevel, score: z.number(), confidence: z.number(),
  interval: z.looseObject({ low: z.number(), high: z.number() }),
  firstExposureAt: z.string().nullable(), lastRetrievalAt: z.string().nullable(),
  lastSuccessfulRetrievalAt: z.string().nullable(), nextReviewAt: z.string().nullable(),
  evidenceCount: z.number(), strongEvidenceCount: z.number(),
})

export const GradualAssessmentProposal = z.looseObject({
  conceptId: z.string(),
  understandingPercent: z.number().nullable(),
  confidence: z.enum(['insufficient', 'low', 'medium', 'high']),
  demonstrated: z.array(z.looseObject({ description: z.string(), sourceId: z.string(), quote: z.string() })),
  gaps: z.array(z.looseObject({ kind: z.string(), description: z.string(), sourceId: z.string().nullable(), quote: z.string().nullable() })),
  nextCheck: z.string(),
})

export const LearningConceptAssessment = z.looseObject({
  conceptId: z.string(), assessment: GradualAssessmentProposal.nullable(), runId: z.string().nullable(),
  status: z.enum(['unknown', 'pending', 'ready', 'stale']), assessedAt: z.string().nullable(),
})

const RunPart = z.looseObject({ part: z.number(), runId: z.string() })

export const VectorExperiment = z.looseObject({
  runId: z.string(), label: z.string(), status: z.string(), createdAt: z.string(), finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(), unknownUsageCalls: z.number(),
  config: z.record(z.string(), z.unknown()), metadata: z.record(z.string(), z.unknown()).nullable(),
  counts: z.looseObject({ messages: z.number(), chunks: z.number(), turns: z.number(), unpaired: z.number() }).nullable(),
  pending: z.number(), failed: z.number(), inputTokens: z.number(), outputTokens: z.number(),
  items: z.array(z.looseObject({
    conceptId: z.string(), title: z.string(), status: z.string(),
    matchingChunks: z.number(), matchingTurns: z.number(), turns: z.number(), batches: z.number(), exhaustive: z.boolean(),
    runs: z.array(RunPart),
  })),
})

const LearningLane = z.looseObject({ id: z.string(), title: z.string(), summary: z.string(), order: z.number(), color: z.string() })
const LearningModule = z.looseObject({
  id: z.string(), step: z.number(), title: z.string(), summary: z.string(), laneId: z.string(),
  conceptIds: z.array(z.string()), parentId: z.string().nullable(), dependsOnModuleIds: z.array(z.string()), masteryGoals: z.array(z.string()),
})
const CurriculumStatus = z.enum(['seed', 'draft', 'approved'])
export const CurriculumRollup = z.looseObject({
  estimate: z.number().nullable(), known: z.number(), unknown: z.number(), required: z.number(), coverage: z.number(), complete: z.boolean(),
})

export const GetLearningGraphInput = z.object({
  curriculumId: z.string().min(1).optional(), datasetTag: z.string().optional(),
  /** A deep link's concept (`?conceptId=`): with no curriculumId, the server opens a visible curriculum that contains it. */
  conceptId: z.string().min(1).optional(),
})
export const LearningGraph = z.looseObject({
  curriculum: z.looseObject({
    id: z.string(), title: z.string(), description: z.string(), status: CurriculumStatus, domain: z.string(),
    lanes: z.array(LearningLane), modules: z.array(LearningModule),
  }),
  availableCurriculums: z.array(z.looseObject({ id: z.string(), title: z.string(), description: z.string(), status: CurriculumStatus })),
  selectedCurriculumId: z.string(),
  concepts: z.array(z.looseObject({
    id: z.string(), title: z.string(), summary: z.string(), explanation: z.string(), example: z.string(),
    domain: z.string(), capability: z.string(), x: z.number(), y: z.number(),
    mastery: Mastery, assessment: LearningConceptAssessment.optional(),
  })),
  edges: z.array(z.looseObject({ from: z.string(), to: z.string(), kind: z.enum(['hard-prerequisite', 'related']), confidence: z.number() })),
  vectorExperiment: VectorExperiment.optional(),
  rollups: z.looseObject({
    curriculum: CurriculumRollup,
    lanes: z.record(z.string(), CurriculumRollup),
    modules: z.record(z.string(), CurriculumRollup),
  }),
})

const Provider = z.enum(['google', 'anthropic', 'openai'])
const Location = z.enum(['local', 'remote'])
export const GetConversationHistoryInput = z.object({
  limit: z.union([z.number().int().min(1).max(200), z.string().regex(/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/)]).optional(),
  conceptId: z.string().min(1).optional(),
})
export const ConversationHistory = z.looseObject({
  limit: z.number(), totalTurns: z.number(),
  threads: z.array(z.looseObject({
    id: z.string(), title: z.string(), agent: z.string(), provider: Provider, location: Location,
    latestAt: z.string(), models: z.array(z.string()), workspacePath: z.string().nullable(), folderSegments: z.array(z.string()),
    turns: z.array(z.looseObject({
      id: z.string(), exchangeId: z.string(), role: z.enum(['user', 'assistant']), authorship: z.enum(['human', 'agent', 'system', 'unknown']),
      authorshipEvidence: z.string(), text: z.string(), timestamp: z.string(), model: z.string().nullable(), cwd: z.string().nullable(),
    })),
  })),
  sources: z.array(z.looseObject({ provider: Provider, location: Location, available: z.boolean(), files: z.number(), error: z.string().nullable() })),
})

export const ReactiveStatus = z.looseObject({ enabled: z.boolean(), assessmentEnabled: z.boolean(), pendingMessages: z.number() })

export const ModelCatalog = z.looseObject({
  probedAt: z.string(),
  models: z.array(z.looseObject({
    backend: LlmBackend, id: z.string(), label: z.string(), notes: z.string().nullable(), defaultEffort: CliEffort, unavailable: z.boolean(),
    efforts: z.array(z.looseObject({ effort: CliEffort, reason: z.string().nullable(), selectable: z.boolean() })),
  })),
})
/** The CLIs the Learning extractor may run on. AGY is in the model catalogue for other uses but is not
 * offered, saved or loaded as the extractor. */
export const ExtractorBackend = z.enum(['codex', 'claude'])
export const ExtractorSelection = z.object({ backend: ExtractorBackend, model: z.string().min(1), effort: CliEffort })
export const ExtractorConfig = z.looseObject({ backend: ExtractorBackend, model: z.string(), effort: CliEffort, updatedAt: z.string().nullable() })

export const StartVectorExperiment = z.object({
  purpose: z.enum(['experiment', 'live']).optional(), selection: z.enum(['all', 'latest', 'relevant']).optional(),
  latestTurns: z.number().int().min(1).max(100000).optional(), threshold: z.number().min(0).max(1).optional(),
  maxInputTokens: z.number().int().min(10000).max(400000).optional(), concurrency: z.number().int().min(1).max(9).optional(),
  incremental: z.boolean().optional(), requestId: z.string().uuid().optional(),
})

export const LearningAssessmentRun = z.looseObject({
  runId: z.string(), conceptId: z.string(), status: z.string(), createdAt: z.string(),
  evidence: z.array(z.unknown()),
  provenance: z.looseObject({
    experimentId: z.string().nullable(), selectionRevision: z.string().nullable(),
    completeTurns: z.number(), unpairedGroups: z.number(), unknownGroups: z.number(),
  }).optional(),
  receipt: z.looseObject({ status: z.string(), error: z.string().nullable(), durationMs: z.number(), outputTokens: z.number().nullable() }).nullable(),
})

const CurriculumRunStatus = z.enum(['interpreting', 'sourcing', 'fetching', 'outlining', 'awaiting-approval', 'inferring', 'writing', 'completed', 'failed', 'rejected'])
export const CurriculumRun = z.looseObject({
  runId: z.string(), status: CurriculumRunStatus, objective: z.string(), curriculumId: z.string().nullable(), error: z.string().nullable(),
  outline: z.looseObject({
    title: z.string(), description: z.string(),
    lanes: z.array(z.looseObject({ id: z.string(), title: z.string() })),
    modules: z.array(z.looseObject({ id: z.string(), laneId: z.string(), title: z.string(), topics: z.array(z.string()) })),
    moduleDependencies: z.array(z.looseObject({ moduleId: z.string(), dependsOnModuleId: z.string() })),
  }).nullable(),
  createdAt: z.string(), updatedAt: z.string(),
})

export const PlaygroundProvider = z.enum(['codex', 'claude', 'agy'])
export const PlaygroundScenario = z.enum(['influence', 'none', 'abstain', 'empty', 'malformed', 'timeout', 'service_error', 'cli_error'])
export const StartLearningPlaygroundTurn = z.object({
  fixtureId: z.string().min(1).max(200), provider: PlaygroundProvider, mode: z.enum(['live', 'fixture']),
  contextMode: z.enum(['fixture', 'current_turn', 'retrieval']).optional(), foundationFirst: z.boolean().optional(),
  conversationId: z.string().uuid().optional(), scenario: PlaygroundScenario, message: z.string().trim().min(1).max(6000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(6000) })).max(8).optional(),
  requestId: z.string().uuid(),
})
export const LearningPlaygroundTurn = z.looseObject({
  runId: z.string(), status: z.enum(['running', 'completed', 'failed']), response: z.string().nullable(), error: z.string().nullable(),
  invocationCount: z.number(),
  classification: z.looseObject({ status: z.string(), conceptIds: z.array(z.string()) }).nullable(),
  timing: z.looseObject({ totalModelMs: z.number() }),
  background: z.looseObject({ status: z.string() }),
  events: z.array(z.looseObject({ sequence: z.number(), kind: z.string(), at: z.string(), payload: z.unknown() })),
})

export const RunId = z.object({ runId: z.string().uuid() })
export const CurriculumRunDecision = z.looseObject({ runId: z.string(), status: CurriculumRunStatus })
export const PlaygroundFixtures = z.looseObject({
  fixtures: z.array(z.looseObject({ fixtureId: z.string(), runId: z.string(), caseId: z.string(), label: z.string(), prompt: z.string(), matchCount: z.number() })),
})

/** One curriculum purge: deleting a curriculum with its concepts, scores and grading history. */
export const CurriculumPurge = z.object({
  purgeId: z.string(), curriculumId: z.string(), title: z.string().nullable(), status: z.enum(['frozen', 'completed']),
  conceptCount: z.number().int(), counts: z.record(z.string(), z.union([z.number(), z.string()])),
  requestedBy: z.string(), createdAt: z.string(), completedAt: z.string().nullable(),
})
