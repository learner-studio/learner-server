export const LearningMaintenanceInput = z.object({})
import { enqueueLearningMaintenance } from '@learner/core/lib/learning/learning-maintenance.js'
import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { defineFunction,defineSessionlessFunction,defineVoidFunction } from '../../runtime/define.js'
import { startWorkflowOnce } from '../../runtime/start-once.js'
import { z } from 'zod'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { ArchiveClaimInput,ArchivePass,ArchiveDispatchInput,ArchiveDispatchOutput } from '@learner/core/lib/learning/learning-archive-coordinator.js'
import { ReactiveConfig,ReactiveEmpty,ReactiveRetryInput,ReactiveStatus,ReactiveRoutingResult,configureReactive,reactiveStatus,reactiveSettings,routeReactive,reactiveCoalescer,prepareReactive,publishReactive,retryReactiveTarget,releaseReactiveHolds,ReactiveHoldRelease,recordRoutingOutcome } from '@learner/core/lib/learning/learning-reactive-consolidation.js'
import { VectorResult,VectorRunInput } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'
import {ReactiveProbeInput} from '@learner/core/lib/learning/learning-reactive-probe.js'

export const ReactivePrepared=VectorRunInput.extend({conceptId:z.string()})
export const queueLearningReactiveProbe=defineFunction({title:'Replay one existing canonical vector arrival for end-to-end verification',expose:true,scopes:['admin'],input:ReactiveProbeInput,output:VectorRunInput,
  func:async({},data,{session,rpc})=>{
    assertLearningLocalMvpEnabled()
    const setting=await reactiveSettings(session.userId)
    if(!setting?.enabled||setting.config.conceptIds?.length!==1) throw new Error('Paid probe requires a single-concept reactive scope')
    const source=await metaDbQuery(`SELECT 1 FROM learning_semantic_index_messages m WHERE message_id=$1 AND current_canonical AND status='indexed'
      AND NOT EXISTS(SELECT 1 FROM learning_cli_vector_e2e_runs f WHERE f.mastery_excluded AND f.session_id::text=m.conversation_id)`,[data.messageId])
    if(!source.rowCount) throw new Error('Probe requires existing non-fixture canonical indexed evidence')
    await metaDbQuery('INSERT INTO learning_vector_arrivals(message_id,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[data.messageId,data.requestId])
    const saved=(await metaDbQuery<{message_id:string}>('SELECT message_id FROM learning_vector_arrivals WHERE event_id=$1',[data.requestId])).rows[0]
    if(saved?.message_id!==data.messageId) throw new Error('Probe identity reused for different source')
    await rpc.invoke('wakeLearningReactiveRoutingStep',{runId:data.requestId})
    return {runId:data.requestId}
  },
})
export const configureLearningReactiveConsolidation=defineFunction({title:'Configure automatic vector-related concept updates',expose:true,scopes:['admin'],input:ReactiveConfig,output:ReactiveStatus,
  func:async({locks,learningCurriculumStore,learningVectorTurns,learningConceptAssessment},data,{session})=>{
    assertLearningLocalMvpEnabled()
    const parsed=ReactiveConfig.parse(data)
    if(parsed.enabled&&parsed.concurrency>(reactiveCoalescer.maxConcurrency??3))
      throw new Error('Reactive concurrency runtime is stale; reload before increasing the limit')
    if(parsed.enabled&&(learningVectorTurns.reactiveRevision!=='reactive-v1'||learningConceptAssessment.reactiveRevision!=='reactive-v1'||reactiveCoalescer.lane!=='assessment'))
      throw new Error('Reactive runtime is stale; reload services before enabling automatic work')
    const ids=new Set((await learningCurriculumStore.listGraphs()).flatMap(g=>g.concepts.map(c=>c.id)))
    if(parsed.conceptIds?.some(id=>!ids.has(id))) throw new Error('Unknown reactive concept ID')
    return locks.withLock('learning-reactive','routing',()=>locks.withLock('learning-reactive','admission',()=>configureReactive(session.userId,parsed)))
  },
})
export const getLearningReactiveConsolidation=defineFunction({title:'Inspect pending and blocked automatic concept updates',expose:true,readonly:true,scopes:['admin'],input:ReactiveEmpty,output:ReactiveStatus,
  func:async({},_data,{session})=>{assertLearningLocalMvpEnabled();return reactiveStatus(session.userId)},
})
export const retryLearningReactiveTarget=defineFunction({title:'Release one blocked automatic concept update after reviewing its paid receipts',expose:true,scopes:['admin'],input:ReactiveRetryInput,output:ReactiveStatus,
  func:async({locks},{conceptId},{session,rpc})=>{
    assertLearningLocalMvpEnabled()
    await locks.withLock('learning-reactive','admission',()=>retryReactiveTarget(session.userId,conceptId))
    await rpc.invoke('dispatchLearningReactiveConceptsStep',{})
    return reactiveStatus(session.userId)
  },
})
export const ReactiveHoldReleaseInput=z.object({onlyExhausted:z.boolean().default(true)})
export const releaseLearningReactiveHolds=defineFunction({title:'Release held vector arrivals so routing tries them again with a fresh retry budget',expose:true,scopes:['admin'],input:ReactiveHoldReleaseInput,output:ReactiveHoldRelease,
  func:async({locks},{onlyExhausted},{session})=>{
    assertLearningLocalMvpEnabled()
    return locks.withLock('learning-reactive','routing',()=>releaseReactiveHolds(session.userId,onlyExhausted))
  },
})
export const routeLearningReactiveArrivalsStep=defineSessionlessFunction({title:'Route verified vectors to existing concepts without classifier calls',input:ReactiveEmpty,output:ReactiveRoutingResult,
  func:async({locks,learningVectorTurns,learningCurriculumStore,logger})=>{
    assertLearningLocalMvpEnabled()
    return locks.withLock('learning-reactive','routing',async()=>{
      const result=await recordRoutingOutcome(()=>routeReactive(learningVectorTurns,learningCurriculumStore),
        error=>logger.error({event:'learning-reactive-routing-failed',error:error instanceof Error?error.stack??error.message:String(error)}))
      // Held arrivals are isolated, not failures of this step: counted here, listed by getLearningReactiveConsolidation.
      if(result.held) logger.warn({event:'learning-reactive-routing-held',held:result.held,exhausted:result.exhausted,routed:result.messages})
      return result
    })
  },
})
export const dispatchLearningReactiveConceptsStep=defineSessionlessFunction({input:ReactiveEmpty,output:ArchiveDispatchOutput,
  func:async({locks,workflowService},_data,{rpc})=>{
    if(learningAdmissionPaused()) return {started:0}

    assertLearningLocalMvpEnabled()
    return locks.withLock('learning-reactive','admission',async()=>{
      const settings=(await metaDbQuery<{config:z.infer<typeof ReactiveConfig>}>("SELECT config FROM learning_reactive_settings WHERE enabled AND config->>'assessmentEnabled'='true'")).rows
      if(!settings.length) return {started:0}
      return reactiveCoalescer.dispatchArchiveSessions(async data=>{
        const current=await reactiveSettings(data.userId)
        if(!current?.enabled||!current.config.assessmentEnabled) throw new Error('Reactive paid admission disabled')
        return (await workflowService.startWorkflow('learningReactiveConceptWorkflow',data,{type:'scheduled',userId:data.userId},rpc)).runId
      },undefined,Math.min(...settings.map(s=>s.config.concurrency)))
    })
  },
})
export const claimLearningReactivePassStep=defineSessionlessFunction({input:ArchiveClaimInput,output:ArchivePass,
  func:async({locks},data)=>locks.withLock('learning-reactive','admission',()=>reactiveCoalescer.claimArchivePass(data)),
})
export const prepareLearningReactivePassStep=defineSessionlessFunction({input:ArchiveDispatchInput,output:ReactivePrepared,
  func:async({learningVectorTurns},data)=>prepareReactive(data,learningVectorTurns),
})
export const publishLearningReactivePassStep=defineSessionlessFunction({input:ArchivePass,output:VectorResult,
  func:async({learningVectorTurns},data)=>publishReactive(data,learningVectorTurns),
})
export const settleLearningReactivePassStep=defineSessionlessFunction({input:ArchivePass,output:ArchiveDispatchOutput,
  func:async({locks},data)=>locks.withLock('learning-reactive','admission',()=>reactiveCoalescer.settleArchivePass(data)),
})
export const wakeLearningReactiveRoutingStep=defineSessionlessFunction({input:VectorRunInput,output:VectorRunInput,
  func:async({locks,workflowService},data,{rpc})=>{
    if(learningAdmissionPaused()) return data
    if(!(await metaDbQuery('SELECT 1 FROM learning_reactive_settings WHERE enabled LIMIT 1')).rowCount) return data
    await locks.withLock('learning-reactive',data.runId,()=>startWorkflowOnce(workflowService,rpc,'learningReactiveRoutingWorkflow',data,'runId',{type:'scheduled'}))
    return data
  },
})
export const recoverLearningReactiveConsolidationOperation=defineSessionlessFunction({input: LearningMaintenanceInput,title:'Recover un-routed vector arrivals and concept admission',
  func:async({},_data,{rpc})=>{
    // No wall-clock cursor: unfinished arrivals remain queryable after a crash.
    // Admission runs first and does not depend on routing: until 2026-11-11 a
    // routing failure skipped dispatch too, so already-routed concepts sat for
    // twelve days behind one unverifiable chunk.
    await rpc.invoke('dispatchLearningReactiveConceptsStep',{})
    await rpc.invoke('routeLearningReactiveArrivalsStep',{})
    await rpc.invoke('dispatchLearningReactiveConceptsStep',{})
  },
})

export const recoverLearningReactiveConsolidation=defineVoidFunction({
  func:async({queueService,queueCancellationService,locks})=>{
    await enqueueLearningMaintenance(queueService,queueCancellationService,locks,'reactive')
  },
})
