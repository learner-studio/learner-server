import {test} from 'node:test'
import assert from 'node:assert/strict'
import {admitTagAudit} from './learning-concept-tag-audit-admission.js'
const job={runId:'r',caseId:'c',arm:'jev-live',jobKey:'r:c:jev-live'}
test('result path awaits a durable audit job, never a remote exporter',async()=>{
 const calls:any[]=[]
 const result=await admitTagAudit(job,{find:async()=>[],add:async(queue,data,options)=>{calls.push({queue,data,options});return 'audit-job'}})
 assert.equal(result.auditJobId,'audit-job');assert.equal(calls.length,1);assert.equal(calls[0].queue,'learning.concept-tag-audit');assert.equal(calls[0].options.attempts,3)
 assert.equal(calls[0].options.jobId,'audit:r:c:jev-live')
})
test('recovery adopts the same durable job including failed terminal state, never re-admits',async()=>{
 const result=await admitTagAudit(job,{find:async()=>[{id:'existing'}],add:async()=>{throw Error('must not add')}})
 assert.equal(result.auditJobId,'existing')
 await assert.rejects(admitTagAudit(job,{find:async()=>[{id:'a'},{id:'b'}],add:async()=>''}),/Duplicate/)
})
