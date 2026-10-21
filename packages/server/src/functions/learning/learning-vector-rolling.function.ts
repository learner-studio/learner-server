import { defineSessionlessFunction } from '../../runtime/define.js'
import { VectorConceptJob, VectorEnqueueInput, VectorJobs, VectorJob, VectorQueueState, VectorResult } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'
import { rollingConcepts } from '@learner/core/lib/workflow/rolling-queue.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'

export const enqueueLearningVectorConceptsStep = defineSessionlessFunction({
  input: VectorEnqueueInput, output: VectorJobs,
  func: async ({ queueService, queueCancellationService, locks }, { runId, plan }, { workflowStep }) => {
    if (!workflowStep) throw new Error('Durable parent workflow required')
    const jobIds: string[] = []
    for (const concept of rollingConcepts(plan.batches)) {
      if (concept.parts.length * 420 + 60 >= 21600) throw new Error('Concept exceeds the six-hour native queue lease; split its sequential job before enqueueing')
      const jobKey = `${workflowStep.runId}:${concept.conceptId}`
      // jobId maps to pg-boss singletonKey, NOT a unique ID. Adopt the actual
      // native job under a lock, including an enqueue-before-checkpoint crash.
      const id = await locks.withLock('learning-vector-enqueue', jobKey, async () => {
        const existing = await queueCancellationService.findByKey('learning.vector-concepts', jobKey)
        if (existing.length > 1) throw new Error('Duplicate native concept jobs require review')
        if (existing[0]) return existing[0].id
        return queueService.add('learning.vector-concepts', { runId, ...concept, parentWorkflowId: workflowStep.runId, jobKey }, {
          jobId: jobKey, attempts: 2, backoff: { type: 'fixed', delay: 1000 },
          group: { id: runId, tier: String(plan.concurrency) },
        })
      })
      jobIds.push(id)
    }
    return { jobIds }
  },
})

export const waitLearningVectorJobStep = defineSessionlessFunction({
  input: VectorJob, output: VectorQueueState,
  func: async ({ queueService }, { jobId }) => {
    const job = await queueService.getJob('learning.vector-concepts', jobId)
    if (!job?.waitForCompletion) throw new Error('Native concept job/result support missing')
    try {
      await job.waitForCompletion(21600000)
      return { status: 'completed' as const }
    } catch (error) {
      if (await job.status() === 'failed') return { status: 'failed' as const }
      throw error
    }
  },
})

export const learningVectorConceptQueue = defineSessionlessFunction({
  input: VectorConceptJob, output: VectorResult,
  func: async ({ workflowService, locks }, data, { rpc }) =>
    locks.withLock('learning-vector-concept', `${data.runId}:${data.conceptId}`, async () => {
      const previous = (await metaDbQuery<{ workflow_run_id: string; status: string }>(
        `SELECT workflow_run_id,status FROM learner_workflow_runs WHERE workflow='learningVectorConceptWorkflow' AND input::jsonb->>'jobKey'=$1 ORDER BY created_at LIMIT 1`, [data.jobKey],
      )).rows[0]
      let childId: string
      if (previous) {
        childId = previous.workflow_run_id
        if (previous.status !== 'completed') await workflowService.runWorkflowJob(childId, rpc)
      } else {
        const child = await workflowService.startWorkflow('learningVectorConceptWorkflow', data, { type: 'internal' }, rpc, { inline: true })
        childId = child.runId
      }
      // The queue slot remains occupied until the durable child is terminal.
      const child = await workflowService.getRun(childId)
      if (child?.status !== 'completed') throw new Error(`Concept child ${childId} ended ${child?.status ?? 'missing'}; review required`)
      return { runId: data.runId, status: 'completed' }
    }),
})
