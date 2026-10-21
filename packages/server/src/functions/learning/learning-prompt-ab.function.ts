import {defineFunction,defineSessionlessFunction} from '../../runtime/define.js'
import {z} from 'zod'
import {metaDbQuery as q,metaDbWithClient} from '@learner/core/lib/db-metadata/_shared.js'
import {assertLearningLocalMvpEnabled} from '@learner/core/lib/runtime-flags.js'
import {ASSESSMENT_MODEL} from '@learner/core/lib/learning/learning-concept-assessment.js'
import {breadcrumbPrompt,promptAbHash,promptAbId,seededConceptSample} from '@learner/core/lib/learning/learning-prompt-ab.js'
import {setupPromptAbDataset,exportPromptAbItem,finalizePromptAbLangfuse} from '@learner/core/lib/learning/learning-prompt-ab-langfuse.js'

export const PromptAbRun=z.object({runId:z.string().uuid()})
export const PromptAbStart=PromptAbRun.extend({seed:z.string().min(1).max(100)})
export const PromptAbItem=PromptAbRun.extend({assessmentRunId:z.string().uuid(),jobKey:z.string()})
export const PromptAbResult=z.object({runId:z.string(),status:z.string()})
export const PromptAbJobs=z.object({jobIds:z.array(z.string())})
export const PromptAbJob=z.object({jobId:z.string()})
export const PromptAbAny=z.record(z.string(),z.unknown())

