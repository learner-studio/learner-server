import { describe,expect,test } from 'bun:test'
import { remainingVectorBatches, vectorRunMetadata, compareVectorTurnChronology, hasAmbiguousVectorTurnOrder } from './learning-vector-turns.js'
import { reconstructVectorTurns,partitionVectorTurns,assertVectorPromptBudget,selectVectorTurns,VectorTurnConfig,type VectorMessage } from './learning-vector-turns.js'
const message=(id:string,role='user',correlation:Record<string,unknown>={runId:'run'}):VectorMessage=>({id,role,authorship:role==='user'?'human':'agent',correlation,logicalKey:id,conversationId:'conversation',text:`text ${id}`,occurredAt:'2026-09-06T00:00:00Z',sourceOrder:0,sourceVersion:'raw'})
describe('vector turn identity and final input safeguards',()=>{
  test('equal timestamps preserve comparable native turn order before hash IDs',()=>{
    const early=message('z-early','user',{runId:'early',sourceId:'native-file',sourceOrder:14})
    const late=message('a-late','user',{runId:'late',sourceId:'native-file',sourceOrder:44})
    const turns=reconstructVectorTurns([late,message('late-response','assistant',{runId:'late'}),early,message('early-response','assistant',{runId:'early'})])
    expect(turns.map(t=>t.id)).toEqual(['z-early','a-late'])
    expect(turns[0]?.nativeOrder).toEqual({sourceId:'native-file',sourceOrder:14})
    expect(hasAmbiguousVectorTurnOrder(turns[0]!,turns[1]!)).toBe(false)
    expect(selectVectorTurns(turns,new Set(['a-late','z-early']),VectorTurnConfig.parse({selection:'all'})).map(t=>t.id)).toEqual(['z-early','a-late'])
    expect(selectVectorTurns(turns,new Set(['a-late','z-early']),VectorTurnConfig.parse({selection:'latest',latestTurns:1}))[0]?.id).toBe('a-late')
  })
  test('incomparable source orders remain explicitly ambiguous with deterministic display only',()=>{
    const base={id:'a',conversationId:'session',at:'same',messageIds:['a'],linkage:'explicit' as const}
    const a={...base,nativeOrder:{sourceId:'one',sourceOrder:44}}
    const b={...base,id:'b',nativeOrder:{sourceId:'two',sourceOrder:14}}
    expect(hasAmbiguousVectorTurnOrder(a,b)).toBe(true)
    expect(hasAmbiguousVectorTurnOrder(base,a)).toBe(false)
    expect(hasAmbiguousVectorTurnOrder({...base,id:'missing'},a)).toBe(true)
    expect(hasAmbiguousVectorTurnOrder(a,{...a,id:'duplicate-order'})).toBe(true)
    expect(hasAmbiguousVectorTurnOrder(a,{...b,at:'later'})).toBe(false)
    expect([b,a].sort(compareVectorTurnChronology).map(t=>t.id)).toEqual(['a','b'])
  })
  test('turn timestamp belongs to its human anchor; conflicting assistant timestamps remain visible',()=>{
    const user={...message('human'),occurredAt:'2026-09-06T00:01:00Z'}
    const assistant=message('assistant','assistant')
    const [turn]=reconstructVectorTurns([user,assistant])
    expect(turn?.at).toBe(user.occurredAt)
    expect(turn?.chronology).toBe('conflicting')
    expect(turn?.messageIds).toEqual(['assistant','human'])
    expect(turn?.linkage).toBe('explicit')
    expect(assistant.occurredAt).toBe('2026-09-06T00:00:00Z')
  })
  test('top relevant turns deduplicate messages before limiting and restore chronology',()=>{
    const turns=Array.from({length:60},(_,i)=>({id:`t${i}`,conversationId:'c',at:String(i).padStart(3,'0'),messageIds:[`u${i}`,`a${i}`],linkage:'explicit' as const}))
    const scores=new Map(turns.flatMap((t,i)=>t.messageIds.map(id=>[id,60-i] as [string,number])))
    const selected=selectVectorTurns(turns,new Set(scores.keys()),VectorTurnConfig.parse({selection:'relevant',latestTurns:50}),scores)
    expect(selected).toHaveLength(50)
    expect(selected[0]!.id).toBe('t0')
    expect(selected.at(-1)!.id).toBe('t49')
    expect(new Set(selected.flatMap(t=>t.messageIds)).size).toBe(100)
  })
  test('v3 scopes assessments and labels lineage without changing legacy defaults',()=>{
    const legacy=VectorTurnConfig.parse({})
    expect(vectorRunMetadata('run',legacy,'input','prompt').datasetLabel).toBe('dev1')
    const config=VectorTurnConfig.parse({datasetTag:'v3',conceptIds:['new-node'],curriculumRevision:'cs-2026-09-06.2',baseRunId:'13db4b4b-77ef-4ddb-91b7-2e526c0cc450'})
    const meta=vectorRunMetadata('run',config,'input','prompt')
    expect(meta.datasetLabel).toBe('v3')
    expect(meta.assessmentConceptIds).toEqual(['new-node'])
    expect(meta.baseRunId).toBe('13db4b4b-77ef-4ddb-91b7-2e526c0cc450')
    expect(meta.tags).toContain('v3')
    expect(meta.consolidatorConfig.model).toBe('gemini-3.7-flash')
  })
  test('nine-wide continuation respects the ceiling and skips settled identities',()=>{
    const original=Array.from({length:12},(_,i)=>[{conceptId:`c${i}`,part:0}])
    const resumed=remainingVectorBatches(original,new Set(['c0:0']),9)
    expect(resumed.map(batch=>batch.length)).toEqual([9,2])
    expect(resumed.flat().some(item=>item.conceptId==='c0')).toBe(false)
    expect(()=>remainingVectorBatches(original,new Set(),10)).toThrow('Invalid execution concurrency')
  })
  test('six-wide continuation preserves completed work and chronological part barriers',()=>{
    const original=Array.from({length:9},(_,i)=>[{conceptId:`c${i}`,part:0}]).concat([[{conceptId:'c0',part:1}]])
    const resumed=remainingVectorBatches(original,new Set(['c1:0']),6)
    expect(resumed.map(batch=>batch.length)).toEqual([6,2,1])
    expect(resumed.flat().some(item=>item.conceptId==='c1')).toBe(false)
    expect(resumed.at(-1)).toEqual([{conceptId:'c0',part:1}])
    expect(original).toHaveLength(10)
  })
  test('unindexed second human blocks apparently unique canonical pairing',()=>{
    const user=message('human'),assistant=message('assistant','assistant')
    const result=reconstructVectorTurns([user,assistant],[user,message('outside')])
    expect(result).toHaveLength(2)
    expect(result.every(t=>t.linkage==='unpaired')).toBe(true)
  })
  test('mirrored observations do not count as distinct users; all assistant output remains',()=>{
    const user=message('human')
    const result=reconstructVectorTurns([user,message('commentary','assistant'),message('final','assistant')],[user,user])
    expect(result).toHaveLength(1)
    expect(result[0]?.linkage).toBe('explicit')
    expect(result[0]?.messageIds).toHaveLength(3)
  })
  test('explicit parent survives ambiguous run but cannot cross conversations',()=>{
    const user=message('human'),assistant=message('assistant','assistant',{runId:'run',parentLogicalMessageKey:'human'})
    expect(reconstructVectorTurns([user,assistant],[user,message('outside')])).toHaveLength(1)
    expect(reconstructVectorTurns([user,{...assistant,conversationId:'different'}])).toHaveLength(2)
  })
  test('all selection preserves matches and latest selection remains chronological',()=>{
    const a=message('a','user',{runId:'a'}),b={...message('b','user',{runId:'b'}),occurredAt:'2026-09-07T00:00:00Z'}
    const turns=reconstructVectorTurns([a,b,message('a-response','assistant',{runId:'a'}),{...message('b-response','assistant',{runId:'b'}),occurredAt:b.occurredAt}])
    expect(selectVectorTurns(turns,new Set(['a','b']),VectorTurnConfig.parse({selection:'all'}))).toHaveLength(2)
    expect(selectVectorTurns(turns,new Set(['a','b']),VectorTurnConfig.parse({selection:'latest',latestTurns:1}))[0]?.id).toBe('b')
  })
  test('generated CLI input and orphan messages never consume the complete-turn limit',()=>{
    const inputs=[message('human','user',{runId:'human'}),message('commentary','assistant',{runId:'human'}),message('final','assistant',{runId:'human'}),
      {...message('generated','user',{runId:'cli'}),authorship:'unknown'},message('generated-response','assistant',{runId:'cli'}),
      message('orphan-assistant','assistant',{}),message('orphan-user','user',{})]
    const turns=reconstructVectorTurns(inputs)
    const scores=new Map(inputs.map(m=>[m.id,m.id.startsWith('human')?0.7:0.99]))
    const selected=selectVectorTurns(turns,new Set(inputs.map(m=>m.id)),VectorTurnConfig.parse({latestTurns:1}),scores)
    expect(selected).toHaveLength(1)
    expect(selected[0]?.messageIds.sort()).toEqual(['commentary','final','human'])
    expect(turns.filter(t=>t.linkage==='unpaired')).toHaveLength(3)
    expect(inputs).toHaveLength(7)
  })
  test('an explicit missing partner cannot fall back to a different user with the same run',()=>{
    const turns=reconstructVectorTurns([message('human'),message('response','assistant',{runId:'run',parentLogicalMessageKey:'missing'})])
    expect(turns.every(t=>t.linkage==='unpaired')).toBe(true)
    expect(selectVectorTurns(turns,new Set(['response']),VectorTurnConfig.parse({selection:'all'}))).toEqual([])
  })
  test('partition refuses missing sources rather than serializing null',()=>{
    expect(()=>partitionVectorTurns(reconstructVectorTurns([message('a')]),new Map(),400000)).toThrow('source is missing')
  })
  test('actual budget counts full source bytes but excludes prior assessment rationale',()=>{
    const concept={conceptId:'test',title:'Test',description:'description',objectives:[]}
    const source=message('human')
    const base=assertVectorPromptBudget(concept,[source],null,400000)
    const previousSource={...message('previous'),text:'quotation '.repeat(20000)}
    expect(()=>assertVectorPromptBudget(concept,[source,previousSource],null,base+100)).toThrow('Complete consolidation input')
    expect(assertVectorPromptBudget(concept,[source,previousSource],null,400000)).toBeGreaterThan(base)
    const prior={conceptId:'test',nodeVersion:'a'.repeat(64),understandingPercent:5,confidence:'low' as const,
      demonstrated:[{description:'Partial understanding',sourceId:source.id,quote:source.text}],gaps:[],nextCheck:'x'.repeat(600),needsReview:true as const}
    expect(assertVectorPromptBudget(concept,[source],prior,base+10)).toBe(base)
  })
})
