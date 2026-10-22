import { z } from 'zod'
import { defineFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { finishCurriculumPurge, freezeCurriculumPurge, getCurriculumPurge, purgeCurriculumHistory, removePurgedCurriculum, stopCurriculumGrading } from '@learner/core/lib/learning/learning-curriculum-purge.js'

export const DeleteCurriculumInput = z.object({ curriculumId: z.string().min(1), allowSeed: z.boolean().default(false) })
export const CurriculumPurgeRef = z.object({ purgeId: z.string().uuid() })
export const CurriculumPurgeCounts = z.record(z.string(), z.union([z.number(), z.string()]))
export const CurriculumPurgeOutput = z.object({
  purgeId: z.string(), curriculumId: z.string(), title: z.string().nullable(), status: z.enum(['frozen', 'completed']),
  conceptCount: z.number().int(), counts: CurriculumPurgeCounts, requestedBy: z.string(), createdAt: z.string(), completedAt: z.string().nullable(),
})

export const deleteLearningCurriculum = defineFunction({
  title: 'Delete a curriculum comprehensively: tree, concepts, scores, grading history and live grading state',
  expose: true, scopes: ['admin'], input: DeleteCurriculumInput, output: CurriculumPurgeOutput,
  func: async ({ workflowService }, { curriculumId, allowSeed }, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    const purgeId = await freezeCurriculumPurge(curriculumId, session.userId, { allowSeed })
    const runs = (await metaDbQuery<{ status: string }>("SELECT status FROM learner_workflow_runs WHERE workflow='learningCurriculumPurgeWorkflow' AND input::jsonb->>'purgeId'=$1", [purgeId])).rows
    if (!runs.some((r) => !['failed', 'cancelled'].includes(r.status))) await workflowService.startWorkflow('learningCurriculumPurgeWorkflow', { purgeId }, { type: 'http', userId: session.userId }, rpc)
    return getCurriculumPurge(purgeId)
  },
})

export const getLearningCurriculumPurge = defineFunction({
  title: 'Read one curriculum purge: status and what it removed', expose: true, readonly: true, scopes: ['admin'],
  input: CurriculumPurgeRef, output: CurriculumPurgeOutput,
  func: async ({}, { purgeId }) => getCurriculumPurge(purgeId),
})

// Live grading must not admit or route a purged concept mid-purge.
export const stopCurriculumGradingStep = defineSessionlessFunction({ input: CurriculumPurgeRef, output: CurriculumPurgeCounts,
  func: async ({ locks }, { purgeId }) => locks.withLock('learning-reactive', 'routing', () => locks.withLock('learning-reactive', 'admission', () => stopCurriculumGrading(purgeId))) })
export const purgeCurriculumHistoryStep = defineSessionlessFunction({ input: CurriculumPurgeRef, output: CurriculumPurgeCounts, func: async ({}, { purgeId }) => purgeCurriculumHistory(purgeId) })
export const removePurgedCurriculumStep = defineSessionlessFunction({ input: CurriculumPurgeRef, output: CurriculumPurgeCounts, func: async ({}, { purgeId }) => removePurgedCurriculum(purgeId) })
export const CurriculumPurgeDone = CurriculumPurgeRef.extend({ status: z.enum(['frozen', 'completed']) })
export const finishCurriculumPurgeStep = defineSessionlessFunction({ input: CurriculumPurgeRef, output: CurriculumPurgeDone,
  func: async ({}, { purgeId }) => { const { status } = await finishCurriculumPurge(purgeId); return { purgeId, status } } })
