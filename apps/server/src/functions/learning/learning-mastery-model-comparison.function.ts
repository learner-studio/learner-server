import {defineFunction,defineSessionlessFunction} from '../../runtime/define.js'
import {z} from 'zod'
import {metaDbQuery as q,metaDbWithClient} from '@learner/core/lib/db-metadata/_shared.js'
import {assertLearningLocalMvpEnabled} from '@learner/core/lib/runtime-flags.js'
import {buildConceptAssessmentInput,type AssessmentSource} from '@learner/core/lib/learning/learning-concept-assessment.js'
import {GRADUAL_ASSESSMENT_REVISION} from '@learner/core/lib/learning/learning-gradual-assessment.js'
import {conceptFromGraphs} from '@learner/core/services/learning-concept-assessment.js'
import {promptAbHash,promptAbId,seededConceptSample} from '@learner/core/lib/learning/learning-prompt-ab.js'
import {trimEvidenceNewestFirst} from '@learner/core/lib/learning/learning-evidence-budget.js'
import {CHARS_PER_TOKEN,MASTERY_AB_ARMS,MASTERY_AB_CONCURRENCY,MASTERY_AB_KIND,MASTERY_AB_MODELS,MASTERY_AB_QUEUES,jevEvidenceBudget,jevMasteryRequest} from '@learner/core/lib/learning/learning-mastery-model-comparison.js'
import {finalizeMasteryAb,labelMasteryAbReference,masteryAbExperiment,setupMasteryAbDataset,type MasteryAbItem,type MasteryAbManifest} from '@learner/core/lib/learning/learning-mastery-model-comparison-langfuse.js'

export const MasteryAbRun=z.object({runId:z.string().uuid()})
export const MasteryAbStart=MasteryAbRun.extend({seed:z.string().min(1).max(100),sampleSize:z.number().int().min(1).max(50).default(50),
  // Replay a completed run's workflow (free: receipts exist, exports are ledgered) to re-score and re-summarize it.
  refinalize:z.boolean().default(false)})
export const MasteryAbArm=MasteryAbRun.extend({arm:z.enum(MASTERY_AB_ARMS)})
export const MasteryAbJobs=z.object({jobIds:z.array(z.string())})
export const MasteryAbJob=z.object({arm:z.enum(MASTERY_AB_ARMS),jobId:z.string()})
export const MasteryAbWork=z.object({runId:z.string().uuid(),arm:z.enum(MASTERY_AB_ARMS),assessmentRunId:z.string().uuid()})
export const MasteryAbAny=z.record(z.string(),z.unknown())
const LABEL_STATUS='agent-reference:claude-opus-5-5 (not human gold)'
const CODE_FILES=[
  'packages/core/src/lib/learning/learning-evidence-budget.ts',
  'packages/core/src/lib/learning/learning-mastery-model-comparison.ts',
  'packages/core/src/lib/learning/learning-mastery-model-comparison-langfuse.ts',
  'packages/core/src/lib/learning/learning-gradual-assessment.ts',
  'packages/core/src/services/learning-concept-assessment.ts',
  'packages/llm/src/services/typesafe-decision-service.ts',
  'apps/server/src/functions/learning/learning-mastery-model-comparison.function.ts',
  'apps/server/src/wirings/learning-mastery-model-comparison.workflow.ts',
  'apps/server/src/wiring/queues.ts',
]

