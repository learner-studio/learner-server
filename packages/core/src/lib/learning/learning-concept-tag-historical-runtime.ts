import {executeHistoricalChunks} from '../../services/learning-concept-tag-chunks.js'
import {historicalBatchPlan} from './learning-concept-tag-historical-batching.js'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {metaDbQuery as q} from '../db-metadata/_shared.js'
import {tagHash,type TagManifest,type TagArm} from './learning-concept-tag-experiment.js'
import {tagRun,saveTagManifest,executeTagOnce,type TagStoredRun} from '../../services/learning-concept-tag-store.js'
import type {TypeSafeDecisionService} from '@learner/llm/services/typesafe-decision-service.js'
import {resolveModelCapability} from '@learner/llm/lib/llm/model-catalog.js'
import {learningExperimentApi as api} from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import {HISTORICAL_RUN,HISTORICAL_DATASET,AUDIT_SEED,auditSelection,validateHistoricalSource,historicalDecisionRequest} from './learning-concept-tag-historical.js'
export function selectHistoricalCases<T extends {case_id:string}>(source:T[],ids?:string[]):T[]{
 if(!ids)return source
 if(!ids.length||ids.length>100||new Set(ids).size!==ids.length)throw new Error('Invalid historical case selection')
 return ids.map(id=>{const c=source.find(c=>c.case_id===id);if(!c)throw new Error('Unknown historical case');return c})
}
export function assertHistoricalIdentity(manifest:TagManifest,selected:unknown,maxPaidCalls:number,questionBatchSize?:number,concurrency=1,caseIds?:string[]){
 const h=manifest.historical
 if(!h||(h.budget.concurrency??1)!==concurrency||tagHash(h.selectionCaseIds??null)!==tagHash(caseIds??null)||tagHash(manifest.modelSelection)!==tagHash(selected)||h.budget.maxPaidCalls!==maxPaidCalls||(h.budget.questionBatchSize!==undefined?h.budget.questionBatchSize!==(questionBatchSize??100):questionBatchSize!==undefined))throw new Error('Historical frozen identity conflict')
}
export async function prepareHistorical(runId:string,userId:string,selection:unknown,maxPaidCalls:number,questionBatchSize?:number,concurrency=1,caseIds?:string[]){
 const selected=resolveModelCapability(selection,'noul').selection
 const existing=(await q('SELECT user_id,manifest FROM learning_concept_tag_experiments WHERE run_id=$1',[runId])).rows[0]
 if(existing){if(existing.user_id!==userId)throw new Error('Historical frozen identity conflict');assertHistoricalIdentity(existing.manifest,selected,maxPaidCalls,questionBatchSize,concurrency,caseIds);return {runId,prepared:true,cases:existing.manifest.cases.length}}
 const source=(await q('SELECT * FROM learning_extraction_benchmark_runs WHERE run_id=$1',[HISTORICAL_RUN])).rows[0]
 const sourceCases=(await q('SELECT * FROM learning_extraction_benchmark_cases WHERE run_id=$1 ORDER BY ordinal',[HISTORICAL_RUN])).rows
 const results=(await q('SELECT * FROM learning_extraction_benchmark_results WHERE run_id=$1 ORDER BY case_id',[HISTORICAL_RUN])).rows
 if(!(await q('SELECT id FROM "user" WHERE id=$1 AND email=$2',[userId,'operator@example.invalid'])).rowCount)throw new Error('Historical source is restricted to its operator owner')
 const catalog=source.config.catalog,audit=source.config.attemptAudit[0]
 if(source.config.attemptAudit.length!==1||catalog.length!==470)throw new Error('Unexpected historical catalog/batch count')
 validateHistoricalSource(catalog,sourceCases,results,audit)
 if(createHash('sha256').update(audit.prompt).digest('hex')!==audit.promptHash)throw new Error('Historical prompt hash mismatch')
 const dataset=await api(`/api/public/v2/datasets/${encodeURIComponent(HISTORICAL_DATASET)}`),native:any[]=[]
 for(let page=1;;page++){const r=await api(`/api/public/dataset-items?datasetName=${encodeURIComponent(HISTORICAL_DATASET)}&limit=50&page=${page}`);native.push(...r.data);if(page>=r.meta.totalPages)break}
 if(native.length!==100||new Set(native.map(n=>n.metadata.caseId)).size!==100)throw new Error('Native historical membership mismatch')
 for(const c of sourceCases){const n=native.find(n=>n.metadata.caseId===c.case_id);if(tagHash(n?.input)!==tagHash(c.input_snapshot)||n.expectedOutput!==null)throw new Error('Native source differs or unexpected gold')}
 // Select only after validating the entire original source. IDs denote human-message cases, not verified pairs.
 const cases=selectHistoricalCases(sourceCases,caseIds)
 const paths=['packages/core/src/services/learning-concept-tag-chunks.ts','packages/core/src/lib/learning/learning-concept-tag-historical-batching.ts','packages/core/src/lib/learning/learning-concept-tag-historical.ts','packages/core/src/lib/learning/learning-concept-tag-historical-runtime.ts','packages/core/src/lib/learning/learning-concept-tag-historical-telemetry.ts','packages/core/src/lib/learning/learning-concept-tag-experiment.ts','packages/core/src/lib/learning/learning-concept-tag-telemetry.ts','packages/core/src/lib/learning/learning-concept-tag-readback.ts','packages/llm/src/lib/llm/learning-experiment-langfuse-transport.ts','packages/core/src/services/learning-concept-tag-store.ts','packages/llm/src/services/typesafe-decision-service.ts','packages/llm/src/lib/llm/model-catalog.ts','packages/server/src/functions/learning/learning-concept-tag-rpc.function.ts','packages/server/src/functions/learning/learning-concept-tag-historical.function.ts','packages/server/src/wirings/learning-concept-tag-historical.workflow.ts','packages/server/src/wirings/learning-concept-tag-experiment.workflow.ts','packages/server/src/wiring/queues.ts']
 const code=Object.fromEntries(await Promise.all(paths.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])))
 const git=Bun.spawn(['git','rev-parse','HEAD'],{stdout:'pipe',stderr:'ignore'});code.gitRevision=(await new Response(git.stdout).text()).trim();if(await git.exited)throw new Error('Revision unavailable');code.sourceHash=tagHash(code)
 const plan=historicalBatchPlan(catalog,cases.length,maxPaidCalls,questionBatchSize,concurrency)
 const historical={...(caseIds?{selectionCaseIds:caseIds,selectionUnit:"historical-human-message-case"}:{}),sourceRunId:HISTORICAL_RUN,sourceDatasetId:dataset.id,sourceDatasetName:HISTORICAL_DATASET,sourceModel:source.config.model,sourceBackend:source.config.backend,sourceEffort:source.config.effort,sourceCatalog:catalog,sourceCatalogHash:source.config.catalogHash,sourceAudit:audit,sourceSummary:source.summary,sourceStartedAt:source.started_at,sourceCompletedAt:source.completed_at,sourceSnapshots:cases.map(c=>({caseId:c.case_id,input:c.input_snapshot,inputHash:c.input_hash,datasetItemId:native.find(n=>n.metadata.caseId===c.case_id).id})),baselineResults:results.filter(r=>cases.some(c=>c.case_id===r.case_id)),plannedCaseIds:cases.map(c=>c.case_id),auditSeed:AUDIT_SEED,auditSelectedIds:auditSelection(cases.map(c=>c.case_id)),budget:plan.budget,goldStatus:'absent; existing model outputs are predictions, not gold',latencyComparable:false,contextStrategy:'exact historical current human message; no preceding context; future assistant excluded',catalogScope:'historical 470 title-only CS/data-science catalog, NOT current 664 CS curriculum',protocol:'historical-tag-agreement-batched-v2',promptHash:tagHash(plan.chunks.map(chunk=>historicalDecisionRequest(chunk,'',[])))}
 const manifest:TagManifest={name:`real-seed-v1-jev-batch${plan.budget.questionBatchSize}-vs-existing-flash/${runId}`,providerMode:'live',synthetic:false,curriculumId:'frozen-classifier-v6-470',concepts:catalog.map((c:any)=>({...c,domain:''})),cases:cases.map(c=>({id:c.case_id,text:c.input_snapshot.current.text,context:[],gold:[]})),arms:['baseline-import','jev-live'],threshold:.5,modelSelection:selected,code,historical}
 await saveTagManifest(runId,userId,manifest)
 return {runId,prepared:true,cases:cases.length,concepts:470,maxPaidCalls:plan.budget.maxPaidCalls,questionBatchSize:plan.budget.questionBatchSize,plannedPaidCalls:plan.budget.plannedPaidCalls,auditSelectedIds:historical.auditSelectedIds}
}
export async function executeHistoricalItem(row:TagStoredRun,caseId:string,arm:TagArm,service:TypeSafeDecisionService){
 const h=row.manifest.historical,c=row.manifest.cases.find(c=>c.id===caseId)!,item=row.items.find(i=>i.case_id===caseId&&i.arm===arm)!
 const child=(await q("SELECT workflow_run_id FROM learner_workflow_runs WHERE workflow='learningConceptTagExperimentItemWorkflow' AND input::jsonb->>'runId'=$1 AND input::jsonb->>'caseId'=$2 AND input::jsonb->>'arm'=$3 ORDER BY created_at DESC LIMIT 1",[row.run_id,caseId,arm])).rows[0]
 if(child)await q('UPDATE learning_concept_tag_items SET workflow_run_id=$4 WHERE run_id=$1 AND case_id=$2 AND arm=$3',[row.run_id,caseId,arm,child.workflow_run_id])
 if(item.receipt&&(!item.receipt.chunkJournal||item.receipt.complete))return item.receipt
 if(row.status==='cancelled')throw new Error('Cancelled before dispatch')
 if(row.manifest.synthetic||row.manifest.threshold!==.5||(h.selectionCaseIds?tagHash(row.manifest.cases.map(c=>c.id))!==tagHash(h.selectionCaseIds):row.manifest.cases.length!==100)||(!h.budget.questionBatchSize&&h.budget.maxPaidCalls!==100)||row.manifest.concepts.length!==470)throw new Error('Frozen real budget/protocol mismatch')
 if(arm==='baseline-import'){
 const b=h.baselineResults.find((b:any)=>b.case_id===caseId),now=new Date().toISOString()
 const receipt={ids:b.extraction.matches.map((m:any)=>m.conceptId).sort(),valid:b.status==='completed',raw:JSON.stringify(b.extraction),request:{sourceRunId:h.sourceRunId,promptHash:h.sourceAudit.promptHash},returnedModel:b.model,usage:null,error:b.error,startedAt:now,completedAt:now,latencyMs:null,queueWaitMs:null,endToEndMs:null,providerMode:'imported',synthetic:false,provenance:'Imported existing batch prediction; timestamps describe import only. No provider call or per-message latency.'}
 await q('UPDATE learning_concept_tag_items SET receipt=$4::jsonb WHERE run_id=$1 AND case_id=$2 AND arm=$3 AND receipt IS NULL',[row.run_id,caseId,arm,JSON.stringify(receipt)])
 return receipt
 }
 if(arm!=='jev-live')throw new Error('Unapproved historical arm')
 if(row.items.some(i=>i.arm==='jev-live'&&i.receipt&&i.receipt.valid===false))throw new Error('Historical provider circuit open; inspect first failure before any replacement run')
 if(h.budget.questionBatchSize)return executeHistoricalChunks(row,caseId,service)
 return executeTagOnce(row.run_id,caseId,arm,async()=>{const result=await service.evaluate(row.manifest.modelSelection,historicalDecisionRequest(h.sourceCatalog,c.text,c.context));return {...result,ids:h.sourceCatalog.filter((c:any)=>result.answers[c.ref].noul>=.5).map((c:any)=>c.id).sort()}})
}