export const startLearningPromptAb=defineFunction({title:'Freeze Consolidator v2 paired sample and start native experiment',expose:true,scopes:['admin'],input:PromptAbStart,output:PromptAbResult,
  func:async({learningCurriculumStore,locks,workflowService},data,{session,rpc})=>{
    assertLearningLocalMvpEnabled()
    return locks.withLock('learning-prompt-ab',data.runId,async()=>{
      const existing=(await q('SELECT user_id,seed FROM learning_consolidator_prompt_experiments WHERE run_id=$1',[data.runId])).rows[0]
      if(existing&&(existing.user_id!==session.userId||existing.seed!==data.seed)) throw new Error('Experiment identity conflict')
      if(!existing) {
        const graphs=await learningCurriculumStore.listGraphs()
        const concepts=new Map(graphs.flatMap(g=>g.concepts).map(c=>[c.id,c]))
        const files=[
          'packages/core/src/lib/learning/learning-prompt-ab.ts',
          'packages/core/src/lib/learning/learning-prompt-ab-langfuse.ts',
          'packages/core/src/lib/learning/learning-gradual-assessment.ts',
          'packages/core/src/services/learning-concept-assessment.ts',
          'packages/server/src/functions/learning/learning-prompt-ab.function.ts',
          'packages/server/src/wirings/learning-prompt-ab.workflow.ts',
          'packages/server/src/wiring/queues.ts',
          'packages/harness/src/langfuse-export.ts',
        ]
        const codeFiles=Object.fromEntries(await Promise.all(files.map(async path=>[path,await Bun.file(path).text()])))
        const git=Bun.spawn(['git','rev-parse','HEAD'],{stdout:'pipe',stderr:'ignore'})
        const gitRevision=(await new Response(git.stdout).text()).trim()
        if(await git.exited!==0)throw new Error('Cannot freeze Git identity')
        await metaDbWithClient(async client=>{
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
          try {
            const rows=(await client.query(`SELECT DISTINCT ON(concept_id) run_id,concept_id,snapshot,node_version FROM learning_concept_assessment_runs a
              WHERE user_id=$1 AND concept_id=ANY($2::text[])
              AND NOT EXISTS(SELECT 1 FROM learning_consolidator_prompt_experiments e WHERE e.run_id::text=a.snapshot->>'experimentId')
              ORDER BY concept_id,created_at DESC,run_id`,[session.userId,[...concepts.keys()]])).rows
            if(rows.length<50)throw new Error('Need at least 50 concepts with saved assessment inputs')
            // withClient uses the application's CamelCasePlugin; unlike q(),
            // its top-level result keys are camelCase.
            const chosen=seededConceptSample(rows.map(r=>r.conceptId),data.seed)
            const items=[]
            for(const [ordinal,conceptId]of chosen.entries()) {
              const source=rows.find(r=>r.conceptId===conceptId)!
              const title=concepts.get(conceptId)!.title
              const breadcrumbs=graphs.flatMap(g=>g.curriculum.modules.filter(m=>m.conceptIds.includes(conceptId)).map(m=>{
                const path=[m.title];const seen=new Set([m.id]);let parent=m.parentId
                while(parent){const p=g.curriculum.modules.find(x=>x.id===parent);if(!p||seen.has(p.id))throw new Error('Invalid curriculum breadcrumb');seen.add(p.id);path.unshift(p.title);parent=p.parentId}
                return [g.curriculum.title,...path,title]
              }))
              const snap=source.snapshot
              if(!Array.isArray(snap.evidence)||!snap.context?.nodeStates||typeof snap.prompt!=='string')throw new Error('Malformed frozen assessment source')
              const nodeIds=snap.context.nodeStates.map((n:{conceptId:string})=>n.conceptId)
              if(nodeIds.length!==1||nodeIds[0]!==conceptId)throw new Error('Expected exactly one matching source node')
              const baselineRunId=promptAbId(data.runId,conceptId,'old')
              const treatmentRunId=promptAbId(data.runId,conceptId,'new')
              const inputHash=promptAbHash({evidence:snap.evidence,prior:snap.prior,nodeStates:snap.context.nodeStates,schema:snap.schema})
              for(const arm of ['old','new'] as const){
                const id=arm==='old'?baselineRunId:treatmentRunId
                const prompt=arm==='old'?snap.prompt:breadcrumbPrompt(snap.prompt,breadcrumbs)
                const snapshot={...snap,prompt,experimentId:data.runId,model:ASSESSMENT_MODEL,promptRevision:arm==='old'?snap.promptRevision:'curriculum-grounded-v1',indexStartedAt:new Date().toISOString()}
                await client.query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot)
                  VALUES($1,$2,$1,$3,$4,$5,$6::jsonb)`,[id,session.userId,conceptId,source.nodeVersion,promptAbHash([data.runId,arm,inputHash,prompt]),JSON.stringify(snapshot)])
              }
              items.push({conceptId,title,ordinal,sourceRunId:source.runId,inputHash,breadcrumbs,baselineRunId,treatmentRunId})
            }
            const manifest={name:`Consolidator v2 — 50 concepts · ${data.runId.slice(0,8)}`,description:'Added curriculum breadcrumbs, explicit learning-objective scope and citation-grounding instructions. Matcher, evidence, prior state, model and output schema unchanged. Uniform seeded random 50 from all current concepts with saved assessment inputs; frozen latest saved input per concept, not a fresh retrieval. No live mastery writes.',seed:data.seed,eligibleConcepts:rows.length,items,model:ASSESSMENT_MODEL,concurrency:9,code:{gitRevision,sourceHash:promptAbHash(codeFiles),files:codeFiles}}
            await client.query('INSERT INTO learning_consolidator_prompt_experiments(run_id,user_id,seed,manifest) VALUES($1,$2,$3,$4::jsonb)',[data.runId,session.userId,data.seed,JSON.stringify(manifest)])
            await client.query('COMMIT')
          }catch(error){await client.query('ROLLBACK');throw error}
        })
      }
      const previous=await q("SELECT 1 FROM learner_workflow_runs WHERE workflow='learningPromptAbWorkflow' AND input::jsonb->>'runId'=$1",[data.runId])
      if(!previous.rowCount)await workflowService.startWorkflow('learningPromptAbWorkflow',{runId:data.runId},{type:'http',userId:session.userId},rpc)
      return {runId:data.runId,status:'started'}
    })
  },
})
export const getLearningPromptAb=defineFunction({expose:true,readonly:true,scopes:['admin'],input:PromptAbRun,output:PromptAbAny,
  func:async({},data,{session})=>{
    const row=(await q('SELECT * FROM learning_consolidator_prompt_experiments WHERE run_id=$1 AND user_id=$2',[data.runId,session.userId])).rows[0]
    if(!row)throw new Error('Experiment not found')
    const receipts=(await q(`SELECT a.run_id,a.concept_id,r.receipt,r.completed_at FROM learning_concept_assessment_runs a
      LEFT JOIN learning_concept_assessment_receipts r USING(run_id) WHERE a.snapshot->>'experimentId'=$1`,[data.runId])).rows
    const {files:_,...code}=row.manifest.code
    return {runId:data.runId,status:row.status,manifest:{...row.manifest,code},summary:row.summary,receipts}
  },
})
export const setupLearningPromptAbStep=defineSessionlessFunction({input:PromptAbRun,output:PromptAbAny,func:async({},data)=>setupPromptAbDataset(data.runId)})
export const exportLearningPromptAbStep=defineSessionlessFunction({input:PromptAbItem,output:PromptAbAny,func:async({},data)=>exportPromptAbItem(data.runId,data.assessmentRunId)})
export const finalizeLearningPromptAbStep=defineSessionlessFunction({input:PromptAbRun,output:PromptAbAny,func:async({},data)=>finalizePromptAbLangfuse(data.runId)})

export const enqueueLearningPromptAbStep=defineSessionlessFunction({input:PromptAbRun,output:PromptAbJobs,
  func:async({queueService,queueCancellationService,locks},data)=>{
    const row=(await q('SELECT manifest FROM learning_consolidator_prompt_experiments WHERE run_id=$1',[data.runId])).rows[0]
    if(!row)throw new Error('Missing frozen experiment')
    const ids:string[]=[]
    // Interleave each pair, randomizing which arm goes first. One shared group
    // and one nine-worker queue cap both arms together, not nine per arm.
    for(const item of row.manifest.items){
      const pair=[item.baselineRunId,item.treatmentRunId]
      if(parseInt(promptAbHash([row.manifest.seed,item.conceptId]).slice(0,2),16)%2)pair.reverse()
      for(const assessmentRunId of pair){
        const jobKey=`${data.runId}:${assessmentRunId}`
        const id=await locks.withLock('learning-prompt-ab-enqueue',jobKey,async()=>{
          const old=await queueCancellationService.findByKey('learning.prompt-ab',jobKey)
          if(old.length>1)throw new Error('Duplicate paired assessment jobs')
          return old[0]?.id??queueService.add('learning.prompt-ab',{runId:data.runId,assessmentRunId,jobKey},{jobId:jobKey,attempts:2,backoff:{type:'fixed',delay:1000},group:{id:data.runId,tier:'9'}})
        })
        ids.push(id)
      }
    }
    await q("UPDATE learning_consolidator_prompt_experiments SET status='running' WHERE run_id=$1",[data.runId])
    return {jobIds:ids}
  },
})
export const waitLearningPromptAbJobStep=defineSessionlessFunction({input:PromptAbJob,output:PromptAbAny,
  func:async({queueService},data)=>{
    const job=await queueService.getJob('learning.prompt-ab',data.jobId)
    if(!job?.waitForCompletion)throw new Error('Native job observer unavailable')
    try{await job.waitForCompletion(21600000);return {status:'completed'}}catch(error){if(await job.status()==='failed')return {status:'failed'};throw error}
  },
})
export const learningPromptAbQueue=defineSessionlessFunction({input:PromptAbItem,output:PromptAbResult,
  func:async({workflowService,locks},data,{rpc})=>locks.withLock('learning-prompt-ab-child',data.jobKey,async()=>{
    const prior=(await q("SELECT workflow_run_id,status FROM learner_workflow_runs WHERE workflow='learningPromptAbItemWorkflow' AND input::jsonb->>'jobKey'=$1 ORDER BY created_at LIMIT 1",[data.jobKey])).rows[0]
    let id:string
    if(prior){id=prior.workflow_run_id;if(prior.status!=='completed')await workflowService.runWorkflowJob(id,rpc)}
    else id=(await workflowService.startWorkflow('learningPromptAbItemWorkflow',data,{type:'internal'},rpc,{inline:true})).runId
    if((await workflowService.getRun(id))?.status!=='completed')throw new Error('Paired assessment child not completed; inspect original receipt')
    return {runId:data.runId,status:'completed'}
  }),
})
