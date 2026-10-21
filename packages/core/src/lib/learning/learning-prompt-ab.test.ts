import {describe,test,expect} from 'bun:test'
import {seededConceptSample,breadcrumbPrompt,promptAbId,blindAssessmentPrompt,blindAssessmentNodes} from './learning-prompt-ab.js'
describe('paired curriculum prompt experiment',()=>{
  test('prior blinding removes entire derived state without editing raw evidence',()=>{
    const nodes=[{conceptId:'test',nodeVersion:'v',understandingPercent:65,assessment:{understandingPercent:65,demonstrated:[{quote:'prior quote'}]}}]
    const evidence=[{role:'user',text:'I estimate 65 percent. This is original evidence.'}]
    const prompt=`Instructions\n\nINPUT:\n${JSON.stringify({nodeStates:nodes,evidence,nativeObservations:[]})}`
    const blinded=blindAssessmentPrompt(prompt)
    const input=JSON.parse(blinded.split('\n\nINPUT:\n')[1]!)
    expect(input.nodeStates).toEqual([{conceptId:'test',nodeVersion:'v'}])
    expect(input.nodeStates).toEqual(blindAssessmentNodes(nodes))
    expect(input.evidence).toEqual(evidence)
    expect(blinded).not.toContain('prior quote')
    expect(nodes[0]!.assessment.understandingPercent).toBe(65)
  })
  test('seeded sample is reproducible, unique and independent of catalog ordering',()=>{
    const ids=Array.from({length:664},(_,i)=>`concept-${i}`)
    const a=seededConceptSample(ids,'seed-a')
    expect(a).toHaveLength(50)
    expect(new Set(a).size).toBe(50)
    expect(a).toEqual(seededConceptSample([...ids].reverse(),'seed-a'))
    expect(a).not.toEqual(seededConceptSample(ids,'seed-b'))
  })
  test('treatment changes educational context, not evidence/prior/output IDs',()=>{
    const input={nodeStates:[{conceptId:'event',nodeVersion:'abc',assessment:{understandingPercent:20}}],evidence:[{role:'user',text:'calendar events'}],nativeObservations:[]}
    const old=`Old contract\n\nINPUT:\n${JSON.stringify(input)}`
    const prompt=breadcrumbPrompt(old,[['Web','Browser','DOM events']])
    const actual=JSON.parse(prompt.split('\n\nINPUT:\n')[1]!)
    expect(actual.evidence).toEqual(input.evidence)
    expect(actual.nodeStates[0].assessment).toEqual(input.nodeStates[0]!.assessment)
    expect(actual.nodeStates[0].conceptId).toBe('event')
    expect(actual.nodeStates[0].breadcrumbs).toEqual([['Web','Browser','DOM events']])
    expect(prompt).toContain('Unrelated material must neither increase nor decrease')
    expect(()=>breadcrumbPrompt(old,[])).toThrow()
    expect(promptAbId('run','old','event')).not.toBe(promptAbId('run','new','event'))
  })
})
