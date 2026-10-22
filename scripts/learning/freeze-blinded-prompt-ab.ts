/** One atomic preparation transaction. Execution remains the existing
 * learningPromptAbWorkflow, with nine shared rolling slots and immutable receipts.
 * No model calls and no writes to live learner mastery occur in this command. */
import {metaDbQuery as q,metaDbWithClient} from '@learner/core/lib/db-metadata/_shared.js'
import {blindAssessmentNodes,blindAssessmentPrompt,promptAbHash,promptAbId} from '@learner/core/lib/learning/learning-prompt-ab.js'

import {openLearnerDatabase,usage} from './_db.js'
const [sourceRunId,runId]=process.argv.slice(2).filter(arg=>!arg.startsWith('-')) as [string,string]
usage(`
Usage: bun --env-file=/etc/learner/db.env scripts/learning/freeze-blinded-prompt-ab.ts SOURCE_UUID NEW_UUID
Run from the repository root. WRITES the learner database in one transaction:
freezes a prior-blind copy of a 50-concept consolidator prompt A/B experiment
(new assessment runs + experiment row) for learningPromptAbWorkflow to execute.
No model calls, no live mastery writes.`,!sourceRunId||!runId)
const handle=openLearnerDatabase({readOnly:false})
const original=(await q('SELECT * FROM learning_consolidator_prompt_experiments WHERE run_id=$1',[sourceRunId])).rows[0]
if(!original||original.manifest.items.length!==50)throw new Error('Missing original 50-concept experiment')
if((await q('SELECT 1 FROM learning_consolidator_prompt_experiments WHERE run_id=$1',[runId])).rowCount)throw new Error('Target already frozen; reuse existing run without mutation')
// The source manifest lists the previous host's paths; freeze the Learner files that define the experiment.
const paths=['packages/core/src/lib/learning/learning-prompt-ab.ts','packages/core/src/lib/learning/learning-prompt-ab-langfuse.ts','scripts/learning/freeze-blinded-prompt-ab.ts']
const files=Object.fromEntries(await Promise.all(paths.map(async path=>[path,await Bun.file(path).text()])))
const git=Bun.spawn(['git','rev-parse','HEAD'],{stdout:'pipe'})
const gitRevision=(await new Response(git.stdout).text()).trim()
if(await git.exited!==0)throw new Error('Cannot freeze Git revision')
const items:Array<Record<string,unknown>>=[]
const runs:Array<{id:string;conceptId:string;nodeVersion:string;inputHash:string;snapshot:Record<string,unknown>}>=[]
for(const item of original.manifest.items){
  const pair:Array<{id:string;inputHash:string}>=[]
  for(const arm of ['old','new']){
    const sourceId=arm==='old'?item.baselineRunId:item.treatmentRunId
    const source=(await q('SELECT * FROM learning_concept_assessment_runs WHERE run_id=$1',[sourceId])).rows[0]
    const snap=source.snapshot
    const prompt=blindAssessmentPrompt(snap.prompt)
    const context={...snap.context,nodeStates:blindAssessmentNodes(snap.context.nodeStates)}
    const snapshot={...snap,prompt,context,prior:null,experimentId:runId,indexStartedAt:new Date().toISOString()}
    const input=JSON.parse(prompt.split('\n\nINPUT:\n')[1]!)
    if(promptAbHash(input.evidence)!==promptAbHash(snap.evidence)||promptAbHash(snapshot.evidence)!==promptAbHash(snap.evidence))throw new Error('Raw evidence changed')
    if([...input.nodeStates,...context.nodeStates].some(n=>Object.hasOwn(n,'assessment')||Object.hasOwn(n,'understandingPercent')))throw new Error('Prior state leaked')
    const id=promptAbId(runId,item.conceptId,arm)
    const inputHash=promptAbHash({evidence:snapshot.evidence,prior:null,nodeStates:context.nodeStates,schema:snapshot.schema})
    snapshot.inputHash=inputHash
    runs.push({id,conceptId:source.concept_id,nodeVersion:source.node_version,inputHash,snapshot})
    pair.push({id,inputHash})
  }
  if(pair[0]!.inputHash!==pair[1]!.inputHash)throw new Error('Paired evidence/context/schema mismatch')
  items.push({...item,sourceExperimentId:sourceRunId,sourceBaselineRunId:item.baselineRunId,sourceTreatmentRunId:item.treatmentRunId,inputHash:pair[0]!.inputHash,baselineRunId:pair[0]!.id,treatmentRunId:pair[1]!.id})
}
const seed=`consolidator-v2-prior-blind-${runId.slice(0,8)}`
const manifest={...original.manifest,name:`Consolidator v2 prior-blind — 50 concepts · ${runId.slice(0,8)}`,description:'Prior-blind old versus breadcrumbs + learning objective + citation prompt. Same 50 concepts, original frozen raw conversation evidence, schema, model and nine rolling slots as the original Consolidator v2 experiment. Removed derived prior assessments and percentages from BOTH prompts and validation context. Original raw conversation text is untouched and can contain pasted/generated content; human-envelope role is not authorship proof. No live mastery writes.',seed,items,sourceExperimentId:sourceRunId,priorBlind:true,code:{gitRevision,sourceHash:promptAbHash(files),files}}
await metaDbWithClient(async client=>{
  await client.query('BEGIN')
  try{
    for(const r of runs)await client.query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot) VALUES($1,$2,$1,$3,$4,$5,$6::jsonb)`,[r.id,original.user_id,r.conceptId,r.nodeVersion,promptAbHash([runId,r.id,r.inputHash,r.snapshot.prompt]),JSON.stringify(r.snapshot)])
    await client.query('INSERT INTO learning_consolidator_prompt_experiments(run_id,user_id,seed,manifest) VALUES($1,$2,$3,$4::jsonb)',[runId,original.user_id,seed,JSON.stringify(manifest)])
    await client.query('COMMIT')
  }catch(error){await client.query('ROLLBACK');throw error}
})
console.log(JSON.stringify({runId,seed,sourceRunId,concepts:items.length,pairedInputs:runs.length,sourceHash:manifest.code.sourceHash,status:'prepared',modelCalls:0}))
await handle.close()
