import {defineFunction,defineSessionlessFunction} from '../../runtime/define.js'
import {PromptAbRun,PromptAbItem,PromptAbAny} from './learning-prompt-ab.function.js'
import {metaDbQuery as q} from '@learner/core/lib/db-metadata/_shared.js'

// Keyed by the immutable receipt, not a delivery attempt or caller job key.
export const enqueueLearningPromptAbAuditStep=defineSessionlessFunction({input:PromptAbItem,output:PromptAbAny,
  func:async({queueService,queueCancellationService,locks},data)=>{
    const key=`audit:${data.runId}:${data.assessmentRunId}`
    return locks.withLock('learning-prompt-ab-audit',key,async()=>{
      const old=await queueCancellationService.findByKey('learning.prompt-ab-audit',key)
      if(old.length>1)throw new Error('Duplicate durable prompt audit job')
      const auditJobId=old[0]?.id??await queueService.add('learning.prompt-ab-audit',data,{jobId:key,attempts:3,backoff:{type:'fixed',delay:1000}})
      return {auditJobId,state:'queued'}
    })
  },
})
export const waitLearningPromptAbAuditsStep=defineSessionlessFunction({input:PromptAbRun,output:PromptAbAny,
  func:async({queueService,queueCancellationService},data)=>{
    const row=(await q('SELECT manifest FROM learning_consolidator_prompt_experiments WHERE run_id=$1',[data.runId])).rows[0]
    if(!row)throw new Error('Missing frozen experiment')
    for(const item of row.manifest.items)for(const id of [item.baselineRunId,item.treatmentRunId]){
      const jobs=await queueCancellationService.findByKey('learning.prompt-ab-audit',`audit:${data.runId}:${id}`)
      if(jobs.length!==1)throw new Error('Missing or duplicate prompt audit job')
      const job=await queueService.getJob('learning.prompt-ab-audit',jobs[0]!.id)
      if(!job?.waitForCompletion)throw new Error('Native audit observer unavailable')
      await job.waitForCompletion(21600000)
    }
    return {state:'queued',auditJobs:row.manifest.items.length*2}
  },
})
// Recovery can only project existing owned receipts. It never enters inference.
export const resumeLearningPromptAbAudit=defineFunction({expose:true,scopes:['admin'],input:PromptAbItem,output:PromptAbAny,
  func:async({queueService},data,{session,rpc})=>{
    const row=(await q(`SELECT e.run_id FROM learning_consolidator_prompt_experiments e
      JOIN learning_concept_assessment_runs a ON a.snapshot->>'experimentId'=e.run_id::text
      JOIN learning_concept_assessment_receipts r ON r.run_id=a.run_id
      WHERE e.run_id=$1 AND e.user_id=$2 AND a.run_id=$3
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.manifest->'items') i
        WHERE i->>'baselineRunId'=a.run_id::text OR i->>'treatmentRunId'=a.run_id::text)`,[data.runId,session.userId,data.assessmentRunId])).rows[0]
    if(!row)throw new Error('Owned frozen assessment receipt required')
    const admitted=await rpc.invoke('enqueueLearningPromptAbAuditStep',data)
    const job=await queueService.getJob('learning.prompt-ab-audit',String(admitted.auditJobId))
    return {...admitted,auditJobState:job?await job.status():'missing'}
  },
})
