import { randomUUID } from 'node:crypto'
import { priorRun } from '../../runtime/start-once.js'
import { defineSessionlessFunction } from '../../runtime/define.js'
import { pikkuFunc, pikkuSessionlessFunc } from '#pikku/function'
import { VectorTurnConfig,VectorRunInput,VectorPartInput,VectorPlan,VectorBatchInput,VectorBatchOutput,VectorResult,StartVectorExperiment,GetVectorExperiment,GetVectorExperimentOutput } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'
export { VectorRunInput,VectorResult,VectorExperiment } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { isTerminalStatus, STOPPED_WORKFLOW_STATUSES } from '@learner/core/lib/workflow/workflow-runs.js'
import { ResumeVectorExperiment } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'

export const startLearningVectorExperiment = pikkuFunc({expose:true,scopes:['admin'],input:StartVectorExperiment,output:VectorRunInput,
  func:async({learningVectorTurns,locks,variables},data,{session,rpc})=>{
    assertLearningLocalMvpEnabled()
    if(data.purpose==='live') throw new Error('Live publication requires reactive concept admission')
    const enabled:unknown=await variables.get('LEARNING_VECTOR_TURNS_ENABLED')
    if (enabled!==true && enabled!=='true') throw new Error('Vector-turn consolidation is disabled by the operator')
    if(data.concurrency>Number(await variables.get('LEARNING_VECTOR_TURNS_MAX_CONCURRENCY')??3)) throw new Error('Requested concurrency exceeds the configured operator ceiling')
    const runId=data.requestId??randomUUID()
    await locks.withLock('learning-vector-experiment',runId,async()=>{
      await learningVectorTurns.create(runId,session.userId,VectorTurnConfig.parse(data))
      if(!await priorRun('learningVectorTurnWorkflow',{runId},'runId')) await rpc.startWorkflow('learningVectorTurnWorkflow',{runId},{wire:{type:'http',pikkuUserId:session.userId}})
    })
    return {runId}
  }})
export const getLearningVectorExperiment = pikkuFunc({expose:true,readonly:true,scopes:['admin'],input:GetVectorExperiment,output:GetVectorExperimentOutput,
  func:async({learningVectorTurns},data,{session})=>({experiment:data.runId?await learningVectorTurns.inspect(data.runId,session.userId):await learningVectorTurns.latest(session.userId)})})
export const resumeLearningVectorExperiment = pikkuFunc({expose:true,scopes:['admin'],input:ResumeVectorExperiment,output:VectorRunInput,
  func:async({learningVectorTurns,locks,variables},data,{session,rpc})=>{
    assertLearningLocalMvpEnabled()
    const enabled:unknown=await variables.get('LEARNING_VECTOR_TURNS_ENABLED')
    if(enabled!==true&&enabled!=='true') throw new Error('Vector-turn consolidation is disabled by the operator')
    const max=Number(await variables.get('LEARNING_VECTOR_TURNS_MAX_CONCURRENCY')??3)
    if(data.concurrency>max) throw new Error('Requested concurrency exceeds the configured operator ceiling')
    await locks.withLock('learning-vector-experiment',data.runId,async()=>{
      const state=await learningVectorTurns.inspect(data.runId,session.userId)
      const previous=await metaDbQuery(`SELECT workflow_run_id FROM learner_workflow_runs WHERE workflow='learningVectorTurnWorkflow' AND input::jsonb->>'runId'=$1 AND input::jsonb->>'executionRequestId'=$2`,[data.runId,data.requestId])
      if(previous.rowCount) {
        if(state.metadata?.executionChanges?.find(change=>change.requestId===data.requestId)?.concurrency!==data.concurrency) throw new Error('Continuation request ID reused with different concurrency')
        return
      }
      await learningVectorTurns.recordExecutionChange(data.runId,session.userId,data.requestId,data.concurrency)
      await rpc.startWorkflow('learningVectorTurnWorkflow',{runId:data.runId,executionRequestId:data.requestId},{wire:{type:'http',pikkuUserId:session.userId}})
    })
    return {runId:data.runId}
  }})
export const prepareLearningVectorExperimentStep = pikkuSessionlessFunc({input:VectorRunInput,output:VectorPlan,func:async({learningVectorTurns},{runId})=>learningVectorTurns.prepare(runId)})
export const prepareLearningVectorAssessmentStep = pikkuSessionlessFunc({input:VectorPartInput,output:VectorRunInput,func:async({learningVectorTurns},{runId,conceptId,part,parentWorkflowId})=>{
  if(parentWorkflowId) {
    const parent=(await metaDbQuery<{status:string}>('SELECT status FROM learner_workflow_runs WHERE workflow_run_id=$1',[parentWorkflowId])).rows[0]
    if(!parent||isTerminalStatus(parent.status)) throw new Error('Parent stopped; no new concept part will be dispatched')
  }
  return learningVectorTurns.preparePart(runId,conceptId,part)
}})
export const prepareLearningVectorBatchStep=defineSessionlessFunction({input:VectorBatchInput,output:VectorBatchOutput,func:async({learningVectorTurns},{runId,items},{workflowStep})=>{
  // Inline workflow executions cache parent state; poll fresh at each batch boundary.
  if(workflowStep) {
    const parent=(await metaDbQuery<{status:string}>('SELECT status FROM learner_workflow_runs WHERE workflow_run_id=$1',[workflowStep.runId])).rows[0]
    if(!parent||STOPPED_WORKFLOW_STATUSES.includes(parent.status)) throw new Error('Parent stopped; no new assessment batch will be dispatched')
  }
  return {runs:await Promise.all(items.map(item=>learningVectorTurns.preparePart(runId,item.conceptId,item.part)))}
}})
export const finishLearningVectorExperimentStep = pikkuSessionlessFunc({input:VectorRunInput,output:VectorResult,func:async({learningVectorTurns},{runId})=>learningVectorTurns.finish(runId)})