export const startLearningMasteryModelComparison=defineFunction({title:'Freeze a mastery model comparison (Claude reference, Flash, Jev) and start it',expose:true,scopes:['admin'],input:MasteryAbStart,output:MasteryAbAny,
  func:async({learningCurriculumStore,locks,workflowService},data,{session,rpc})=>{
    assertLearningLocalMvpEnabled()
    return locks.withLock('learning-mastery-ab',data.runId,async()=>{
      const existing=(await q('SELECT user_id,seed,manifest FROM learning_consolidator_prompt_experiments WHERE run_id=$1',[data.runId])).rows[0]
      if(existing&&(existing.user_id!==session.userId||existing.seed!==data.seed||existing.manifest?.kind!==MASTERY_AB_KIND||existing.manifest?.sampleSize!==data.sampleSize)) throw new Error('Experiment identity conflict')
      let skipped:Array<{conceptId:string;reason:string}>=existing?.manifest?.skipped??[]
      if(!existing) {
        const graphs=await learningCurriculumStore.listGraphs()
        const current=new Set(graphs.flatMap(g=>g.concepts.map(c=>c.id)))
        const codeFiles=Object.fromEntries(await Promise.all(CODE_FILES.map(async path=>[path,await Bun.file(path).text()])))
        const git=Bun.spawn(['git','rev-parse','HEAD'],{stdout:'pipe',stderr:'ignore'})
        const gitRevision=(await new Response(git.stdout).text()).trim()
        if(await git.exited!==0)throw new Error('Cannot freeze Git identity')
        await metaDbWithClient(async client=>{
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
          try {
            // Eligible pool: concepts the live assessor has already scored for this owner.
            const rows=(await client.query(`SELECT DISTINCT ON(a.concept_id) a.run_id,a.concept_id,a.snapshot->'evidence' AS evidence FROM learning_concept_assessment_runs a
              JOIN learning_concept_assessment_cache c ON c.user_id=a.user_id AND c.concept_id=a.concept_id AND c.assessment->>'understandingPercent' IS NOT NULL
              WHERE a.user_id=$1 AND jsonb_typeof(a.snapshot->'evidence')='array'
              AND NOT EXISTS(SELECT 1 FROM learning_consolidator_prompt_experiments e WHERE e.run_id::text=a.snapshot->>'experimentId')
              ORDER BY a.concept_id,a.created_at DESC,a.run_id`,[session.userId])).rows as Array<{runId:string;conceptId:string;evidence:AssessmentSource[]}>
            const byConcept=new Map(rows.filter(r=>current.has(r.conceptId)).map(r=>[r.conceptId,r]))
            const items:MasteryAbItem[]=[]
            skipped=[]
            for(const conceptId of seededConceptSample([...byConcept.keys()],data.seed,byConcept.size)){
              if(items.length===data.sampleSize)break
              const source=byConcept.get(conceptId)!,concept=conceptFromGraphs(graphs,conceptId),budget=jevEvidenceBudget(concept)
              const trimmed=trimEvidenceNewestFirst(source.evidence,{maxTokens:budget.maxEvidenceTokens,charsPerToken:CHARS_PER_TOKEN})
              if(!trimmed.kept.some(e=>e.role==='user'&&e.text.trim())){skipped.push({conceptId,reason:'no human message survives the evidence budget'});continue}
              const inputHash=promptAbHash({concept,evidence:trimmed.kept})
              const built=buildConceptAssessmentInput(concept,trimmed.kept,null)
              const runIds=Object.fromEntries(MASTERY_AB_ARMS.map(arm=>[arm,promptAbId(data.runId,conceptId,arm)])) as MasteryAbItem['runIds']
              for(const arm of MASTERY_AB_ARMS){
                const jev=arm==='jev'
                const snapshot={...built,prompt:jev?JSON.stringify(jevMasteryRequest(concept,trimmed.kept)):built.prompt,evidence:trimmed.kept,prior:null,experimentId:data.runId,
                  model:MASTERY_AB_MODELS[arm],promptRevision:jev?'jev-score-mastery-v1':GRADUAL_ASSESSMENT_REVISION,indexStartedAt:new Date().toISOString(),
                  provenance:{origin:'mastery-model-comparison',sourceRunId:source.runId,trimRule:trimmed.rule,droppedIds:trimmed.droppedIds}}
                await client.query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot) VALUES($1,$2,$1,$3,$4,$5,$6::jsonb)`,
                  [runIds[arm],session.userId,conceptId,built.nodeVersion,promptAbHash([data.runId,arm,inputHash]),JSON.stringify(snapshot)])
              }
              items.push({conceptId,title:concept.title,ordinal:items.length,sourceRunId:source.runId,inputHash,runIds,trim:{kept:trimmed.kept.length,dropped:trimmed.droppedIds.length,estimatedTokens:trimmed.estimatedTokens,maxEvidenceTokens:budget.maxEvidenceTokens}})
            }
            if(items.length<data.sampleSize)throw new Error(`Only ${items.length} eligible concepts after trimming; ${data.sampleSize} requested`)
            const manifest:MasteryAbManifest&{skipped:typeof skipped;eligiblePool:number;trim:unknown}={kind:MASTERY_AB_KIND,
              name:`Mastery reference — Jev vs Flash · ${data.runId}`,
              description:`Seeded random ${data.sampleSize} of ${byConcept.size} concepts the live assessor has scored. Evidence frozen from each concept's latest saved assessment input, trimmed newest-first (whole messages) to Jev's 32k-token cap and identical for all arms. Claude Opus 5.5 labels are agent reference labels, NOT human gold. Flash = production assessor; Jev = one 6-level score question with the production rubric. No live mastery writes.`,
              seed:data.seed,sampleSize:data.sampleSize,eligiblePool:byConcept.size,labelStatus:LABEL_STATUS,models:MASTERY_AB_MODELS as unknown as MasteryAbManifest['models'],concurrency:MASTERY_AB_CONCURRENCY,
              trim:{rule:'newest-first-whole-items-v1',charsPerToken:CHARS_PER_TOKEN},skipped,
              code:{gitRevision,sourceHash:promptAbHash(codeFiles),files:codeFiles},items}
            await client.query('INSERT INTO learning_consolidator_prompt_experiments(run_id,user_id,seed,manifest) VALUES($1,$2,$3,$4::jsonb)',[data.runId,session.userId,data.seed,JSON.stringify(manifest)])
            await client.query('COMMIT')
          }catch(error){await client.query('ROLLBACK');throw error}
        })
      }
      // A failed or cancelled run restarts, and `refinalize` replays a completed one: every step is idempotent
      // and paid calls are reserved once. A run still in flight is never doubled.
      const previous=(await q<{status:string}>("SELECT status FROM learner_workflow_runs WHERE workflow='learningMasteryModelComparisonWorkflow' AND input::jsonb->>'runId'=$1",[data.runId])).rows.map(r=>r.status)
      const live=previous.some(s=>!['failed','cancelled','completed'].includes(s)),done=previous.includes('completed')
      // Pollers must not read the previous summary as the refinalized one.
      if(!live&&done&&data.refinalize)await q("UPDATE learning_consolidator_prompt_experiments SET status='refinalizing' WHERE run_id=$1",[data.runId])
      if(!live&&(!done||data.refinalize))await workflowService.startWorkflow('learningMasteryModelComparisonWorkflow',{runId:data.runId},{type:'http',userId:session.userId},rpc)
      return {runId:data.runId,status:'started',skipped}
    })
  },
})
export const getLearningMasteryModelComparison=defineFunction({title:'Read a mastery model comparison and its receipts',expose:true,readonly:true,scopes:['admin'],input:MasteryAbRun,output:MasteryAbAny,
  func:async({},data,{session})=>{
    const row=(await q('SELECT * FROM learning_consolidator_prompt_experiments WHERE run_id=$1 AND user_id=$2',[data.runId,session.userId])).rows[0]
    if(!row||row.manifest?.kind!==MASTERY_AB_KIND)throw new Error('Experiment not found')
    const receipts=(await q(`SELECT a.run_id,a.concept_id,a.snapshot->'model'->>'backend' AS backend,r.receipt,r.completed_at FROM learning_concept_assessment_runs a
      LEFT JOIN learning_concept_assessment_receipts r USING(run_id) WHERE a.snapshot->>'experimentId'=$1 ORDER BY a.concept_id`,[data.runId])).rows
    const {files:_,...code}=row.manifest.code
    return {runId:data.runId,status:row.status,datasetId:row.dataset_id,manifest:{...row.manifest,code},summary:row.summary,receipts}
  },
})
export const setupMasteryAbStep=defineSessionlessFunction({input:MasteryAbRun,output:MasteryAbAny,func:async({},data)=>setupMasteryAbDataset(data.runId)})
export const labelMasteryAbReferenceStep=defineSessionlessFunction({input:MasteryAbRun,output:MasteryAbAny,func:async({},data)=>labelMasteryAbReference(data.runId)})
export const finalizeMasteryAbStep=defineSessionlessFunction({input:MasteryAbRun,output:MasteryAbAny,func:async({},data)=>finalizeMasteryAb(data.runId)})

export const enqueueMasteryAbArmStep=defineSessionlessFunction({input:MasteryAbArm,output:MasteryAbJobs,
  func:async({queueService,queueCancellationService,locks},data)=>{
    const row=await masteryAbExperiment(data.runId),queue=MASTERY_AB_QUEUES[data.arm],ids:string[]=[]
    for(const item of row.manifest.items){
      const assessmentRunId=item.runIds[data.arm],jobKey=`${data.runId}:${assessmentRunId}`
      ids.push(await locks.withLock('learning-mastery-ab-enqueue',jobKey,async()=>{
        const old=await queueCancellationService.findByKey(queue,jobKey)
        if(old.length>1)throw new Error('Duplicate mastery comparison jobs')
        return old[0]?.id??queueService.add(queue,{runId:data.runId,arm:data.arm,assessmentRunId},{jobId:jobKey,attempts:2,backoff:{type:'fixed',delay:1000},group:{id:`${data.runId}:${data.arm}`,tier:String(MASTERY_AB_CONCURRENCY[data.arm])}})
      }))
    }
    await q("UPDATE learning_consolidator_prompt_experiments SET status=$2 WHERE run_id=$1",[data.runId,`running_${data.arm}`])
    return {jobIds:ids}
  },
})
export const waitMasteryAbJobStep=defineSessionlessFunction({input:MasteryAbJob,output:MasteryAbAny,
  func:async({queueService},data)=>{
    const job=await queueService.getJob(MASTERY_AB_QUEUES[data.arm],data.jobId)
    if(!job?.waitForCompletion)throw new Error('Native job observer unavailable')
    try{await job.waitForCompletion(21600000);return {status:'completed'}}catch(error){if(await job.status()==='failed')return {status:'failed'};throw error}
  },
})
/** Single-shot worker, one per arm queue. `execute` is replay-safe: a receipt returns
 * as-is and a reservation without a receipt reports uncertain instead of paying twice. */
const executeMasteryAbWork=async(assessment:{execute(runId:string):Promise<Record<string,unknown>>},data:z.infer<typeof MasteryAbWork>,arm:string)=>{
  if(data.arm!==arm)throw new Error('Job arm does not match its queue')
  const owned=(await q("SELECT 1 FROM learning_concept_assessment_runs WHERE run_id=$1 AND snapshot->>'experimentId'=$2",[data.assessmentRunId,data.runId])).rowCount
  if(!owned)throw new Error('Assessment does not belong to this comparison')
  return assessment.execute(data.assessmentRunId)
}
export const learningMasteryAbReferenceQueue=defineSessionlessFunction({input:MasteryAbWork,output:MasteryAbAny,func:async({learningConceptAssessment},data)=>executeMasteryAbWork(learningConceptAssessment,data,'reference')})
export const learningMasteryAbFlashQueue=defineSessionlessFunction({input:MasteryAbWork,output:MasteryAbAny,func:async({learningConceptAssessment},data)=>executeMasteryAbWork(learningConceptAssessment,data,'flash')})
export const learningMasteryAbJevQueue=defineSessionlessFunction({input:MasteryAbWork,output:MasteryAbAny,func:async({learningConceptAssessment},data)=>executeMasteryAbWork(learningConceptAssessment,data,'jev')})
