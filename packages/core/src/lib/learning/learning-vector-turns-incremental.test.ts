import { describe,expect,test } from 'bun:test'
import { reconstructVectorTurns,VectorTurnConfig,selectUnseenVectorTurns,extendVectorCoverage,publishedVectorCoverage,vectorCoverageKey,type VectorMessage } from './learning-vector-turns.js'

const message=(id:string,role='user',runId=id,at='2026-10-21T00:00:00Z',sourceVersion='raw'):VectorMessage=>({id,role,authorship:role==='user'?'human':'agent',correlation:{runId},logicalKey:id,conversationId:'conversation',text:`text ${id}`,occurredAt:at,sourceOrder:0,sourceVersion})
const exchange=(id:string,at:string)=>[message(id,'user',id,at),message(`${id}-reply`,'assistant',id,at)]
const keyed=(messages:VectorMessage[])=>new Map(messages.map(m=>[m.id,m]))
const covering=(messages:VectorMessage[])=>new Set(messages.map(vectorCoverageKey))

describe('incremental live grading selects only turns the published estimate has not seen',()=>{
  const early=exchange('early','2026-10-21T00:01:00Z'),middle=exchange('middle','2026-10-21T00:02:00Z'),late=exchange('late','2026-10-21T00:03:00Z')
  const all=[...early,...middle,...late]
  const turns=reconstructVectorTurns(all)
  const matching=new Set(['early','middle','late'])

  test('nothing published yet grades every matching turn, oldest first',()=>{
    expect(selectUnseenVectorTurns(turns,matching,new Set(),keyed(all)).map(t=>t.id)).toEqual(['early','middle','late'])
  })
  test('a fully covered history makes no model call',()=>{
    expect(selectUnseenVectorTurns(turns,matching,covering(all),keyed(all))).toEqual([])
  })
  test('one new turn after a covered history selects only that turn',()=>{
    expect(selectUnseenVectorTurns(turns,matching,covering([...early,...middle]),keyed(all)).map(t=>t.id)).toEqual(['late'])
  })
  test('a reply that arrived after its question was graded reselects the whole turn',()=>{
    expect(selectUnseenVectorTurns(turns,matching,covering([...early,...middle,late[0]!]),keyed(all)).map(t=>t.id)).toEqual(['late'])
  })
  test('an edited message is a new source version and is graded again',()=>{
    const edited=[...early,message('middle','user','middle','2026-10-21T00:02:00Z','raw-2'),middle[1]!,...late]
    expect(selectUnseenVectorTurns(reconstructVectorTurns(edited),matching,covering(all),keyed(edited)).map(t=>t.id)).toEqual(['middle'])
  })
  test('turns with no matching message are never selected, covered or not',()=>{
    expect(selectUnseenVectorTurns(turns,new Set(['late']),new Set(),keyed(all)).map(t=>t.id)).toEqual(['late'])
  })
  test('the cap does not apply: every unseen matching turn is selected',()=>{
    const many=Array.from({length:120},(_,i)=>exchange(`t${String(i).padStart(3,'0')}`,`2026-10-21T01:${String(i%60).padStart(2,'0')}:${String(Math.floor(i/60)).padStart(2,'0')}Z`)).flat()
    const ids=new Set(many.filter(m=>m.role==='user').map(m=>m.id))
    expect(selectUnseenVectorTurns(reconstructVectorTurns(many),ids,new Set(),keyed(many))).toHaveLength(120)
  })
})

describe('coverage is carried forward through the published estimate',()=>{
  const messages=[...exchange('a','2026-10-21T00:01:00Z'),...exchange('b','2026-10-21T00:02:00Z')]
  test('a pass extends prior coverage with every message in every part it graded',()=>{
    const next=extendVectorCoverage(['a@raw','a-reply@raw'],[['b'],['b-reply']],keyed(messages))
    expect(next).toEqual(['a-reply@raw','a@raw','b-reply@raw','b@raw'])
  })
  test('extending coverage refuses a part message missing from the snapshot',()=>{
    expect(()=>extendVectorCoverage([],[['ghost']],keyed(messages))).toThrow('missing')
  })
  test('an incremental estimate reports its recorded coverage',()=>{
    expect(publishedVectorCoverage({covered:['a@raw']},[messages])).toEqual(new Set(['a@raw']))
  })
  test('a legacy estimate covers exactly the evidence its parts were graded on',()=>{
    expect(publishedVectorCoverage(undefined,[messages.slice(0,2),messages.slice(2)])).toEqual(covering(messages))
  })
  test('live configuration is opt-in: experiments keep the full-window behaviour',()=>{
    expect(VectorTurnConfig.parse({}).incremental).toBe(false)
    expect(VectorTurnConfig.parse({purpose:'live',incremental:true}).incremental).toBe(true)
  })
})
