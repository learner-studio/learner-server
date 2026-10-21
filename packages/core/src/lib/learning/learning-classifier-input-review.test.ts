import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { reviewClassifierInputs } from './learning-classifier-input-review.js'
import { classifierV6Prompt } from './learning-classifier-v6.js'
import type { BenchmarkCaseSnapshot } from './learning-extraction-benchmark.js'

const snapshot: BenchmarkCaseSnapshot = {
  current: { id:'u', threadId:'t', exchangeId:'e', agent:'Codex', provider:'openai', role:'user', authorship:'human', authorshipEvidence:'fixture', text:'Explain queues.', timestamp:'2026-09-05', model:null, cwd:null },
  context:[{id:'a',role:'assistant',text:'Prior answer.',timestamp:'2026-09-05'}],
  contextCompleteness:{assistantTurns:'partial',toolOutput:'unavailable',taskOutcome:'unavailable',receiptContext:'unavailable'},ontologyCandidateIds:[],
}
const cases=[{caseId:'one',snapshot}]
const prompt=classifierV6Prompt(cases)
const audit={attempt:1,batchId:'batch',caseIds:['one'],promptHash:createHash('sha256').update(prompt).digest('hex')}
test('input review returns the complete hash-verified prompt and role-separated batch payload',()=>{
  const [review]=reviewClassifierInputs({attemptAudit:[audit]},cases)
  assert(review)
  assert.equal(review.verification,'hash-verified-reconstruction')
  assert.equal(review.prompt,prompt)
  assert.deepEqual(review.conversationPayload,[{caseId:'one',precedingConversation:[{role:'assistant',text:'Prior answer.'}],currentLearnerMessage:'Explain queues.'}])
})
test('input review does not present a changed prompt as historical input',()=>{
  const [review]=reviewClassifierInputs({attemptAudit:[{...audit,promptHash:'changed'}]},cases)
  assert(review)
  assert.equal(review.verification,'unavailable');assert.equal(review.prompt,null)
})
test('input review refuses missing cases and unrecorded retry feedback',()=>{
  for(const entry of [{...audit,caseIds:['missing']},{...audit,attempt:2}]){
    const [review]=reviewClassifierInputs({attemptAudit:[entry]},cases)
    assert(review)
    assert.equal(review.verification,'unavailable');assert.equal(review.conversationPayload,null)
  }
})
test('recorded prompts survive template drift but never bypass digest verification',()=>{
  const recorded='Historical prompt including correction feedback.'
  const entry={...audit,attempt:2,prompt:recorded,promptHash:createHash('sha256').update(recorded).digest('hex')}
  const [review]=reviewClassifierInputs({attemptAudit:[entry]},cases)
  assert.equal(review?.verification,'hash-verified-recorded')
  assert.equal(review?.prompt,recorded)
  const [tampered]=reviewClassifierInputs({attemptAudit:[{...entry,prompt:recorded+' altered'}]},cases)
  assert.equal(tampered?.verification,'unavailable')
})
