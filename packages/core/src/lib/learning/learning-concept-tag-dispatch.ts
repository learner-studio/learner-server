import {mapWithConcurrency} from '../map-with-concurrency.js'
import {tagHash,type TagArm} from './learning-concept-tag-experiment.js'
import type {TagStoredRun} from '../../services/learning-concept-tag-store.js'
type Job={runId:string;caseId:string;arm:TagArm;jobKey:string}
/** Admission only: real execution remains native queue work, fenced by its frozen tier. */
export async function enqueueTagPlan(row:TagStoredRun,enqueue:(job:Job)=>Promise<string>){
 const jobs:Job[]=[]
 for(const c of row.manifest.cases){const arms=[...row.manifest.arms];if(parseInt(tagHash([row.run_id,c.id]).slice(0,2),16)%2)arms.reverse();for(const arm of arms)jobs.push({runId:row.run_id,caseId:c.id,arm,jobKey:`${row.run_id}:${c.id}:${arm}`})}
 // Imported predictions consume no provider budget; do not let them occupy the initial Jev slots.
 if(row.manifest.historical)jobs.sort((a,b)=>Number(b.arm==='jev-live')-Number(a.arm==='jev-live'))
 const concurrency=row.manifest.historical?.budget.concurrency??1
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>5)throw new Error('Invalid frozen dispatch concurrency')
 return mapWithConcurrency(jobs,concurrency,enqueue)
}
