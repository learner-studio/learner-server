import { describe,expect,test } from 'bun:test'
import { claudeLearningContext,LearningHookContextInput } from './learning-hook-context.js'
const packet={decision:'influence',context:'Review-only evidence',conceptIds:['a'],datasetTag:'dev1',experimentId:crypto.randomUUID(),
  foundationFirst:true,policyRevision:'foundation-first-v1',durationMs:20,requestId:crypto.randomUUID()}
describe('Claude Learning hook output',()=>{
  test('passes only model context in the documented hook envelope',()=>{
    expect(claudeLearningContext(packet)).toEqual({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:packet.context}})
  })
  test('no match, failure, malformed and oversize responses inject nothing',()=>{
    for(const value of [null,{}, {...packet,decision:'no_context'},{...packet,decision:'fail_open'},{...packet,context:'x'.repeat(4001)}]) expect(claudeLearningContext(value)).toEqual({})
  })
  test('one opt-in policy parameter, with bounded message input',()=>{
    expect(LearningHookContextInput.parse({message:'Explain HTTP',sessionId:'test',requestId:packet.requestId}).foundationFirst).toBe(false)
    expect(LearningHookContextInput.safeParse({message:'x'.repeat(6001),sessionId:'test',requestId:packet.requestId}).success).toBe(false)
  })
})
