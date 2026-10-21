import { createHash,randomUUID } from 'node:crypto'
import { z } from 'zod'
import { metaDbQuery } from '../db-metadata/_shared.js'
import type { LangfuseBatch } from '@learner/llm/harness/langfuse-types.js'
import { exportLangfuseBatch as enqueueFeedbackBatch } from '@learner/llm/harness/langfuse-export.js'
import { PREREQUISITE_EXPERIMENT_LABEL } from './learning-prerequisite-selection.js'

export const LearningFeedbackTraceInput=z.object({
  sessionId:z.string().min(1).max(200),turnId:z.string().uuid(),phase:z.enum(['injection','submission']),
  promptRevision:z.literal('task-teaching-v2'),catalogVersion:z.string().regex(/^[a-f0-9]{64}$/),
  outcomeVersion:z.enum(['v1','v1.2','v1.3','v1.4']).optional(),
  promptHash:z.string().regex(/^[a-f0-9]{64}$/),injectedPrompt:z.string().min(1).max(200000),
  message:z.string().min(1).max(100000),feedback:z.unknown().optional(),guidance:z.unknown().optional(),
}).catchall(z.unknown()).superRefine((value,ctx)=>{
  const allowed=['sessionId','turnId','phase','promptRevision','catalogVersion','promptHash','injectedPrompt','message','feedback','guidance','outcomeVersion']
  for(const key of Object.keys(value)) if(!allowed.includes(key)) ctx.addIssue({code:'custom',path:[key],message:'Unknown property'})
  if(createHash('sha256').update(value.injectedPrompt).digest('hex')!==value.promptHash) ctx.addIssue({code:'custom',message:'Injected prompt hash mismatch'})
  if(value.phase==='submission'&&(value.feedback===undefined||value.guidance===undefined)) ctx.addIssue({code:'custom',message:'Submission trace needs exact feedback and guidance'})
})
export const LearningFeedbackTraceOutput=z.object({traceId:z.string().uuid(),state:z.enum(['pending','queued','sending','exported','uncertain'])})
export const LearningFeedbackTraceId=z.object({traceId:z.string().uuid()})
export const LearningFeedbackTraceStatus=z.object({traceId:z.string().uuid(),state:z.enum(['pending','queued','sending','exported','uncertain']),sessionId:z.string(),turnId:z.string().uuid(),phase:z.enum(['injection','submission']),promptHash:z.string(),promptRevision:z.string(),outcomeVersion:z.enum(['v1','v1.2','v1.3','v1.4']).optional(),catalogVersion:z.string(),createdAt:z.string(),exportedAt:z.string().nullable()})
export const LearningFeedbackTraceIds=z.object({traceIds:z.array(z.string().uuid())})
export const LearningFeedbackTraceEmpty=z.object({})
export const LearningFeedbackTraceDrainOutput=z.object({processed:z.number().int()})
type TraceInput=z.infer<typeof LearningFeedbackTraceInput>

export async function getFeedbackTraceStatus(userId:string,traceId:string) {
  const row=(await metaDbQuery<{id:string;state:string;session_id:string;turn_id:string;phase:string;payload:unknown;created_at:Date|string;exported_at:Date|string|null}>(`SELECT r.id,
    CASE WHEN r.state='queued' AND jsonb_array_length(COALESCE(r.export_result->'outboxIds','[]'::jsonb))>0
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.export_result->'outboxIds') AS refs(id)
        LEFT JOIN telemetry_outbox o ON o.id=refs.id::uuid WHERE o.id IS NULL OR o.state<>'delivered')
      THEN 'exported' ELSE r.state END AS state,
    r.session_id,r.turn_id,r.phase,r.payload,r.created_at,
    COALESCE(r.exported_at,(SELECT max(o.delivered_at) FROM telemetry_outbox o
      WHERE o.id IN (SELECT refs.id::uuid FROM jsonb_array_elements_text(COALESCE(r.export_result->'outboxIds','[]'::jsonb)) AS refs(id)))) AS exported_at
    FROM learning_feedback_traces r WHERE r.id=$1 AND r.user_id=$2`,[traceId,userId])).rows[0]
  if(!row) throw new Error('Learning feedback trace not found')
  const payload=LearningFeedbackTraceInput.parse(row.payload)
  return LearningFeedbackTraceStatus.parse({traceId:row.id,state:row.state,sessionId:row.session_id,turnId:row.turn_id,phase:row.phase,promptHash:payload.promptHash,promptRevision:payload.promptRevision,outcomeVersion:payload.outcomeVersion,catalogVersion:payload.catalogVersion,createdAt:new Date(row.created_at).toISOString(),exportedAt:row.exported_at?new Date(row.exported_at).toISOString():null})
}

