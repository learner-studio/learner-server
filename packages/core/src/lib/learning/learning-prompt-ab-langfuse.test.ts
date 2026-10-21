import {describe,it,expect} from 'bun:test'
import {promptAbNativeIds,promptAbObservation,promptAbComparable,promptAbNativeJson} from './learning-prompt-ab-langfuse.js'
const item={conceptId:'http',title:'HTTP',ordinal:0,sourceRunId:'source',inputHash:'hash',breadcrumbs:[['CS','Web','HTTP']],baselineRunId:'old',treatmentRunId:'new'}
const row={run_id:'ab',dataset_id:'dataset',created_at:new Date('2026-09-07T12:00:00Z'),manifest:{name:'Consolidator v2',description:'paired',seed:'seed',code:{gitRevision:'git',sourceHash:'code',files:[]},items:[item],model:{model:'gemini',effort:'high'}}}
const run={run_id:'old',reserved_at:new Date('2026-09-07T12:00:00Z'),snapshot:{prompt:'original',schema:{type:'object'},evidence:[{role:'user',text:'exact'}],prior:null,context:{nodeStates:[]},model:{model:'gemini',effort:'high'},promptRevision:'old'},receipt:{status:'completed',assessment:{understandingPercent:null},raw:'{}',error:null,durationMs:1000,inputTokens:12,outputTokens:5,completedAt:'2026-09-07T12:00:01Z'}}
const attrs=(value:ReturnType<typeof promptAbObservation>)=>new Map(value.payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.map(a=>[a.key,a.value]))
describe('native prompt A/B Langfuse projection',()=>{
  it('shares dataset item across arms but separates observations and experiments',()=>{
    const a=promptAbNativeIds('ab',item,'baseline'),b=promptAbNativeIds('ab',item,'treatment')
    expect(a.datasetItemId).toBe(b.datasetItemId)
    expect(a.traceId).not.toBe(b.traceId)
    expect(a.experimentId).not.toBe(b.experimentId)
    expect(a.traceId).toMatch(/^[a-f0-9]{32}$/)
    expect(a.spanId).toMatch(/^[a-f0-9]{16}$/)
  })
  it('projects native experiment keys, exact input, actual usage and adapter duration',()=>{
    const projected=promptAbObservation(row,item,'baseline',run),a=attrs(projected)
    expect(a.get('langfuse.observation.type')).toEqual({stringValue:'generation'})
    expect(a.get('langfuse.experiment.dataset.id')).toEqual({stringValue:'dataset'})
    expect(a.get('langfuse.experiment.item.id')).toEqual({stringValue:projected.ids.datasetItemId})
    expect(a.get('langfuse.observation.usage_details')).toEqual({stringValue:'{"input":12,"output":5}'})
    expect(projected.input.prompt).toBe('original')
    const span=projected.payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    expect(BigInt(span.endTimeUnixNano)-BigInt(span.startTimeUnixNano)).toBe(1000000000n)
  })
  it('does not manufacture a paid generation for no evidence',()=>{
    const projected=promptAbObservation(row,item,'treatment',{...run,reserved_at:null,receipt:{...run.receipt,status:'no_evidence',inputTokens:null,outputTokens:null,durationMs:0}}),a=attrs(projected)
    expect(a.get('langfuse.observation.type')).toEqual({stringValue:'span'})
    expect(a.has('langfuse.observation.usage_details')).toBe(false)
    expect(a.has('langfuse.observation.model.name')).toBe(false)
  })
  it('preserves unknown usage and failed output rather than reporting zero',()=>{
    const projected=promptAbObservation(row,item,'baseline',{...run,receipt:{...run.receipt,status:'failed',inputTokens:null,outputTokens:null,error:'validation failure'}})
    expect(attrs(projected).get('langfuse.observation.usage_details')).toEqual({stringValue:'{}'})
    expect(projected.output.status).toBe('failed')
    expect(projected.payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status.code).toBe(2)
  })
  it('readback equality ignores JSON object order but not array order or content',()=>{
    expect(promptAbComparable({a:1,b:[2,3]})).toBe(promptAbComparable({b:[2,3],a:1}))
    expect(promptAbComparable({b:[2,3]})).not.toBe(promptAbComparable({b:[3,2]}))
  })
  it('decodes v4 native I/O strings once without transforming nested prompt bytes',()=>{
    const input={prompt:'{"quoted":"exact"}',evidence:[{text:'source'}]}
    expect(promptAbNativeJson(JSON.stringify(input))).toEqual(input)
    expect(promptAbNativeJson(input)).toBe(input)
    expect(()=>promptAbNativeJson('{broken')).toThrow()
  })
})
