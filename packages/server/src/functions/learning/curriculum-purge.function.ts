import { z } from 'zod'
import { pikkuFunc, pikkuSessionlessFunc } from '#pikku/function'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { priorRun } from '../../runtime/start-once.js'
import { STOPPED_WORKFLOW_STATUSES } from '@learner/core/lib/workflow/workflow-runs.js'
import { finishCurriculumPurge, freezeCurriculumPurge, getCurriculumPurge, purgeCurriculumHistory, removePurgedCurriculum, stopCurriculumGrading } from '@learner/core/lib/learning/learning-curriculum-purge.js'

export const DeleteCurriculumInput = z.object({ curriculumId: z.string().min(1), allowSeed: z.boolean().default(false) })
export const CurriculumPurgeRef = z.object({ purgeId: z.string().uuid() })
export const CurriculumPurgeCounts = z.record(z.string(), z.union([z.number(), z.string()]))
export const CurriculumPurgeOutput = z.object({
  purgeId: z.string(), curriculumId: z.string(), title: z.string().nullable(), status: z.enum(['frozen', 'completed']),
  conceptCount: z.number().int(), counts: CurriculumPurgeCounts, requestedBy: z.string(), createdAt: z.string(), completedAt: z.string().nullable(),
})

export const deleteLearningCurriculum = pikkuFunc({
  title: 'Delete a curriculum comprehensively: tree, concepts, scores, grading history and live grading state',
  expose: true, scopes: ['admin'], input: DeleteCurriculumInput, output: CurriculumPurgeOutput,
  func: async ({}, { curriculumId, allowSeed }, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    const purgeId = await freezeCurriculumPurge(curriculumId, session.userId, { allowSeed })
    if (!await priorRun('learningCurriculumPurgeWorkflow', { purgeId }, 'purgeId', [...STOPPED_WORKFLOW_STATUSES])) {
      await rpc.startWorkflow('learningCurriculumPurgeWorkflow', { purgeId }, { wire: { type: 'http', pikkuUserId: session.userId } })
    }
    return getCurriculumPurge(purgeId)
  },
})

export const getLearningCurriculumPurge = pikkuFunc({
  title: 'Read one curriculum purge: status and what it removed', expose: true, readonly: true, scopes: ['admin'],
  input: CurriculumPurgeRef, output: CurriculumPurgeOutput,
  func: async ({}, { purgeId }) => getCurriculumPurge(purgeId),
})

// Live grading must not admit or route a purged concept mid-purge.
export const stopCurriculumGradingStep = pikkuSessionlessFunc({ input: CurriculumPurgeRef, output: CurriculumPurgeCounts,
  func: async ({ locks }, { purgeId }) => locks.withLock('learning-reactive', 'routing', () => locks.withLock('learning-reactive', 'admission', () => stopCurriculumGrading(purgeId))) })
export const purgeCurriculumHistoryStep = pikkuSessionlessFunc({ input: CurriculumPurgeRef, output: CurriculumPurgeCounts, func: async ({}, { purgeId }) => purgeCurriculumHistory(purgeId) })
export const removePurgedCurriculumStep = pikkuSessionlessFunc({ input: CurriculumPurgeRef, output: CurriculumPurgeCounts, func: async ({}, { purgeId }) => removePurgedCurriculum(purgeId) })
export const CurriculumPurgeDone = CurriculumPurgeRef.extend({ status: z.enum(['frozen', 'completed']) })
export const finishCurriculumPurgeStep = pikkuSessionlessFunc({ input: CurriculumPurgeRef, output: CurriculumPurgeDone,
  func: async ({}, { purgeId }) => { const { status } = await finishCurriculumPurge(purgeId); return { purgeId, status } } })