export async function recordFeedbackTrace(userId:string,input:TraceInput) {
  // JSON Schema cannot encode the exact-byte hash or conditional payload checks.
  input=LearningFeedbackTraceInput.parse(input)
  const id=randomUUID(),payload=JSON.stringify(input)
  await metaDbQuery(`INSERT INTO learning_feedback_traces(id,user_id,session_id,turn_id,phase,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,[id,userId,input.sessionId,input.turnId,input.phase,payload])
  const row=(await metaDbQuery<{id:string;state:string;same:boolean}>(`SELECT id,state,payload=$5::jsonb AS same FROM learning_feedback_traces WHERE user_id=$1 AND session_id=$2 AND turn_id=$3 AND phase=$4`,[userId,input.sessionId,input.turnId,input.phase,payload])).rows[0]
  if(!row?.same) throw new Error('Conflicting immutable hook trace')
  return exportFeedbackTrace(row.id)
}

export function feedbackTraceBatch(id:string,userId:string,payload:TraceInput,createdAt:string):LangfuseBatch {
  return {taskId:id,fence:1,revision:1,traceId:id,totals:{generations:0,inputTokens:0,outputTokens:0},events:[{
    id,type:'trace-create',timestamp:createdAt,body:{id,name:`learning-feedback-${payload.phase}`,timestamp:createdAt,sessionId:payload.sessionId,userId,
      version:payload.promptRevision,environment:'learning-dev',tags:[...(payload.outcomeVersion==='v1.4'?[PREREQUISITE_EXPERIMENT_LABEL]:[]),'learning','live-feedback',payload.promptRevision,payload.phase,...(payload.outcomeVersion?[payload.outcomeVersion,`learning-outcomes-${payload.outcomeVersion}`]:[]),...(/^(probe|e2e)-trace:/.test(payload.sessionId)?['test-fixture']:[])],
      metadata:{turnId:payload.turnId,catalogVersion:payload.catalogVersion,promptHash:payload.promptHash,...(payload.outcomeVersion?{outcomeVersion:payload.outcomeVersion,outcomeUnit:'sessionId+turnId',deliveryRevision:'inline-parts-v1'}:{}),coverage:'hook-feedback-io-only',deliveryQuality:payload.phase==='injection'?'prepared-before-native-ack':'service-response-observed',nativeAssistantResponseIncluded:false,modelUsage:'not-observed',timingQuality:'unknown'},
      input:{message:payload.message,injectedPrompt:payload.injectedPrompt},output:payload.phase==='submission'?{feedback:payload.feedback,guidance:payload.guidance}:undefined,
    },
  }]}
}

export async function pendingFeedbackTraces() {
  // A worker may have died after Langfuse accepted. Never silently resend.
  await metaDbQuery(`UPDATE learning_feedback_traces SET state='uncertain',export_result='{"reason":"export worker stopped before acknowledgement was recorded"}'::jsonb WHERE state='sending' AND claimed_at<now()-interval '5 minutes'`)
  return {traceIds:(await metaDbQuery<{id:string}>(`SELECT id FROM learning_feedback_traces WHERE state IN ('pending','queued') ORDER BY created_at LIMIT 20`)).rows.map(row=>row.id)}
}
export async function exportFeedbackTrace(traceId:string) {
  const row=(await metaDbQuery<{user_id:string;payload:unknown;created_at:Date|string;state:string}>(`SELECT user_id,payload,created_at,state FROM learning_feedback_traces WHERE id=$1`,[traceId])).rows[0]
  if(!row)throw new Error('Learning feedback trace not found')
  if(!['pending','queued'].includes(row.state))return LearningFeedbackTraceOutput.parse({traceId,state:row.state})
  const batch=feedbackTraceBatch(traceId,row.user_id,LearningFeedbackTraceInput.parse(row.payload),new Date(row.created_at).toISOString())
  const result=await enqueueFeedbackBatch(batch,{environment:'learning-dev'})
  const state=result.state==='delivered'?'exported':'queued'
  await metaDbQuery(`UPDATE learning_feedback_traces SET state=$2,exported_at=CASE WHEN $2='exported' THEN now() ELSE NULL END,export_result=$3::jsonb WHERE id=$1 AND state IN ('pending','queued')`,[traceId,state,JSON.stringify({outboxIds:result.outboxIds})])
  return LearningFeedbackTraceOutput.parse({traceId,state})
}
