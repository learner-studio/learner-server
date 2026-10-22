import { defineWorkflow } from '../runtime/define.js'
import { CurriculumPurgeDone, CurriculumPurgeRef } from '../functions/learning/curriculum-purge.function.js'

/** Delete a curriculum comprehensively. Every step is idempotent over the frozen purge record. */
export const learningCurriculumPurgeWorkflow = defineWorkflow({ title: 'Delete a curriculum: stop grading it, purge its history, remove its tree', input: CurriculumPurgeRef, output: CurriculumPurgeDone,
  func: async ({}, data, { workflow }) => {
    await workflow.do('Stop live grading of the concepts', 'stopCurriculumGradingStep', data, { retries: 2, retryDelay: '5s' })
    await workflow.do('Purge scores and grading history', 'purgeCurriculumHistoryStep', data, { retries: 2, retryDelay: '5s' })
    await workflow.do('Remove the tree, concepts and generation runs', 'removePurgedCurriculumStep', data, { retries: 2, retryDelay: '5s' })
    return await workflow.do('Record what was removed', 'finishCurriculumPurgeStep', data, { retries: 2, retryDelay: '1s' })
  },
})
