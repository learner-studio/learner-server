import { describe,expect,test } from 'bun:test'
import { liveFeedbackContext,LearningFeedbackBeginPacket } from './learning-live-hook.js'

const packet={turnId:'11111111-1111-4111-8111-111111111111',catalogVersion:'catalog-v1',catalog:[{id:'http',title:'HTTP'}],instructions:'Record provisional evidence.',recentFeedback:[]}
describe('live Learning hook context',()=>{
  test('initial packet supplies catalog, evidence safeguards and submission identity',()=>{
    const output=liveFeedbackContext(packet,'session-a')
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    const text=output.hookSpecificOutput.additionalContext
    for(const required of ['http | HTTP','session-a',packet.turnId,'catalog-v1','--submit','pasted outside explanations','zero or more than five','never a future planned lesson','Never assign mastery percentages']) expect(text).toContain(required)
  })
  test('acknowledged catalog is omitted while fallback remains discoverable',()=>{
    const text=liveFeedbackContext({...packet,catalog:null},'session-a').hookSpecificOutput.additionalContext
    expect(text).not.toContain('http | HTTP')
    expect(text).toContain('previously supplied catalog')
    expect(text).toContain('--catalog')
    expect(text).toContain('never discard or redirect')
  })
  test('malformed turn packets cannot become hook context',()=>{
    expect(LearningFeedbackBeginPacket.safeParse({...packet,turnId:'bad'}).success).toBe(false)
    expect(LearningFeedbackBeginPacket.safeParse({...packet,catalog:[{id:'http'}]}).success).toBe(false)
  })
  test('recent context omits stored evidence text and older records',()=>{
    const recentFeedback=Array.from({length:4},(_,i)=>({turnId:`turn-${i}`,matches:[{conceptId:'http',outcome:'partial',remainingGap:'status',quote:'PRIVATE_LONG_QUOTE',reason:'PRIVATE_LONG_REASON'}],taughtConceptIds:[]}))
    const parsed=LearningFeedbackBeginPacket.parse({...packet,recentFeedback})
    const text=liveFeedbackContext(parsed,'session-a').hookSpecificOutput.additionalContext
    expect(text).not.toContain('PRIVATE_LONG_QUOTE')
    expect(text).not.toContain('PRIVATE_LONG_REASON')
    expect(text).not.toContain('turn-3')
    expect(text).toContain('turn-2')
  })
})
