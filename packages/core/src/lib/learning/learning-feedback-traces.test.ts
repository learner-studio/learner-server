import { createHash } from 'node:crypto'
import { describe,it,expect } from 'bun:test'
import { LearningFeedbackTraceInput,feedbackTraceBatch } from './learning-feedback-traces.js'
const prompt='Exact injected instruction and catalog'
const input={sessionId:'claude-session',turnId:'00000000-0000-4000-8000-000000000001',phase:'injection' as const,promptRevision:'task-teaching-v2' as const,catalogVersion:'a'.repeat(64),promptHash:createHash('sha256').update(prompt).digest('hex'),injectedPrompt:prompt,message:'Human message'}
describe('Learning exact hook trace projection',()=>{
  it('labels the v1 cohort on existing events without adding traces or generations',()=>{
    const prior=feedbackTraceBatch(input.turnId,'owner',input,'2026-09-07T00:00:00.000Z')
    const tagged=feedbackTraceBatch(input.turnId,'owner',LearningFeedbackTraceInput.parse({...input,outcomeVersion:'v1'}),'2026-09-07T00:00:00.000Z')
    expect(tagged.traceId).toBe(prior.traceId)
    expect(tagged.events).toHaveLength(1)
    expect(tagged.events[0]!.id).toBe(prior.events[0]!.id)
    expect(tagged.events[0]!.body).toMatchObject({tags:expect.arrayContaining(['v1','learning-outcomes-v1','task-teaching-v2']),metadata:{outcomeVersion:'v1',outcomeUnit:'sessionId+turnId',nativeAssistantResponseIncluded:false}})
    expect(tagged.totals).toEqual({generations:0,inputTokens:0,outputTokens:0})
    expect(JSON.stringify(prior.events)).not.toContain('learning-outcomes-v1')
    expect(LearningFeedbackTraceInput.safeParse({...input,outcomeVersion:'v2'}).success).toBe(false)
    const revised=feedbackTraceBatch(input.turnId,'owner',LearningFeedbackTraceInput.parse({...input,outcomeVersion:'v1.2'}),'2026-09-07T00:00:00.000Z')
    expect((revised.events[0]!.body as {tags:string[]}).tags).not.toContain('v1')
    expect(revised.events[0]!.body).toMatchObject({tags:expect.arrayContaining(['v1.2','learning-outcomes-v1.2'])})
    const foundations=feedbackTraceBatch(input.turnId,'owner',LearningFeedbackTraceInput.parse({...input,outcomeVersion:'v1.3'}),'2026-09-07T00:00:00.000Z')
    expect(foundations.events[0]!.body).toMatchObject({tags:expect.arrayContaining(['v1.3','learning-outcomes-v1.3'])})
    const traversal=feedbackTraceBatch(input.turnId,'owner',LearningFeedbackTraceInput.parse({...input,outcomeVersion:'v1.4'}),'2026-09-07T00:00:00.000Z')
    expect(traversal.events[0]!.body).toMatchObject({tags:expect.arrayContaining(['v1.4','learning-outcomes-v1.4','weakest lesson prerequisite in prompt'])})
  })
  it('rejects prompt hash mismatch, guessed revisions and extra fields',()=>{
    expect(LearningFeedbackTraceInput.safeParse(input).success).toBe(true)
    expect(LearningFeedbackTraceInput.safeParse({...input,injectedPrompt:'changed'}).success).toBe(false)
    expect(LearningFeedbackTraceInput.safeParse({...input,promptRevision:'old'}).success).toBe(false)
    expect(LearningFeedbackTraceInput.safeParse({...input,extra:true}).success).toBe(false)
  })
  it('submission requires both exact feedback and returned guidance',()=>{
    expect(LearningFeedbackTraceInput.safeParse({...input,phase:'submission'}).success).toBe(false)
    expect(LearningFeedbackTraceInput.safeParse({...input,phase:'submission',feedback:{matches:[]},guidance:{decision:'no_context'}}).success).toBe(true)
  })
  it('exports only phase spans, exact I/O and provenance without fabricated model usage',()=>{
    const batch=feedbackTraceBatch(input.turnId,'owner',input,'2026-09-06T00:00:00.000Z')
    expect(batch.events).toHaveLength(1)
    const event=batch.events[0]!
    expect(event.type).toBe('trace-create')
    if(event.type!=='trace-create') throw new Error('Expected a trace span')
    expect(event.body.input).toEqual({message:input.message,injectedPrompt:prompt})
    expect(event.body.metadata?.coverage).toBe('hook-feedback-io-only')
    expect(event.body.metadata?.modelUsage).toBe('not-observed')
    expect(JSON.stringify(event)).not.toContain('usageDetails')
  })
})
